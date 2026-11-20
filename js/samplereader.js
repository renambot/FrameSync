'use strict';

/**
 * Byte sources and the sample reader: how the player gets at sample data
 * without holding the file in memory.
 *
 * The demuxer reads only the index (the moov box) and records, for every
 * sample, where its bytes live in the file. Sample data is then fetched in
 * fixed, aligned blocks on demand, from a local File through Blob.slice or
 * from the server through HTTP Range requests, and kept in a small LRU
 * cache. A 5 GB movie costs the page the index plus a few blocks, instead of
 * 5 GB.
 *
 * Both tracks of a file share one reader, because audio and video samples
 * interleave in the same mdat: the block that holds a second of video holds
 * that second's audio too.
 */

/** A File or Blob: Blob.slice reads exactly the bytes asked for. */
class BlobByteSource {
  constructor(blob) { this.blob = blob; this.size = blob.size; }
  async read(offset, length) {
    return this.blob.slice(offset, Math.min(this.size, offset + length)).arrayBuffer();
  }
}

/** A buffer already in memory (the fallback when a host ignores Range). */
class BufferByteSource {
  constructor(buffer) { this.buffer = buffer; this.size = buffer.byteLength; }
  async read(offset, length) {
    return this.buffer.slice(offset, Math.min(this.size, offset + length));
  }
}

/**
 * A URL served with byte ranges. The first read doubles as detection: a 206
 * carries the file size in Content-Range; a 200 means the host ignores Range,
 * in which case the body is the whole file and the source turns itself into a
 * BufferByteSource, so plain static hosting keeps working for solo play.
 */
class UrlByteSource {
  constructor(url) { this.url = url; this.size = null; this.fallback = null; }

  /** Probe with a ranged request; resolves when size is known. */
  static async open(url, probeLength) {
    const src = new UrlByteSource(url);
    const resp = await fetch(url, { headers: { Range: `bytes=0-${probeLength - 1}` } });
    if (resp.status === 206) {
      const m = /\/(\d+)\s*$/.exec(resp.headers.get('content-range') || '');
      if (!m) throw new Error(`Could not fetch ${url}: ranged response without a size`);
      src.size = Number(m[1]);
      src.first = await resp.arrayBuffer(); // the probe bytes, handed to the first read
      return src;
    }
    if (resp.status === 200) {
      src.fallback = new BufferByteSource(await resp.arrayBuffer());
      src.size = src.fallback.size;
      return src;
    }
    throw new Error(`Could not fetch ${url} (${resp.status})`);
  }

  async read(offset, length, signal) {
    if (this.fallback) return this.fallback.read(offset, length);
    if (this.first && offset === 0 && length <= this.first.byteLength) {
      const b = this.first; this.first = null;
      return b.byteLength === length ? b : b.slice(0, length);
    }
    const end = Math.min(this.size, offset + length) - 1;
    if (end < offset) return new ArrayBuffer(0);
    const resp = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` }, signal });
    if (resp.status !== 206) throw new Error(`Could not fetch ${this.url} range ${offset}-${end} (${resp.status})`);
    return resp.arrayBuffer();
  }
}

/**
 * Sample data in aligned blocks over a byte source. Block k is the file's
 * bytes [k·BLOCK, (k+1)·BLOCK), so a block is named by its index, two
 * requests for the same bytes are the same request, and sequential playback
 * reads the file as one unbroken run. get() is synchronous so the decoder
 * feed loops stay simple: they take what is cached and ask for a prefetch
 * when they hit a gap.
 *
 * Blocks are fetched one at a time, in order. Parallel requests would only
 * split the bandwidth and delay the block the feed is waiting for; the
 * read-ahead keeps the next block in flight while the current one decodes,
 * which is all a steady link needs. A seek that needs a different block
 * aborts a read-ahead still in flight rather than queueing behind it.
 */
class SampleReader {
  /**
   * Block size and read-ahead follow the file's bitrate when it is known: a
   * block holds about two seconds of data (8 to 64 MB) and the feed keeps
   * about three seconds fetched ahead, so a 100 Mbit/s wall movie gets the
   * same seconds of headroom as a small clip.
   */
  constructor(source, { bytesPerSec = 0 } = {}) {
    this.source = source;
    const MB = 1 << 20;
    this.BLOCK = Math.min(64 * MB, Math.max(8 * MB, Math.round(bytesPerSec * 2)));
    this.AHEAD = Math.min(4 * this.BLOCK, Math.max(2 * this.BLOCK, Math.round(bytesPerSec * 3)));
    this.MAX = Math.max(8, Math.ceil((160 * MB) / this.BLOCK)); // cache: ~160 MB, never under 8 blocks
    this.MAX_INFLIGHT = 1;
    this.blocks = new Map();   // block index -> Uint8Array, insertion order = LRU
    this.inflight = new Map(); // block index -> { promise, abort }
    this.stats = { fetches: 0, bytes: 0 };
  }

  _index(offset) { return Math.floor(offset / this.BLOCK); }

  /** Cached block by index, touched to the LRU's recent end. */
  _block(i) {
    const buf = this.blocks.get(i);
    if (!buf) return null;
    this.blocks.delete(i); this.blocks.set(i, buf);
    return buf;
  }

  /** The sample's bytes if cached, else null (and no side effects). */
  get(sample) {
    const i0 = this._index(sample.offset), i1 = this._index(sample.offset + sample.size - 1);
    const a = this._block(i0);
    if (!a) return null;
    const off = sample.offset - i0 * this.BLOCK;
    if (i1 === i0) return a.subarray(off, off + sample.size);
    // The sample straddles a block boundary (once per block, at most): join.
    const b = this._block(i1);
    if (!b) return null;
    const out = new Uint8Array(sample.size);
    out.set(a.subarray(off));
    out.set(b.subarray(0, sample.size - (a.byteLength - off)), a.byteLength - off);
    return out;
  }

  /** Fetch block i; deduped by index. */
  _fetch(i) {
    if (this.inflight.has(i)) return this.inflight.get(i).promise;
    const start = i * this.BLOCK;
    const length = Math.min(this.BLOCK, this.source.size - start);
    if (length <= 0) return Promise.resolve();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const promise = this.source.read(start, length, ctl ? ctl.signal : undefined).then((ab) => {
      this.blocks.set(i, new Uint8Array(ab));
      this.stats.fetches++;
      this.stats.bytes += ab.byteLength;
      while (this.blocks.size > this.MAX) this.blocks.delete(this.blocks.keys().next().value);
    }).finally(() => this.inflight.delete(i));
    this.inflight.set(i, { promise, abort: () => ctl && ctl.abort() });
    return promise;
  }

  /**
   * Fetch whatever block(s) hold this sample; resolves when its bytes are
   * cached. This is the urgent path (the feed is stalled on it), so any
   * other block still in flight — a read-ahead made stale by a seek — is
   * abandoned to give this one the whole link.
   */
  prefetch(sample) {
    if (this.get(sample)) return Promise.resolve();
    const i0 = this._index(sample.offset), i1 = this._index(sample.offset + sample.size - 1);
    for (const [k, f] of this.inflight) if (k !== i0 && k !== i1) { f.abort(); this.stats.aborted = (this.stats.aborted || 0) + 1; }
    const ps = [];
    if (!this.blocks.has(i0)) ps.push(this._fetch(i0));
    if (i1 !== i0 && !this.blocks.has(i1)) ps.push(this._fetch(i1));
    return Promise.all(ps);
  }

  /**
   * Keep AHEAD bytes fetched beyond this sample, in order, never more than
   * MAX_INFLIGHT blocks at a time. Called by the video feed on every sample
   * it serves; a no-op while the run ahead is long enough.
   */
  ensureAhead(sample) {
    const from = this._index(sample.offset);
    const to = Math.min(this._index(sample.offset + this.AHEAD), this._index(this.source.size - 1));
    for (let i = from; i <= to; i++) {
      if (this.blocks.has(i) || this.inflight.has(i)) continue;
      if (this.inflight.size >= this.MAX_INFLIGHT) return;
      this._fetch(i).catch(() => {});
    }
  }

  /** Forget every block (a new file is loading, or memory is being handed back). */
  clear() { this.blocks.clear(); }
}
