'use strict';

/**
 * Demux an MP4 from a byte source (BlobByteSource / UrlByteSource / BufferByteSource,
 * see samplereader.js) with MP4Box.js v2 (vendored ES module in js/mp4box/,
 * bridged onto window.MP4Box by index.html — demuxMP4 awaits that bridge, so
 * classic-script callers never race the module load).
 * Resolves with:
 *   video  — { config: VideoDecoderConfig, samples: [...] }  (decode order)
 *   audio  — { config: AudioDecoderConfig, samples: [...] } or null
 *   reader — SampleReader: where sample bytes come from, on demand
 *   info   — human-facing metadata
 *
 * Sample shape: { ts, dts, duration (µs), isKey, offset, size } — where the
 * bytes are, not the bytes. Only the index (the moov box) is read here: it
 * names every sample's position and size, which is all random access needs.
 * The data is fetched in blocks as decoding reaches it, so the memory cost
 * of a file is its index plus a few blocks, whatever its size.
 *
 * Reading the index means following MP4Box: appendBuffer returns the next
 * file position it wants, which skips over the mdat when the moov sits at
 * the end (an un-"faststarted" file). Fragmented files (moov with mvex)
 * keep no sample table in the moov, so for those the whole file is walked
 * to collect the moof tables — the data still is not retained.
 */
async function demuxMP4(source) {
  await window.mp4boxReady;
  const file = MP4Box.createFile(); // discards mdat payloads it is handed
  let ready = null;
  let error = null;
  file.onError = (e) => { error = 'MP4Box could not parse this file: ' + e; };
  file.onReady = (mp4info) => { ready = mp4info; };

  // Walk the file until the index is complete: one probe-sized read, then
  // larger ones. MP4Box reports where to read next; no progress, or an
  // implausible amount of index, means a file this parser cannot handle.
  const INDEX_CAP = 512 << 20; // more index than this is not an index
  let pos = 0, readBytes = 0, chunk = 1 << 20;
  for (;;) {
    if (error) throw new Error(error);
    if (ready && !file.moov.mvex) break;
    if (pos >= source.size) break;
    const ab = await source.read(pos, chunk);
    if (!ab.byteLength) break;
    ab.fileStart = pos;
    readBytes += ab.byteLength;
    const next = file.appendBuffer(ab);
    if (!ready && readBytes > INDEX_CAP) throw new Error('No readable index within the first 512 MB of this file.');
    if (next === undefined || next === pos) throw new Error('This does not look like a valid MP4/MOV file.');
    pos = next;
    chunk = 4 << 20;
  }
  if (error) throw new Error(error);
  if (!ready) throw new Error('This does not look like a valid MP4/MOV file.');

  const videoTrack = ready.videoTracks && ready.videoTracks[0];
  if (!videoTrack) throw new Error('No video track found in this file.');

  const videoConfig = {
    codec: videoTrack.codec,
    codedWidth: videoTrack.video.width,
    codedHeight: videoTrack.video.height,
  };
  const description = extractVideoDescription(file, videoTrack.id);
  if (description) videoConfig.description = description;
  const videoSamples = sampleIndex(file.getTrackSamplesInfo(videoTrack.id));
  if (videoSamples.length === 0) throw new Error('The video track contains no readable samples.');

  const audioTrack = pickAudioTrack(ready.audioTracks);
  let audioConfig = null, audioSamples = [];
  if (audioTrack) {
    audioConfig = {
      codec: webCodecsAudioCodec(audioTrack.codec),
      sampleRate: audioTrack.audio.sample_rate,
      numberOfChannels: audioTrack.audio.channel_count,
    };
    const asc = extractAudioSpecificConfig(file, audioTrack.id);
    if (asc) {
      audioConfig.description = asc;
      // The stsd channel count is unreliable (often hardcoded 2);
      // the AudioSpecificConfig is authoritative for AAC.
      const parsed = parseAudioSpecificConfig(asc);
      if (parsed) {
        audioConfig.sampleRate = parsed.sampleRate;
        audioConfig.numberOfChannels = parsed.channels;
      }
    }
    fixupAudioConfig(audioConfig, file, audioTrack.id);
    audioSamples = sampleIndex(file.getTrackSamplesInfo(audioTrack.id));
  }

  normalizeTimestamps(file, videoTrack.id, videoSamples);
  if (audioTrack) normalizeTimestamps(file, audioTrack.id, audioSamples);

  // Fragmented files with an empty moov report no track duration; the sample
  // table knows the real end.
  let durationSec = videoTrack.duration / videoTrack.timescale;
  if (!(durationSec > 0)) {
    let endUs = 0;
    for (const v of videoSamples) endUs = Math.max(endUs, v.ts + v.duration);
    durationSec = endUs / 1e6;
  }
  return {
    video: { config: videoConfig, samples: videoSamples },
    audio: audioTrack && audioSamples.length
      ? { config: audioConfig, samples: audioSamples }
      : null,
    reader: new SampleReader(source, { bytesPerSec: durationSec > 0 ? source.size / durationSec : 0 }),
    info: {
      codec: videoTrack.codec,
      width: videoTrack.video.width,
      height: videoTrack.video.height,
      durationSec,
      sampleCount: videoSamples.length,
      nominalFps: videoSamples.length / durationSec,
      audio: audioTrack ? {
        codec: audioTrack.codec,
        sampleRate: audioConfig.sampleRate,
        channels: audioConfig.numberOfChannels,
      } : null,
      indexBytes: readBytes,
    },
  };
}

/** MP4Box's per-sample table → the player's sample shape (positions, no data). */
function sampleIndex(samples) {
  const out = [];
  for (const s of samples || []) {
    out.push({
      ts: Math.round((s.cts * 1e6) / s.timescale),
      dts: Math.round((s.dts * 1e6) / s.timescale),
      duration: Math.round((s.duration * 1e6) / s.timescale),
      isKey: s.is_sync,
      offset: s.offset,
      size: s.size,
    });
  }
  return out;
}

/**
 * Shift a track's composition timestamps onto the presentation timeline.
 * The edit list is authoritative: its media_time says where the presented
 * timeline enters the media (hiding B-frame reordering offsets on video and
 * encoder priming samples on audio). Files without an edit list fall back to
 * anchoring the earliest composition time at zero. Samples may end up with
 * ts < 0 — they are decode fodder that presents before t = 0 (trimmed or
 * dropped at render time).
 */
function normalizeTimestamps(file, trackId, samples) {
  if (!samples.length) return;
  const trak = file.getTrackById(trackId);
  let offset = null;
  const edits = trak.edits || (trak.tkhd && trak.edits);
  if (Array.isArray(edits)) {
    const edit = edits.find((e) => e.media_time >= 0);
    if (edit) {
      offset = Math.round((edit.media_time * 1e6) / trak.mdia.mdhd.timescale);
    }
  }
  if (offset === null) {
    offset = Infinity;
    for (const s of samples) offset = Math.min(offset, s.ts);
  }
  if (offset !== 0) for (const s of samples) s.ts -= offset;
}

/**
 * Codec-private data (avcC / hvcC box payload) that H.264 / HEVC decoders
 * need. VP8/VP9/AV1 in MP4 configure without a description.
 */
function extractVideoDescription(file, trackId) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC;
    if (box) {
      const { DataStream, Endianness } = MP4Box;
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  return undefined;
}

/**
 * Container codec string → WebCodecs AudioDecoder codec string.
 * The important remap: MP3 muxed in MP4 announces itself as mp4a.6b/.69
 * (MPEG-1/2 audio object types), but AudioDecoder wants plain "mp3".
 */
function webCodecsAudioCodec(containerCodec) {
  const c = containerCodec.toLowerCase();
  if (c === 'mp4a.6b' || c === 'mp4a.69') return 'mp3';
  if (c.startsWith('opus')) return 'opus';
  return containerCodec; // AAC (mp4a.40.x) and anything else pass through
}

/**
 * Files can carry several audio tracks (e.g. Big Buck Bunny ships MP3 and
 * AC-3). Prefer the one WebCodecs is most likely to decode instead of
 * blindly taking track 0.
 */
function pickAudioTrack(tracks) {
  if (!tracks || !tracks.length) return null;
  // Ranked by how likely WebCodecs is to decode it, not by fidelity: an
  // undecodable track is worth less than a lossy one that plays.
  const score = (t) => {
    const c = t.codec.toLowerCase();
    if (c.startsWith('mp4a.40')) return 3;              // AAC
    if (c === 'mp4a.6b' || c === 'mp4a.69') return 2;   // MP3
    if (c.startsWith('opus') || c.startsWith('flac')) return 1;
    return 0;                                           // AC-3 etc.
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

/**
 * AudioSpecificConfig for AAC: esds → ES_Descriptor → DecoderConfigDescriptor
 * → DecoderSpecificInfo payload. AudioDecoder needs it to configure mp4a.40.x.
 */
function extractAudioSpecificConfig(file, trackId) {
  try {
    const trak = file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      // QuickTime-style entries (SoundDescription v1/v2) nest the esds
      // inside a 'wave' extension box, so search the entry's box tree
      // instead of expecting esds at the top level.
      const esds = findEsds(entry);
      const dcd = esds && esds.esd && esds.esd.descs && esds.esd.descs[0];
      const dsi = dcd && dcd.descs && dcd.descs[0];
      if (dsi && dsi.data) return new Uint8Array(dsi.data);
    }
  } catch (e) { /* non-AAC audio; try configuring without a description */ }
  return undefined;
}

/**
 * Depth-limited hunt for an esds box. QuickTime nests it inside a 'wave'
 * extension rather than placing it in the sample entry, and the depth cap
 * keeps a malformed or cyclic box tree from running away.
 */
function findEsds(box, depth = 0) {
  if (!box || depth > 3) return null;
  if (box.esds) return box.esds;
  if (box.type === 'esds') return box;
  for (const child of box.boxes || []) {
    const found = findEsds(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Repair configs from QuickTime-style sample entries, whose legacy stsd
 * fields are placeholders (channels=3, rate=1.0). The mdhd timescale of an
 * audio track equals its sample rate, which gives a trustworthy fallback.
 * For AAC with no recoverable AudioSpecificConfig, synthesize a minimal one
 * (AAC-LC + rate + channels) — without a description, AudioDecoder assumes
 * ADTS framing and dies on raw MP4 samples.
 */
function fixupAudioConfig(config, file, trackId) {
  const trak = file.getTrackById(trackId);
  const mdhdRate = trak.mdia.mdhd.timescale;
  if (!(config.sampleRate >= 4000) && mdhdRate >= 4000) config.sampleRate = mdhdRate;
  if (!(config.numberOfChannels >= 1 && config.numberOfChannels <= 32)) config.numberOfChannels = 2;

  if (!config.description && config.codec.startsWith('mp4a.40')) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000,
                   24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const sfi = rates.indexOf(config.sampleRate);
    // Placeholder channel counts (the QT '3' with a bogus rate) default to stereo.
    const chan = (config.numberOfChannels === 3 && mdhdRate !== config.sampleRate) ? 2
      : Math.min(config.numberOfChannels, 7);
    if (sfi >= 0 && chan >= 1) {
      config.description = new Uint8Array([
        (2 << 3) | (sfi >> 1),          // AOT 2 (AAC-LC) + sfi high bits
        ((sfi & 1) << 7) | (chan << 3), // sfi low bit + channel config
      ]);
      config.numberOfChannels = chan;
    }
  }
}

/** Sample rate and channel count from the first bytes of an AAC ASC. */
function parseAudioSpecificConfig(asc) {
  if (asc.length < 2) return null;
  const rates = [96000, 88200, 64000, 48000, 44100, 32000,
                 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const aot = asc[0] >> 3;
  if (aot === 31) return null; // extended object type; keep container values
  const sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const channels = (asc[1] >> 3) & 0x0f;
  if (sfi >= rates.length || channels === 0) return null;
  return { sampleRate: rates[sfi], channels };
}
