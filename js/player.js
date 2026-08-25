'use strict';

/**
 * FramePlayer — a frame-exact video player built on WebCodecs.
 *
 * Why not <video>? currentTime seeks land "near" a time, subject to the
 * demuxer's whims, and there is no reliable frame stepping. Here we own the
 * whole pipeline:
 *
 *   sample table (decode order)  →  VideoDecoder  →  frame queue (pts order)
 *                                                    →  canvas
 *
 * Every frame has a µs presentation timestamp taken from the container, and a
 * presentation-order index. Seeking to frame N means: reset the decoder,
 * re-enter the stream at the nearest sync sample at-or-before N, decode
 * forward, and drop every output whose timestamp is below frame N's. The
 * frame shown is exactly frame N — never a neighbour.
 *
 * Playback is paced by a wall clock mapped onto media timestamps, so pacing
 * is as accurate as requestAnimationFrame allows; if rendering falls behind,
 * frames are skipped (and counted) to stay on clock. If the *decoder* falls
 * behind, the clock rebases instead, so no frame is ever skipped for decode
 * reasons.
 */
class FramePlayer {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks; // { onFrame, onPlayState, onEnded, onError, onStats }

    this.decoder = null;
    this.config = null;
    this.samples = [];   // decode order
    this.presOrder = []; // presentation index -> decode index
    this.tsToIndex = new Map(); // µs timestamp -> presentation index

    this.filterFn = null; // (VideoFrame) => drawable | null — GPU filter stage
    this.viewport = null; // {x,y,w,h} normalized tile/crop rect for walls
    this.fitMode = 'fill';   // 'fill': viewport crops the source directly;
                             // 'contain': viewport is a wall-space rect and
                             // the video is aspect-fitted into the wall
    this.wallGrid = null;    // {cols, rows} — wall geometry for 'contain'
    this.queue = [];     // decoded VideoFrames awaiting display (pts order)
    this.waiters = [];
    this.currentFrame = null;
    this.currentIndex = -1;

    this.feedPos = 0;
    this.dropBelowTs = -1;
    this.endFlushed = false;
    this.flushing = false;

    this.playing = false;
    this.loop = false;
    this.rate = 1;
    this.baseTs = 0;
    this.baseWall = 0;
    this.raf = 0;

    this.audio = null;     // optional AudioEngine
    this.audioLive = false;
    this.externalClock = null; // () => mediaTimeUs — slaves playback to it

    this.seeking = false;
    this.pendingSeek = -1;
    this.lastRequestedIndex = -1;
    this.droppedForPacing = 0;

    this.MAX_QUEUE = 16;        // decoded frames held ahead of the playhead
    this.MAX_DECODE_QUEUE = 12; // chunks in flight inside the decoder
  }

  /** Give the player an AudioEngine; its clock masters playback at 1×. */
  attachAudio(engine) { this.audio = engine; }

  get frameCount() { return this.presOrder.length; }
  get ended() {
    return this.endFlushed && this.queue.length === 0;
  }

  async load(config, samples) {
    this.destroy();
    this.samples = samples;

    // Presentation order: B-frames arrive from the demuxer in decode order,
    // so sort indices by composition timestamp to get the true frame list.
    this.presOrder = samples.map((_, i) => i)
      .sort((a, b) => samples[a].ts - samples[b].ts);
    this.tsToIndex = new Map();
    this.presOrder.forEach((decIdx, presIdx) =>
      this.tsToIndex.set(samples[decIdx].ts, presIdx));

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error(`This browser cannot decode "${config.codec}".`);
    }
    this.config = support.config || config;
    this._createDecoder();
    await this.seekToFrame(0);
  }

  _createDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame) => this._onOutput(frame),
      error: (e) => this.cb.onError?.(e),
    });
    this.decoder.addEventListener('dequeue', () => {
      this._fillQueue();
      this._emitStats();
    });
    this.decoder.configure(this.config);
  }

  _onOutput(frame) {
    // Outputs older than the seek target are decode fodder, not display frames.
    if (frame.timestamp < this.dropBelowTs) {
      frame.close();
      return;
    }
    this.queue.push(frame);
    this._wake();
    this._emitStats();
  }

  _wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  /** Keep the decoder fed, with backpressure on both queues. */
  _fillQueue() {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    while (
      this.feedPos < this.samples.length &&
      this.queue.length < this.MAX_QUEUE &&
      this.decoder.decodeQueueSize < this.MAX_DECODE_QUEUE
    ) {
      const s = this.samples[this.feedPos++];
      this.decoder.decode(new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp: s.ts,
        duration: s.duration,
        data: s.data,
      }));
    }
    if (this.feedPos >= this.samples.length && !this.endFlushed && !this.flushing) {
      this.flushing = true;
      this.decoder.flush()
        .then(() => { this.endFlushed = true; this._wake(); })
        .catch(() => {}) // aborted by reset() during a seek — expected
        .finally(() => { this.flushing = false; });
    }
  }

  /** Next undisplayed frame in presentation order; null at end of stream. */
  async _nextFrame() {
    for (;;) {
      if (this.queue.length) return this.queue.shift();
      if (this.ended || !this.decoder || this.decoder.state === 'closed') return null;
      this._fillQueue();
      await new Promise((r) => this.waiters.push(r));
    }
  }

  /**
   * Draw a frame honoring the viewport: tiled wall nodes decode the full
   * stream (bitstreams are not spatially separable) but blit only their
   * slice — the crop is free, the GPU samples the sub-rect at composite.
   *
   * 'fill' mode: the viewport is a source crop; the slice fills the canvas.
   *
   * 'contain' mode: the viewport is this tile's rect on the wall, and the
   * video is aspect-fitted into the wall's combined surface — one global
   * letterbox/pillarbox decision, never distortion. Implementation: model a
   * virtual wall canvas at the resolution where the video renders 1:1,
   * then draw the whole frame at its wall position translated into tile
   * coordinates; canvas clipping discards the rest and the cleared
   * background is the (black) bars. Every node computes the same fit, so
   * bars align exactly across the wall.
   */
  _draw(frame) {
    // The filter stage may hand back a drawable of different dimensions —
    // a stereo mode emits one eye, halving the width of a side-by-side
    // source or the height of a top/bottom one — so all geometry below
    // follows what is actually being drawn, not the decoded frame.
    const src = this.filterFn ? (this.filterFn(frame) || frame) : frame;
    const W = src.displayWidth || src.width, H = src.displayHeight || src.height;
    const v = this.viewport;

    if (v && this.fitMode === 'contain') {
      const grid = this.wallGrid || { cols: 1, rows: 1 };
      // Monitors are assumed uniform; measure this node's display aspect.
      const monA = (window.screen && screen.width && screen.height)
        ? screen.width / screen.height : 16 / 9;
      const wallA = monA * grid.cols / grid.rows;
      const vidA = W / H;
      // Video footprint in wall-normalized space (centered, aspect-fitted).
      let vr;
      if (vidA > wallA) {
        const h = wallA / vidA;
        vr = { x: 0, y: (1 - h) / 2, w: 1, h };
      } else {
        const w = vidA / wallA;
        vr = { x: (1 - w) / 2, y: 0, w, h: 1 };
      }
      // Wall pixel space where the video is native-resolution.
      const wallPxW = W / vr.w, wallPxH = H / vr.h;
      const cw = Math.max(1, Math.round(wallPxW * v.w));
      const ch = Math.max(1, Math.round(wallPxH * v.h));
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, cw, ch);
      this.ctx.drawImage(src, 0, 0, W, H,
        (vr.x - v.x) * wallPxW, (vr.y - v.y) * wallPxH, W, H);
      return;
    }

    const sx = v ? v.x * W : 0, sy = v ? v.y * H : 0;
    const sw = v ? v.w * W : W, sh = v ? v.h * H : H;
    const cw = Math.max(1, Math.round(sw)), ch = Math.max(1, Math.round(sh));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  /** Set (or clear) the tile rect and fit mode; re-renders the held frame. */
  setViewport(v, { fit = 'fill', wallGrid = null } = {}) {
    this.viewport = v;
    this.fitMode = fit;
    this.wallGrid = wallGrid;
    if (this.currentFrame) this._draw(this.currentFrame);
  }

  _displayFrame(frame) {
    if (this.currentFrame) this.currentFrame.close();
    this.currentFrame = frame;
    this._draw(frame);
    const idx = this.tsToIndex.get(frame.timestamp);
    if (idx !== undefined) this.currentIndex = idx;
    this.cb.onFrame?.(this.currentIndex, frame.timestamp);
    this._fillQueue();
  }

  /**
   * Frame-exact seek. Concurrent calls coalesce: while one seek is decoding,
   * newer targets replace each other and only the last one runs after it.
   */
  async seekToFrame(index) {
    if (!this.frameCount) return;
    index = Math.max(0, Math.min(this.frameCount - 1, Math.round(index)));
    this.lastRequestedIndex = index;
    if (this.seeking) { this.pendingSeek = index; return; }
    this.seeking = true;
    try {
      let target = index;
      do {
        this.pendingSeek = -1;
        await this._doSeek(target);
        target = this.pendingSeek;
      } while (target >= 0);
    } finally {
      this.seeking = false;
    }
  }

  async _doSeek(index) {
    const decIdx = this.presOrder[index];
    const targetTs = this.samples[decIdx].ts;

    // Walk back in decode order to the sync sample this frame depends on.
    let k = decIdx;
    while (k > 0 && !this.samples[k].isKey) k--;

    this.decoder.reset();
    this.decoder.configure(this.config);
    for (const f of this.queue) f.close();
    this.queue = [];
    this.endFlushed = false;
    this.feedPos = k;
    this.dropBelowTs = targetTs;
    this._wake();

    const frame = await this._nextFrame();
    if (frame) this._displayFrame(frame);
    if (this.playing) { this._rebase(); this._syncAudio(); }
  }

  /**
   * (Re)start audio from the displayed frame's timestamp. Audio plays only
   * at 1× — at other rates (and when there is no audio at the playhead) the
   * wall clock paces the video instead.
   */
  _syncAudio() {
    if (this.externalClock) {
      if (this.audio) this.audio.stop();
      this.audioLive = false;
      return;
    }
    if (this.audio) this.audio.stop();
    this.audioLive = Boolean(
      this.audio && this.rate === 1 && this.currentFrame &&
      this.audio.start(this.currentFrame.timestamp)
    );
  }

  play() {
    if (this.playing || !this.frameCount) return;
    const start = () => {
      this.playing = true;
      this._rebase();
      this._syncAudio();
      this.cb.onPlayState?.(true);
      this.raf = requestAnimationFrame(() => this._tick());
    };
    // Play at the last frame restarts from the top.
    if (this.currentIndex >= this.frameCount - 1 && this.ended) {
      this.seekToFrame(0).then(start);
    } else {
      start();
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.audio) this.audio.stop();
    this.audioLive = false;
    this.cb.onPlayState?.(false);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  setRate(rate) {
    this.rate = rate;
    if (this.playing) { this._rebase(); this._syncAudio(); }
  }

  _rebase() {
    this.baseTs = this.currentFrame ? this.currentFrame.timestamp : 0;
    this.baseWall = performance.now();
  }

  _tick() {
    if (!this.playing) return;
    if (this.seeking) {
      // A seek owns the queue right now; just keep the loop alive.
      this.raf = requestAnimationFrame(() => this._tick());
      return;
    }
    // Clock hierarchy: external (sync follower) > audio hardware > wall.
    const mediaTime = this.externalClock ? this.externalClock()
      : this.audioLive ? this.audio.nowUs()
      : this.baseTs + (performance.now() - this.baseWall) * 1000 * this.rate;

    // Following an external clock, the target can jump anywhere (master
    // seeked, we joined late, clock estimate refined). Consume the queue for
    // small forward motion; hard-seek when the target moves backward past
    // jitter tolerance or unreachably far ahead.
    if (this.externalClock && this.currentFrame && !this.seeking) {
      const cur = this.currentFrame.timestamp;
      if (mediaTime < cur - 20000 || mediaTime - cur > 1e6) {
        this.seekToFrame(this._indexForTime(mediaTime));
        this.raf = requestAnimationFrame(() => this._tick());
        return;
      }
    }

    let next = null;
    while (this.queue.length && this.queue[0].timestamp <= mediaTime) {
      if (next) { next.close(); this.droppedForPacing++; }
      next = this.queue.shift();
    }

    if (next) {
      this._displayFrame(next);
    } else if (this.queue.length === 0) {
      if (this.ended) {
        if (this.externalClock) {
          // Hold the last frame; the master decides what happens next.
          this.raf = requestAnimationFrame(() => this._tick());
          return;
        }
        if (this.loop) {
          // Wrap around: a playing seek to frame 0 rebases the clock and
          // restarts audio there; `seeking` keeps the loop alive meanwhile.
          this.seekToFrame(0);
          this.raf = requestAnimationFrame(() => this._tick());
          return;
        }
        this.playing = false;
        if (this.audio) this.audio.stop();
        this.audioLive = false;
        this.cb.onPlayState?.(false);
        this.cb.onEnded?.();
        return;
      }
      // Decoder starvation. With the wall clock, rebase so no frame is
      // skipped once decoding catches up. With live audio or an external
      // clock, never touch the clock — continuity/sync wins and video
      // catches up instead.
      if (!this.audioLive && !this.externalClock) this._rebase();
      this._fillQueue();
    }
    this.raf = requestAnimationFrame(() => this._tick());
  }

  /**
   * Seek relative to where the playhead is *heading*: during an in-flight
   * seek, base on the last requested index so rapid steps accumulate
   * (← ← ← while decoding means three frames back, not one).
   */
  seekRelative(delta) {
    if (!this.frameCount) return Promise.resolve();
    const base = this.seeking ? this.lastRequestedIndex : this.currentIndex;
    return this.seekToFrame(base + delta);
  }

  async stepForward() {
    if (!this.frameCount) return;
    this.pause();
    if (this.seeking) return this.seekRelative(1);
    const frame = await this._nextFrame();
    if (frame) this._displayFrame(frame);
  }

  async stepBack() {
    if (!this.frameCount) return;
    this.pause();
    await this.seekRelative(-1);
  }

  /** Presentation index of the last frame at or before a media time (µs). */
  _indexForTime(us) {
    const s = this.samples, p = this.presOrder;
    let lo = 0, hi = p.length - 1;
    if (us <= s[p[0]].ts) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[p[mid]].ts <= us) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Slave playback to an external media clock (µs). Replaces the audio/wall
   * clock; audio is silenced (multiple machines cannot share a DAC clock).
   * Call again freely to swap in a refreshed mapping.
   */
  followExternal(clockFn) {
    this.externalClock = clockFn;
    if (this.audio) this.audio.stop();
    this.audioLive = false;
    if (!this.playing) {
      this.playing = true;
      this.cb.onPlayState?.(true);
      this.raf = requestAnimationFrame(() => this._tick());
    }
    // Hidden tabs get no requestAnimationFrame, which would freeze the
    // display entirely. Seeking works without rAF, so a low-rate timer
    // (browser-throttled to ~1 Hz when hidden) keeps an occluded follower
    // coarsely on the clock; the moment it is visible again, _tick's
    // resync logic makes it exact.
    if (!this._bgTimer) {
      this._bgTimer = setInterval(() => {
        if (!this.externalClock || !document.hidden || this.seeking || !this.frameCount) return;
        const idx = this._indexForTime(this.externalClock());
        if (Math.abs(idx - this.currentIndex) > 1) this.seekToFrame(idx);
      }, 500);
    }
  }

  stopExternal() {
    if (!this.externalClock) return;
    this.externalClock = null;
    clearInterval(this._bgTimer);
    this._bgTimer = null;
    this.pause();
  }

  /** The playback clock's current media time (µs); frame ts when paused. */
  clockNowUs() {
    const held = this.currentFrame ? this.currentFrame.timestamp : 0;
    if (!this.playing) return held;
    if (this.externalClock) return this.externalClock();
    if (this.audioLive) return this.audio.nowUs();
    return this.baseTs + (performance.now() - this.baseWall) * 1000 * this.rate;
  }

  _emitStats() {
    this.cb.onStats?.({
      decodeQueue: this.decoder ? this.decoder.decodeQueueSize : 0,
      buffered: this.queue.length,
      dropped: this.droppedForPacing,
      clock: this.externalClock ? 'sync' : this.audioLive ? 'audio' : 'wall',
    });
  }

  /** Redraw the held frame (e.g. nothing decodes while paused). */
  redraw() {
    if (this.currentFrame) this._draw(this.currentFrame);
  }

  destroy() {
    this.externalClock = null;
    clearInterval(this._bgTimer);
    this._bgTimer = null;
    this.pause();
    if (this.audio) this.audio.stop();
    this.audioLive = false;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.currentFrame) { this.currentFrame.close(); this.currentFrame = null; }
    this.samples = [];
    this.presOrder = [];
    this.tsToIndex = new Map();
    this.currentIndex = -1;
    this.feedPos = 0;
    this.endFlushed = false;
    this.droppedForPacing = 0;
    this._wake();
  }
}
