'use strict';

/**
 * GPUFilter — WebGPU per-frame video filtering.
 *
 * Zero-copy path: each decoded VideoFrame is imported as a GPUExternalTexture
 * (no readback, no upload), filtered by a WGSL fragment shader into an
 * OffscreenCanvas, and that canvas is what FramePlayer blits — so all crop /
 * tile / contain geometry downstream is untouched. With filter "none" the
 * stage is bypassed entirely (apply() returns null → draw the frame itself).
 *
 * amount semantics: 1.0 is the filter's natural strength (mix filters fully
 * applied, gain filters neutral-ish); 0..2 is the UI range.
 */
class GPUFilter {
  /**
   * Inert until init() succeeds: `ready` false means apply() bypasses, so a
   * construct-then-fail sequence degrades to unfiltered playback rather than
   * to an error path the player has to handle.
   */
  constructor() {
    this.ready = false;
    this.mode = 0;
    this.amount = 1;
    this.swapEyes = false;
    this.layout = 0;
  }

  /** Cheap pre-check so the UI can disable itself without building a device. */
  static get supported() { return 'gpu' in navigator; }

  /**
   * Build the one pipeline every filter shares — a single WGSL module with the
   * mode switch inside it, so changing filters is a uniform write rather than
   * a pipeline swap. Returns false instead of throwing on any failure (no
   * adapter, no device, shader rejected), because "this machine has no usable
   * WebGPU" is an expected state on a wall of mixed hardware.
   */
  async init() {
    if (!GPUFilter.supported) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      this.device = await adapter.requestDevice();
      this.device.lost.then(() => { this.ready = false; });

      this.canvas = new OffscreenCanvas(16, 16);
      this.ctx = this.canvas.getContext('webgpu');
      const format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({ device: this.device, format, alphaMode: 'opaque' });

      const shader = this.device.createShaderModule({ code: GPUFilter.WGSL });
      this.pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.bgl = this.pipeline.getBindGroupLayout(0);
      this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.ubuf = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uarr = new ArrayBuffer(32);
      this.uu32 = new Uint32Array(this.uarr); // [0] mode, [4] swap, [5] layout
      this.uf32 = new Float32Array(this.uarr); // [1] amount, [2] w, [3] h

      this.ready = true;
      return true;
    } catch (e) {
      console.warn('WebGPU filter init failed:', e);
      return false;
    }
  }

  /**
   * mode: index into the shader's filter switch (0 = none). amount: 0..2.
   * layout: how a stereo source packs the eye pair (GPUFilter.LAYOUT_*).
   */
  set(mode, amount, swapEyes = false, layout = 0) {
    this.mode = mode | 0;
    this.amount = amount;
    this.swapEyes = Boolean(swapEyes);
    this.layout = layout | 0;
  }

  /** True while the mode reads a packed stereo pair (modes 5..9). */
  get isStereo() { return this.mode >= 5 && this.mode <= 9; }

  /**
   * Output size for the current mode. A stereo mode emits ONE eye, so it
   * drops the packing axis back to native: full side-by-side halves the
   * width, top/bottom halves the height, and half side-by-side keeps the
   * frame size (each squeezed eye un-squeezes across it). Mono filters and
   * a bypassed stage pass the frame size through.
   */
  outputSize(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (!this.isStereo) return { w, h };
    if (this.layout === GPUFilter.LAYOUT_SBS) return { w: Math.max(1, w >> 1), h };
    if (this.layout === GPUFilter.LAYOUT_TB) return { w, h: Math.max(1, h >> 1) };
    return { w, h }; // LAYOUT_HALF_SBS: un-squeeze in place
  }

  /** Filter one frame; returns the drawable canvas, or null to bypass. */
  apply(frame) {
    if (!this.ready || this.mode === 0) return null;
    const { w, h } = this.outputSize(frame);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    try {
      this.uu32[0] = this.mode;
      this.uu32[4] = this.swapEyes ? 1 : 0;
      this.uu32[5] = this.layout; // shader field is 'pack' — 'layout' is reserved in WGSL
      this.uf32[1] = this.amount;
      this.uf32[2] = w;   // output dimensions: the shader works in output space
      this.uf32[3] = h;
      this.device.queue.writeBuffer(this.ubuf, 0, this.uarr);

      const ext = this.device.importExternalTexture({ source: frame });
      const bindGroup = this.device.createBindGroup({
        layout: this.bgl,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: ext },
          { binding: 2, resource: { buffer: this.ubuf } },
        ],
      });
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      return this.canvas;
    } catch (e) {
      console.warn('WebGPU filter apply failed — bypassing:', e);
      this.ready = false;
      return null;
    }
  }
}

// Stereo source packings, the shader's P.pack ('layout' is a reserved WGSL
// keyword). SBS/HALF_SBS split across x, TB splits across y; the shader only
// needs the axis, outputSize() handles the squeeze.
GPUFilter.LAYOUT_SBS = 0;       // 2W x H: each half is the eye's native width
GPUFilter.LAYOUT_HALF_SBS = 1;  // W x H: each half squeezed 2x horizontally
GPUFilter.LAYOUT_TB = 2;        // W x 2H: eyes stacked, top eye first

GPUFilter.WGSL = /* wgsl */`
struct Params { mode: u32, amount: f32, w: f32, h: f32, swap: u32, pack: u32 };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> P: Params;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One triangle covering the screen.
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

// Source UV for one eye of a packed stereo pair. uv is in output space
// (0..1 spanning exactly one eye either way), so the same half-range map
// serves every layout: full side-by-side lands 1:1 because the output is
// already one eye wide, half side-by-side stretches the squeezed eye back
// across the full width, and top/bottom does the same down the y axis.
fn eyeUV(uv: vec2f, rightEye: bool) -> vec2f {
  var second = rightEye;
  if (P.swap != 0u) { second = !second; }
  var off = 0.0;
  if (second) { off = 0.5; }
  if (P.pack == 2u) { return vec2f(uv.x, uv.y * 0.5 + off); }
  return vec2f(uv.x * 0.5 + off, uv.y);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  var uv = fragCoord.xy / vec2f(P.w, P.h);
  let a = P.amount;

  // Row interleave for passive 3D displays: even output rows come from the
  // left eye, odd rows from the right, both sampled at the same position in
  // their own half so the eyes stay vertically aligned.
  if (P.mode == 5u) {
    let odd = (u32(fragCoord.y) & 1u) == 1u;
    return vec4f(textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, odd)).rgb, 1.0);
  }

  // Anaglyph for red/cyan glasses (6 = greyscale, 7 = Dubois).
  if (P.mode == 6u || P.mode == 7u) {
    let L = textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, false)).rgb;
    let R = textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, true)).rgb;

    if (P.mode == 6u) {
      // Classic monochrome anaglyph: each eye's luma into its own channel.
      // No colour, but the least retinal rivalry and ghosting of any method.
      let yl = dot(L, LUMA);
      let yr = dot(R, LUMA);
      return vec4f(yl, yr, yr, 1.0);
    }

    // Dubois: a least-squares projection of the stereo pair onto what
    // red/cyan glasses can actually transmit (published sRGB coefficients),
    // summing a per-eye 3x3 matrix. Keeps far more usable colour than naive
    // channel separation at much lower rivalry; extremes clamp.
    let outR = dot(vec3f( 0.4155,  0.4710,  0.1670), L)
             + dot(vec3f(-0.0109, -0.0364, -0.0060), R);
    let outG = dot(vec3f(-0.0458, -0.0484, -0.0257), L)
             + dot(vec3f( 0.3756,  0.7333,  0.0111), R);
    let outB = dot(vec3f(-0.0546, -0.0615, -0.0128), L)
             + dot(vec3f(-0.0651, -0.1287,  1.2971), R);
    return vec4f(clamp(vec3f(outR, outG, outB), vec3f(0.0), vec3f(1.0)), 1.0);
  }

  // One eye alone (8 = left, 9 = right): plain 2D, and the quickest way to
  // confirm the layout and eye order are right before putting glasses on.
  if (P.mode == 8u || P.mode == 9u) {
    return vec4f(textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, P.mode == 9u)).rgb, 1.0);
  }

  // Geometry filters warp the sample coordinate before any color work.
  if (P.mode == 4u) { // swirl: rotate around the centre, falling off with radius
    let aspect = P.w / P.h;
    var d = (uv - vec2f(0.5)) * vec2f(aspect, 1.0); // circular, not elliptical
    let r = length(d);
    let radius = 0.5;
    if (r < radius) {
      // Smooth falloff so the swirl blends into the untouched surround.
      let t = 1.0 - r / radius;
      let ang = a * 3.14159265 * t * t;
      let cA = cos(ang); let sA = sin(ang);
      d = vec2f(d.x * cA - d.y * sA, d.x * sA + d.y * cA);
      uv = d / vec2f(aspect, 1.0) + vec2f(0.5);
    }
  }

  var c = textureSampleBaseClampToEdge(tex, samp, uv).rgb;
  switch P.mode {
    case 1u: { // grayscale
      c = mix(c, vec3f(dot(c, LUMA)), clamp(a, 0.0, 1.0));
    }
    case 2u: { // sepia
      let s = vec3f(
        dot(c, vec3f(0.393, 0.769, 0.189)),
        dot(c, vec3f(0.349, 0.686, 0.168)),
        dot(c, vec3f(0.272, 0.534, 0.131)));
      c = mix(c, s, clamp(a, 0.0, 1.0));
    }
    case 3u: { // invert
      c = mix(c, vec3f(1.0) - c, clamp(a, 0.0, 1.0));
    }
    // case 4u (swirl) and the stereo modes are handled above.
    default: {}
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
