#!/usr/bin/env node
'use strict';

/**
 * FrameSync server — static files + /sync WebSocket + /status. Zero deps.
 *
 * The server is the timebase: nowUs() is a monotonic microsecond clock that
 * every client estimates NTP-style. Playback state is a tiny declarative
 * tuple {mediaTimeUs, atSharedUs, rate, playing, src, seq} — the master
 * broadcasts it, the server stores the latest copy (so late joiners sync on
 * arrival) and relays it to everyone else. Message latency cancels out
 * because clients evaluate the mapping against the shared clock themselves.
 *
 *   node server.js [port]     (default 8417)
 *   GET /status               JSON: state + per-client sync error
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 8417);
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

let lastState = null;
let nextClientId = 1;
const clients = new Map(); // socket -> {id, role, report, socket}

// Master arbitration: exactly one client owns the timeline. Ownership is
// granted on hello(role=master) — last claim wins, the previous owner is
// demoted. Anchors are accepted only from the owner (by connection identity,
// or by token so a reconnecting owner's in-flight anchors are still
// attributable); anything else gets a 'demoted' reply instead of silently
// fighting over the state.
let masterClient = null;
let masterToken = null;
let lastAnchorUs = 0;
const MASTER_TIMEOUT_US = 3e6;

function grantMaster(client) {
  if (masterClient && masterClient !== client && clients.has(masterClient.socket)) {
    sendJson(masterClient.socket, { type: 'demoted' });
  }
  masterClient = client;
  masterToken = crypto.randomBytes(8).toString('hex');
  lastAnchorUs = nowUs();
  sendJson(client.socket, { type: 'master-granted', token: masterToken });
}

/**
 * The master is gone (socket closed, or silent past the heartbeat timeout).
 * Freeze the timeline: extrapolate the mapping to "now", pause it there, and
 * tell everyone. Followers pause in unison on the frame the master would be
 * showing, and late joiners inherit a sane paused state instead of
 * extrapolating a ghost anchor forever.
 */
function masterLost() {
  masterClient = null;
  masterToken = null;
  if (lastState && lastState.playing) {
    const t = nowUs();
    lastState = {
      ...lastState,
      mediaTimeUs: Math.round(
        lastState.mediaTimeUs + (t - lastState.atSharedUs) * lastState.rate),
      atSharedUs: t,
      rate: 0,
      playing: false,
    };
  }
  for (const [sock] of clients) {
    if (lastState) sendJson(sock, { type: 'state', ...lastState });
    sendJson(sock, { type: 'master-lost' });
  }
}

setInterval(() => {
  if (masterClient && nowUs() - lastAnchorUs > MASTER_TIMEOUT_US) masterLost();
}, 1000).unref();

// ---------- HTTP: static files + /status ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/status') {
    const list = [...clients.values()].map((c) => {
      let errUs = null;
      if (c.report && lastState) {
        const expected = lastState.playing
          ? lastState.mediaTimeUs + (c.report.sharedUs - lastState.atSharedUs) * lastState.rate
          : lastState.mediaTimeUs;
        errUs = Math.round(c.report.mediaUs - expected);
      }
      return {
        id: c.id, role: c.role,
        frame: c.report ? c.report.frame : null,
        errUs,
        reportAgeMs: c.report ? Math.round((nowUs() - c.report.sharedUs) / 1000) : null,
      };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      serverUs: nowUs(),
      masterId: masterClient ? masterClient.id : null,
      state: lastState,
      clients: list,
    }, null, 2));
    return;
  }

  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- WebSocket: /sync ----------

server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/sync') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const client = { id: nextClientId++, role: '?', report: null, socket };
  clients.set(socket, client);

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const f = parseFrame(buf);
      if (!f) break;
      if (f.error) { socket.destroy(); return; }
      buf = buf.subarray(f.consumed);
      if (f.opcode === 8) { sendFrame(socket, Buffer.alloc(0), 8); socket.end(); return; }
      if (f.opcode === 9) { sendFrame(socket, f.payload, 10); continue; }
      if (f.opcode !== 1) continue;
      let msg;
      try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
      handleMessage(client, msg);
    }
  });
  const drop = () => {
    clients.delete(socket);
    if (client === masterClient) masterLost();
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'hello':
      client.role = msg.role || '?';
      sendJson(client.socket, { type: 'welcome', id: client.id, serverUs: nowUs() });
      if (msg.role === 'master') grantMaster(client);
      if (lastState) sendJson(client.socket, { type: 'state', ...lastState });
      if (!masterClient && client.role === 'follower') {
        sendJson(client.socket, { type: 'master-lost' });
      }
      break;
    case 'ping':
      sendJson(client.socket, { type: 'pong', t0: msg.t0, serverUs: nowUs() });
      break;
    case 'state': {
      if (client !== masterClient && (!masterToken || msg.token !== masterToken)) {
        sendJson(client.socket, { type: 'demoted' });
        break;
      }
      const { type, token, ...state } = msg;
      lastState = state;
      lastAnchorUs = nowUs();
      for (const [sock, c] of clients) {
        if (c !== client) sendJson(sock, { type: 'state', ...state });
      }
      break;
    }
    case 'report':
      client.report = { frame: msg.frame, mediaUs: msg.mediaUs, sharedUs: msg.sharedUs };
      break;
  }
}

// ---------- minimal RFC 6455 framing (small text messages) ----------

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 1048576n) return { error: true };
    len = Number(big); off = 10;
  }
  if (len > 1048576) return { error: true };
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const key = buf.subarray(off, off + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
  }
  return { opcode, payload, consumed: off + maskLen + len };
}

function sendFrame(socket, payload, opcode = 1) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch (e) { /* dying socket */ }
}

const sendJson = (socket, obj) => sendFrame(socket, Buffer.from(JSON.stringify(obj)), 1);

server.listen(PORT, () => {
  console.log(`FrameSync server on http://localhost:${PORT} — sync status at /status`);
});
