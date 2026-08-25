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
 * Filters are fixed-strength — there is no blend factor, so every colour
 * filter is its own target value and the shader carries no mix() at all.
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
    this.swapEyes = false;
    this.convergence = 0;
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
      this.uu32 = new Uint32Array(this.uarr); // [0] mode, [3] swap, [4] layout
      this.uf32 = new Float32Array(this.uarr); // [1] w, [2] h, [5] convergence

      this.ready = true;
      return true;
    } catch (e) {
      console.warn('WebGPU filter init failed:', e);
      return false;
    }
  }

  /**
   * mode: index into the shader's filter switch (0 = none).
   * layout: how a stereo source packs the eye pair (GPUFilter.LAYOUT_*).
   * convergence: horizontal image translation between the eyes, in output
   * pixels of total separation (each eye moves half of it, in opposite
   * directions, so the pair stays centred). Positive pushes the convergence
   * plane one way, negative the other; 0 leaves the source untouched.
   */
  set(mode, swapEyes = false, layout = 0, convergence = 0) {
    this.mode = mode | 0;
    this.swapEyes = Boolean(swapEyes);
    this.layout = layout | 0;
    this.convergence = convergence || 0;
  }

  /** True while the mode reads a packed stereo pair (modes 5..12). */
  get isStereo() { return this.mode >= 5 && this.mode <= 12; }

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
    const eye = this.layout === GPUFilter.LAYOUT_SBS
      ? { w: Math.max(1, w >> 1), h }
      : this.layout === GPUFilter.LAYOUT_TB
        ? { w, h: Math.max(1, h >> 1) }
        : { w, h };                    // LAYOUT_HALF_SBS: un-squeeze in place
    // Both side-by-side views emit BOTH eyes; they differ only in how much
    // room they give them. The full one is two eye-widths across, so nothing
    // is resampled — a top/bottom source becomes double-wide, and a full-SBS
    // source comes back to the frame's own size (a re-pack of itself). The
    // squished one keeps a single eye's width and fits the pair inside it, so
    // each eye is squeezed 2x — the frame-packed shape a 3D TV expects in.
    return this.mode === GPUFilter.MODE_SBS ? { w: eye.w * 2, h: eye.h } : eye;
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
      this.uf32[1] = w;   // output dimensions: the shader works in output space
      this.uf32[2] = h;
      this.uu32[3] = this.swapEyes ? 1 : 0;
      this.uu32[4] = this.layout; // shader field is 'pack' — 'layout' is reserved in WGSL
      this.uf32[5] = this.convergence;
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

// The one mode whose output holds both eyes rather than one, which outputSize
// has to know about.
GPUFilter.MODE_SBS = 11;         // full: two eye-widths across
GPUFilter.MODE_SBS_SQUISHED = 12; // squished: one eye-width, pair squeezed in

GPUFilter.WGSL = /* wgsl */`
struct Params { mode: u32, w: f32, h: f32, swap: u32, pack: u32, conv: f32 };
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
//
// Convergence (horizontal image translation) is applied here too: the eyes
// move half the requested separation each, in opposite directions, so the
// pair stays centred on screen. The shift is stated in OUTPUT pixels and
// converted into the source's u axis, where one eye's share is half the axis
// when the pair is packed across x and all of it when packed across y.
fn eyeUV(uv: vec2f, rightEye: bool, eyeOutW: f32) -> vec2f {
  var second = rightEye;
  if (P.swap != 0u) { second = !second; }
  let tb = P.pack == 2u;
  let span = select(0.5, 1.0, tb);      // this eye's share of the source u axis
  var dir = 1.0;
  if (second) { dir = -1.0; }
  let du = dir * P.conv * span / (2.0 * eyeOutW);

  var uOff = 0.0;
  var vOff = 0.0;
  if (second) {
    if (tb) { vOff = 0.5; } else { uOff = 0.5; }
  }

  // Keep the sample inside this eye's own share of the frame. Without this a
  // shift would walk straight into the neighbouring eye's pixels — a hard
  // seam of the wrong image rather than the edge smear a clamp gives.
  //
  // The inset is 1.5 source texels, not half of one: a decoded frame is 4:2:0,
  // so the chroma plane is half resolution and the last luma column of one eye
  // shares its chroma sample with the first column of the next. Half a texel
  // clears linear filtering but not that, and the seam then bleeds the other
  // eye's colour into a fully clamped edge.
  //
  // Derived from eyeOutW rather than P.w because the side-by-side view fills
  // the output with two eyes, so P.w is not one eye's width there.
  let srcW = select(eyeOutW, eyeOutW * 2.0, P.pack == 0u);
  let inset = 1.5 / srcW;
  let u = clamp(uv.x * span + uOff + du, uOff + inset, uOff + span - inset);
  let v = select(uv.y, uv.y * 0.5 + vOff, tb);
  return vec2f(u, v);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  var uv = fragCoord.xy / vec2f(P.w, P.h);

  // Row interleave for passive 3D displays: even output rows come from the
  // left eye, odd rows from the right, both sampled at the same position in
  // their own half so the eyes stay vertically aligned.
  if (P.mode == 5u) {
    let odd = (u32(fragCoord.y) & 1u) == 1u;
    return vec4f(textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, odd, P.w)).rgb, 1.0);
  }

  // Anaglyph for red/cyan glasses (6 = greyscale, 7 = Dubois).
  if (P.mode == 6u || P.mode == 7u) {
    let L = textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, false, P.w)).rgb;
    let R = textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, true, P.w)).rgb;

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
    return vec4f(textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, P.mode == 9u, P.w)).rgb, 1.0);
  }

  // Difference (10): |L - R| per channel, amplified. Black wherever the eyes
  // agree — that is the convergence plane — so the bright fringes ARE the
  // parallax and their width is the separation. It reads alignment faults
  // straight off the screen: a vertical offset lights up horizontal edges,
  // which a correctly aligned pair leaves dark, and a wrong layout lights up
  // the whole frame. Amplified because real disparities are a few percent and
  // the raw difference is almost black; the gain is fixed, like every other
  // filter here. Symmetric in the eyes, so swapping them changes nothing.
  if (P.mode == 10u) {
    let L = textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, false, P.w)).rgb;
    let R = textureSampleBaseClampToEdge(tex, samp, eyeUV(uv, true, P.w)).rgb;
    return vec4f(clamp(abs(L - R) * 2.0, vec3f(0.0), vec3f(1.0)), 1.0);
  }

  // Side by side (11 full, 12 squished): the pair repacked across x whatever
  // the source layout was — for a display or projector that wants SBS in, or
  // to free-view the depth cross-eyed without glasses. Both share this code
  // exactly; they differ only in the output width outputSize() asks for, and
  // the maths below is written in terms of that width rather than assuming
  // it. These are the two modes that emit both eyes, so an eye spans half
  // the output rather than all of it — hence P.w * 0.5.
  if (P.mode == 11u || P.mode == 12u) {
    let right = uv.x >= 0.5;
    let e = vec2f(fract(uv.x * 2.0), uv.y);
    return vec4f(textureSampleBaseClampToEdge(tex, samp, eyeUV(e, right, P.w * 0.5)).rgb, 1.0);
  }

  // Geometry filters warp the sample coordinate before any color work.
  if (P.mode == 4u) { // swirl: rotate around the centre, falling off with radius
    let aspect = P.w / P.h;
    var d = (uv - vec2f(0.5)) * vec2f(aspect, 1.0); // circular, not elliptical
    let r = length(d);
    let radius = 0.5;
    if (r < radius) {
      // Smooth falloff so the swirl blends into the untouched surround: a
      // full rotation at the very centre, easing to none at the radius.
      let t = 1.0 - r / radius;
      let ang = 6.2831853 * t * t;
      let cA = cos(ang); let sA = sin(ang);
      d = vec2f(d.x * cA - d.y * sA, d.x * sA + d.y * cA);
      uv = d / vec2f(aspect, 1.0) + vec2f(0.5);
    }
  }

  var c = textureSampleBaseClampToEdge(tex, samp, uv).rgb;
  switch P.mode {
    case 1u: { // grayscale
      c = vec3f(dot(c, LUMA));
    }
    case 2u: { // sepia
      c = vec3f(
        dot(c, vec3f(0.393, 0.769, 0.189)),
        dot(c, vec3f(0.349, 0.686, 0.168)),
        dot(c, vec3f(0.272, 0.534, 0.131)));
    }
    case 3u: { // invert
      c = vec3f(1.0) - c;
    }
    // case 4u (swirl) and the stereo modes are handled above.
    default: {}
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
