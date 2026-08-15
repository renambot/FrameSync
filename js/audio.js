'use strict';

/**
 * AudioEngine — WebCodecs AudioDecoder + Web Audio playback.
 *
 * Design: during playback the AUDIO HARDWARE CLOCK is the master. Video
 * paces itself against nowUs(), which is derived from AudioContext.currentTime.
 * That is the only way to keep lips and sound together over minutes — the
 * audio device consumes samples at its own crystal's rate, and everything
 * else must follow it, not the other way around.
 *
 * Scheduling is sample-accurate: each decoded AudioData becomes an
 * AudioBufferSourceNode start()ed at an exact context time. Consecutive
 * buffers are chained by accumulated float duration (no µs-rounding gaps);
 * a timestamp discontinuity > 3 ms re-anchors the chain.
 *
 * AAC frames are all sync frames, so playback can enter the stream anywhere;
 * one earlier frame is fed as decoder warm-up and trimmed on output.
 */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.decoder = null;
    this.config = null;
    this.samples = [];
    this.supported = false;

    this.active = false;
    this.generation = 0;
    this.feedPos = 0;
    this.endFed = false;
    this.pumpTimer = null;

    this.mediaStartUs = 0;
    this.ctxStartTime = 0;
    this.nextTime = null;   // context time the next contiguous buffer starts at
    this.sources = new Set();

    this.muted = false;
    this.volume = 1;

    this.LEAD = 0.08;       // s of scheduling headroom before sound starts
    this.LOOKAHEAD = 1.5;   // s of audio kept decoded & scheduled ahead
  }

  get available() { return this.supported && this.samples.length > 0; }

  async load(config, samples) {
    this.destroy(false);
    this.supported = false;
    if (!('AudioDecoder' in window)) return false;
    try {
      const support = await AudioDecoder.isConfigSupported(config);
      if (!support.supported) return false;
    } catch (e) {
      return false;
    }
    this.config = config;
    this.samples = samples;
    this.supported = true;
    return true;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.gain.gain.value = this.muted ? 0 : this.volume;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** Begin playback at a media timestamp (µs). Returns false if no audio there. */
  start(mediaTimeUs) {
    if (!this.available) return false;
    this.stop();
    this._ensureCtx();
    // A context created without a user gesture stays suspended and its
    // currentTime does not advance — it must not master the clock. Decline;
    // the caller paces on the wall clock and audio joins on the next
    // gesture-driven play once the context is running.
    if (this.ctx.state !== 'running') return false;

    let i = this.samples.findIndex((s) => s.ts + s.duration > mediaTimeUs);
    if (i < 0) return false; // playhead is past the end of the audio track

    const gen = ++this.generation;
    this.active = true;
    this.mediaStartUs = mediaTimeUs;
    this.ctxStartTime = this.ctx.currentTime + this.LEAD;
    this.nextTime = null;
    this.feedPos = Math.max(0, i - 1); // one frame of decoder warm-up
    this.endFed = false;

    this.decoder = new AudioDecoder({
      output: (data) => this._onData(data, gen),
      error: (e) => console.warn('AudioDecoder error:', e),
    });
    this.decoder.configure(this.config);

    this._pump(gen);
    this.pumpTimer = setInterval(() => this._pump(gen), 250);
    return true;
  }

  /** Master clock: current media time (µs) as told by the audio hardware. */
  nowUs() {
    return this.mediaStartUs +
      Math.max(0, this.ctx.currentTime - this.ctxStartTime) * 1e6;
  }

  _pump(gen) {
    if (gen !== this.generation || !this.active) return;
    const horizonUs = this.nowUs() + this.LOOKAHEAD * 1e6;
    while (
      this.feedPos < this.samples.length &&
      this.samples[this.feedPos].ts < horizonUs &&
      this.decoder.decodeQueueSize < 30
    ) {
      const s = this.samples[this.feedPos++];
      this.decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: s.ts,
        duration: s.duration,
        data: s.data,
      }));
    }
    if (this.feedPos >= this.samples.length && !this.endFed) {
      this.endFed = true;
      this.decoder.flush().catch(() => {});
    }
  }

  _onData(data, gen) {
    if (gen !== this.generation || !this.active) { data.close(); return; }

    let buf;
    try {
      buf = this.ctx.createBuffer(
        data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      const tmp = new Float32Array(data.numberOfFrames);
      for (let c = 0; c < data.numberOfChannels; c++) {
        data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        buf.copyToChannel(tmp, c);
      }
    } catch (e) {
      data.close();
      return;
    }
    const ts = data.timestamp;
    data.close();

    // Ideal start time on the context clock; chain contiguous buffers by
    // float duration so µs rounding never opens clicks between them.
    let when = this.ctxStartTime + (ts - this.mediaStartUs) / 1e6;
    if (this.nextTime !== null && Math.abs(when - this.nextTime) < 0.003) {
      when = this.nextTime;
    }
    this.nextTime = when + buf.duration;

    // Trim anything that presents before the start point or that we're too
    // late to play — the timeline never shifts to accommodate a buffer.
    let offset = 0;
    if (when < this.ctxStartTime) { offset = this.ctxStartTime - when; when = this.ctxStartTime; }
    const now = this.ctx.currentTime;
    if (when < now) { offset += now - when; when = now; }
    if (offset >= buf.duration) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    src.start(when, offset);
  }

  stop() {
    this.generation++;
    this.active = false;
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    for (const s of this.sources) { try { s.stop(); } catch (e) {} }
    this.sources.clear();
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch (e) {}
    }
    this.decoder = null;
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : this.volume;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain && !this.muted) this.gain.gain.value = v;
  }

  destroy(closeCtx = true) {
    this.stop();
    this.samples = [];
    this.config = null;
    this.supported = false;
    if (closeCtx && this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gain = null;
    }
  }
}
