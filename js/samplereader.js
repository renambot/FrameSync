'use strict';

/**
 * Byte sources and the sample reader: how the player gets at sample data
 * without holding the file in memory.
 *
 * The demuxer reads only the index (the moov box) and records, for every
 * sample, where its bytes live in the file. Sample data is then fetched in
 * fixed-size blocks on demand, from a local File through Blob.slice or from
 * the server through HTTP Range requests, and kept in a small LRU cache. A
 * 5 GB movie costs the page the index plus a few blocks, instead of 5 GB.
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

  async read(offset, length) {
    if (this.fallback) return this.fallback.read(offset, length);
    if (this.first && offset === 0 && length <= this.first.byteLength) {
      const b = this.first; this.first = null;
      return b.byteLength === length ? b : b.slice(0, length);
    }
    const end = Math.min(this.size, offset + length) - 1;
    if (end < offset) return new ArrayBuffer(0);
    const resp = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` } });
    if (resp.status !== 206) throw new Error(`Could not fetch ${this.url} range ${offset}-${end} (${resp.status})`);
    return resp.arrayBuffer();
  }
}

/**
 * Sample data in blocks over a byte source. get() is synchronous so the
 * decoder feed loops stay simple: they take what is cached and ask for a
 * prefetch when they hit a gap. Blocks are addressed by their start offset;
 * a sample larger than a block gets a block of its own size.
 */
class SampleReader {
  constructor(source, { blockSize = 8 << 20, maxBlocks = 12 } = {}) {
    this.source = source;
    this.BLOCK = blockSize;
    this.MAX = maxBlocks;
    this.blocks = new Map();   // start offset -> Uint8Array, insertion order = LRU
    this.inflight = new Map(); // start offset -> Promise
    this.stats = { fetches: 0, bytes: 0 };
  }

  /** Cached block covering [offset, offset+size), or null. */
  _find(offset, size) {
    for (const [start, buf] of this.blocks) {
      if (offset >= start && offset + size <= start + buf.byteLength) {
        // Touch: re-insert so the map's order stays least-recently-used first.
        this.blocks.delete(start); this.blocks.set(start, buf);
        return { start, buf };
      }
    }
    return null;
  }

  /** The sample's bytes if cached, else null (and no side effects). */
  get(sample) {
    const hit = this._find(sample.offset, sample.size);
    if (!hit) return null;
    return hit.buf.subarray(sample.offset - hit.start, sample.offset - hit.start + sample.size);
  }

  /**
   * Fetch the block that will hold this sample, starting at the sample
   * itself so the first bytes decoded are the ones waited for. Deduped by
   * block start, so the feed loops can call this freely.
   */
  prefetch(sample) {
    if (this.get(sample)) return Promise.resolve();
    const start = sample.offset;
    if (this.inflight.has(start)) return this.inflight.get(start);
    const length = Math.min(Math.max(this.BLOCK, sample.size), this.source.size - start);
    const p = this.source.read(start, length).then((ab) => {
      this.blocks.set(start, new Uint8Array(ab));
      this.stats.fetches++;
      this.stats.bytes += ab.byteLength;
      while (this.blocks.size > this.MAX) this.blocks.delete(this.blocks.keys().next().value);
    }).finally(() => this.inflight.delete(start));
    this.inflight.set(start, p);
    return p;
  }

  /** Forget every block (a new file is loading, or memory is being handed back). */
  clear() { this.blocks.clear(); }
}
