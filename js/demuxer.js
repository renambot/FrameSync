'use strict';

/**
 * Demux an MP4 ArrayBuffer with MP4Box.js.
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
function demuxMP4(arrayBuffer) {
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

      audioTrack = mp4info.audioTracks && mp4info.audioTracks[0];
      if (audioTrack) {
        audioConfig = {
          codec: audioTrack.codec,
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

    arrayBuffer.fileStart = 0;
    file.appendBuffer(arrayBuffer);
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
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  return undefined;
}

/**
 * AudioSpecificConfig for AAC: esds → ES_Descriptor → DecoderConfigDescriptor
 * → DecoderSpecificInfo payload. AudioDecoder needs it to configure mp4a.40.x.
 */
function extractAudioSpecificConfig(file, trackId) {
  try {
    const trak = file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const esds = entry.esds;
      const dcd = esds && esds.esd && esds.esd.descs && esds.esd.descs[0];
      const dsi = dcd && dcd.descs && dcd.descs[0];
      if (dsi && dsi.data) return new Uint8Array(dsi.data);
    }
  } catch (e) { /* non-AAC audio; try configuring without a description */ }
  return undefined;
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
