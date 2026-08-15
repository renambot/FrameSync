'use strict';

/**
 * Demux an MP4 ArrayBuffer with MP4Box.js v2 (vendored ES module in
 * js/mp4box/, bridged onto window.MP4Box by index.html — demuxMP4 awaits
 * that bridge, so classic-script callers never race the module load).
 * Resolves with:
 *   video — { config: VideoDecoderConfig, samples: [...] }  (decode order)
 *   audio — { config: AudioDecoderConfig, samples: [...] } or null
 *   info  — human-facing metadata
 *
 * Sample shape: { ts, dts, duration (µs), isKey, data }.
 *
 * The whole file stays in memory, which is what makes random frame-exact
 * seeking cheap: any sample is addressable instantly.
 */
async function demuxMP4(arrayBuffer) {
  await window.mp4boxReady;
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const videoSamples = [];
    const audioSamples = [];
    let videoTrack = null;
    let audioTrack = null;
    let videoConfig = null;
    let audioConfig = null;
    let failed = false;

    const fail = (msg) => {
      if (!failed) {
        failed = true;
        reject(new Error(msg));
      }
    };

    file.onError = (e) => fail('MP4Box could not parse this file: ' + e);

    file.onReady = (mp4info) => {
      videoTrack = mp4info.videoTracks && mp4info.videoTracks[0];
      if (!videoTrack) return fail('No video track found in this file.');

      videoConfig = {
        codec: videoTrack.codec,
        codedWidth: videoTrack.video.width,
        codedHeight: videoTrack.video.height,
      };
      const description = extractVideoDescription(file, videoTrack.id);
      if (description) videoConfig.description = description;
      file.setExtractionOptions(videoTrack.id, 'video', { nbSamples: 1000 });

      audioTrack = pickAudioTrack(mp4info.audioTracks);
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
        file.setExtractionOptions(audioTrack.id, 'audio', { nbSamples: 1000 });
      }

      file.start();
    };

    file.onSamples = (trackId, user, newSamples) => {
      const bucket = user === 'audio' ? audioSamples : videoSamples;
      for (const s of newSamples) {
        bucket.push({
          ts: Math.round((s.cts * 1e6) / s.timescale),
          dts: Math.round((s.dts * 1e6) / s.timescale),
          duration: Math.round((s.duration * 1e6) / s.timescale),
          isKey: s.is_sync,
          data: s.data,
        });
      }
    };

    // v2 wants an MP4BoxBuffer, which is just an ArrayBuffer carrying a
    // fileStart marker — brand the buffer in place rather than paying
    // MP4BoxBuffer.fromArrayBuffer's full copy (files can be hundreds of MB).
    arrayBuffer.fileStart = 0;
    file.appendBuffer(arrayBuffer, /* last: */ true);
    file.flush();

    // MP4Box extraction runs synchronously inside appendBuffer/flush;
    // defer one tick so any trailing onSamples batch lands first.
    setTimeout(() => {
      if (failed) return;
      if (!videoTrack) return fail('This does not look like a valid MP4/MOV file.');
      if (videoSamples.length === 0) return fail('The video track contains no readable samples.');

      normalizeTimestamps(file, videoTrack.id, videoSamples);
      if (audioTrack) normalizeTimestamps(file, audioTrack.id, audioSamples);

      const durationSec = videoTrack.duration / videoTrack.timescale;
      resolve({
        video: { config: videoConfig, samples: videoSamples },
        audio: audioTrack && audioSamples.length
          ? { config: audioConfig, samples: audioSamples }
          : null,
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
        },
      });
    }, 0);
  });
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
