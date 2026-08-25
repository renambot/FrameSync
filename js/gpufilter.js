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
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uarr = new ArrayBuffer(16);
      this.uu32 = new Uint32Array(this.uarr, 0, 1);
      this.uf32 = new Float32Array(this.uarr, 4, 3);

      this.ready = true;
      return true;
    } catch (e) {
      console.warn('WebGPU filter init failed:', e);
      return false;
    }
  }

  /** mode: index into the shader's filter switch (0 = none). amount: 0..2. */
  set(mode, amount) {
    this.mode = mode | 0;
    this.amount = amount;
  }

  /** Filter one frame; returns the drawable canvas, or null to bypass. */
  apply(frame) {
    if (!this.ready || this.mode === 0) return null;
    const w = frame.displayWidth, h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    try {
      this.uu32[0] = this.mode;
      this.uf32[0] = this.amount;
      this.uf32[1] = w;
      this.uf32[2] = h;
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
struct Params { mode: u32, amount: f32, w: f32, h: f32 };
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
  let uv = fragCoord.xy / vec2f(P.w, P.h);
  var c = textureSampleBaseClampToEdge(tex, samp, uv).rgb;
  let a = P.amount;
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
    case 4u: { // brightness (1.0 = neutral)
      c = c * a;
    }
    case 5u: { // contrast (1.0 = neutral)
      c = (c - 0.5) * a + 0.5;
    }
    case 6u: { // saturation (1.0 = neutral)
      c = mix(vec3f(dot(c, LUMA)), c, a);
    }
    case 7u: { // hue rotate (amount 0..2 -> 0..360 degrees)
      let ang = a * 3.14159265;
      let cA = cos(ang); let sA = sin(ang);
      let r0 = vec3f(0.213 + cA * 0.787 - sA * 0.213, 0.715 - cA * 0.715 - sA * 0.715, 0.072 - cA * 0.072 + sA * 0.928);
      let r1 = vec3f(0.213 - cA * 0.213 + sA * 0.143, 0.715 + cA * 0.285 + sA * 0.140, 0.072 - cA * 0.072 - sA * 0.283);
      let r2 = vec3f(0.213 - cA * 0.213 - sA * 0.787, 0.715 - cA * 0.715 + sA * 0.715, 0.072 + cA * 0.928 + sA * 0.072);
      c = vec3f(dot(r0, c), dot(r1, c), dot(r2, c));
    }
    case 8u: { // sharpen (unsharp mask, amount = strength)
      let px = vec2f(1.0, 1.0) / vec2f(P.w, P.h);
      let n = textureSampleBaseClampToEdge(tex, samp, uv + vec2f(0.0, -px.y)).rgb
            + textureSampleBaseClampToEdge(tex, samp, uv + vec2f(0.0, px.y)).rgb
            + textureSampleBaseClampToEdge(tex, samp, uv + vec2f(-px.x, 0.0)).rgb
            + textureSampleBaseClampToEdge(tex, samp, uv + vec2f(px.x, 0.0)).rgb;
      c = c * (1.0 + 4.0 * a) - n * a;
    }
    default: {}
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
