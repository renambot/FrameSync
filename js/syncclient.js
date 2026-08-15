'use strict';

/**
 * SyncClient — shared clock + declarative playback state over a WebSocket.
 *
 * Clock: NTP-style. Each second the client sends its send-time; the server
 * answers with its microsecond clock. offset = serverUs + rtt/2 − receiveUs.
 * The estimate used is the offset of the minimum-RTT sample in the recent
 * window — minimum RTT is the sample least polluted by queueing delay. On a
 * LAN this agrees with the server well under a millisecond, ~30× tighter
 * than one frame period at 30 fps.
 *
 * State is a mapping, not a command: {mediaTimeUs, atSharedUs, rate,
 * playing, src, seq}. Followers evaluate it against sharedNowUs() locally,
 * so message latency does not shift playback — a state message applied late
 * still lands every client on the same frame.
 */
class SyncClient {
  constructor(role, { onState, onStatus } = {}) {
    this.role = role;
    this.cb = { onState, onStatus };
    this.ws = null;
    this.samples = [];   // recent {rtt, offset} pairs, µs
    this.connected = false;
    this.closed = false;
    this.seq = 0;
    this.pingTimer = null;
    this.reportFn = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    this.ws = new WebSocket(proto + location.host + '/sync');

    this.ws.onopen = () => {
      this.connected = true;
      this._send({ type: 'hello', role: this.role });
      this._ping();
      this.pingTimer = setInterval(() => {
        this._ping();
        if (this.reportFn) this._send({ type: 'report', ...this.reportFn() });
      }, 1000);
      this._status();
    };

    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this._status();
      if (!this.closed) setTimeout(() => this.connect(), 2000);
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'pong') {
        const t1 = performance.now() * 1000;
        const rtt = t1 - msg.t0;
        this.samples.push({ rtt, offset: msg.serverUs + rtt / 2 - t1 });
        if (this.samples.length > 20) this.samples.shift();
        this._status();
      } else if (msg.type === 'state') {
        this.cb.onState?.(msg);
      }
    };
  }

  get clockReady() { return this.samples.length >= 3; }

  get offsetUs() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  get rttMs() {
    return this.samples.length
      ? Math.min(...this.samples.map((s) => s.rtt)) / 1000
      : null;
  }

  /** The server's clock, estimated locally. The one timeline everyone shares. */
  sharedNowUs() { return performance.now() * 1000 + this.offsetUs; }

  /** Master: broadcast a new playback anchor. */
  sendState(state) { this._send({ type: 'state', seq: ++this.seq, ...state }); }

  /** Follower: register a function producing the once-a-second sync report. */
  setReporter(fn) { this.reportFn = fn; }

  _ping() { this._send({ type: 'ping', t0: performance.now() * 1000 }); }
  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  _status() { this.cb.onStatus?.(this); }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
    this.connected = false;
  }
}
