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
  constructor() {
    this.ready = false;
    this.mode = 0;
    this.amount = 1;
    this.swapEyes = false;
  }

  static get supported() { return 'gpu' in navigator; }

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
      this.uu32 = new Uint32Array(this.uarr); // [0] mode, [4] swap
      this.uf32 = new Float32Array(this.uarr); // [1] amount, [2] w, [3] h

      this.ready = true;
      return true;
    } catch (e) {
      console.warn('WebGPU filter init failed:', e);
      return false;
    }
  }

  /** mode: index into the shader's filter switch (0 = none). amount: 0..2. */
  set(mode, amount, swapEyes = false) {
    this.mode = mode | 0;
    this.amount = amount;
    this.swapEyes = Boolean(swapEyes);
  }

  /**
   * Output size for a mode. The stereo interlace consumes a double-wide
   * side-by-side frame and emits a single eye-width image (modes 5, 7), or
   * un-squeezes a half-SBS frame across the full width (modes 6, 8).
   */
  outputSize(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    // Full-SBS stereo modes emit one eye's width; half-SBS modes un-squeeze
    // across the full width, as do all the mono filters.
    const halves = this.mode === 5 || this.mode === 7;
    return halves ? { w: Math.max(1, w >> 1), h } : { w, h };
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

GPUFilter.WGSL = /* wgsl */`
struct Params { mode: u32, amount: f32, w: f32, h: f32, swap: u32 };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> P: Params;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One triangle covering the screen.
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[i], 0.0, 1.0);
}

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  var uv = fragCoord.xy / vec2f(P.w, P.h);
  let a = P.amount;

  // Stereo row interleave (5 = SBS, 6 = half-SBS): even output rows come
  // from the left half of the frame, odd rows from the right half, sampled
  // at the same vertical position so the eyes stay aligned. P.w is the
  // output width, so fragCoord.x/P.w spans exactly one eye either way:
  // mode 5 maps 1:1 (eye-width output), mode 6 stretches the squeezed
  // half-SBS eye back across the full width.
  if (P.mode == 5u || P.mode == 6u) {
    let odd = (u32(fragCoord.y) & 1u) == 1u;
    let swapped = P.swap != 0u;
    var off = 0.0;
    if (odd != swapped) { off = 0.5; }
    let su = fragCoord.x / P.w * 0.5 + off;
    return vec4f(textureSampleBaseClampToEdge(tex, samp, vec2f(su, uv.y)).rgb, 1.0);
  }

  // Anaglyph (7 = SBS, 8 = half-SBS): red channel from the left eye,
  // green+blue from the right, for red/cyan glasses. amount fades colour
  // out to a grey anaglyph, which trades colour fidelity for much less
  // retinal rivalry and ghosting.
  if (P.mode == 7u || P.mode == 8u) {
    let u = fragCoord.x / P.w * 0.5;
    var lu = u;
    var ru = u + 0.5;
    if (P.swap != 0u) { lu = u + 0.5; ru = u; }
    let L = textureSampleBaseClampToEdge(tex, samp, vec2f(lu, uv.y)).rgb;
    let R = textureSampleBaseClampToEdge(tex, samp, vec2f(ru, uv.y)).rgb;
    let mixAmt = clamp(a, 0.0, 1.0);
    let Lc = mix(vec3f(dot(L, LUMA)), L, mixAmt);
    let Rc = mix(vec3f(dot(R, LUMA)), R, mixAmt);
    return vec4f(Lc.r, Rc.g, Rc.b, 1.0);
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
