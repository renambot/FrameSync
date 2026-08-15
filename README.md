# videoSync — frame-exact WebCodecs player

A web page that plays MP4 video (with audio) with **frame-exact** seeking,
stepping, and timing readout, built directly on the modern low-level web
media stack:

- **WebCodecs** (`VideoDecoder`, `AudioDecoder`, `VideoFrame`,
  `EncodedVideoChunk`) — the page owns the decode pipeline instead of
  trusting `<video>.currentTime`.
- **MP4Box.js v2.4.1** (vendored as an ES module in `js/mp4box/`) — demuxes
  the MP4 into a full sample table held in memory, so every frame is
  addressable.
- **Canvas 2D** — each `VideoFrame` is drawn explicitly; nothing is
  interpolated or dropped silently.
- **Web Audio** — decoded AAC is scheduled sample-accurately on the
  `AudioContext` timeline.

## Run it

```sh
node server.js          # default port 8417
# open http://localhost:8417/
```

The zero-dependency Node server serves the static files and provides the
`/sync` WebSocket plus a `/status` JSON endpoint. For a single solo player
any static server works — there is still no build step (the app is classic
scripts; mp4box v2 loads as a native ES module, so `file://` no longer
works — serve over HTTP).

Drop any MP4/MOV (H.264, HEVC*, VP9, AV1 — whatever the browser's decoder
supports) onto the stage. Requires Chrome/Edge 94+, Safari 16.4+, or
Firefox 130+.

## Why this is frame-exact

- The demuxer builds a **presentation-order frame table**: every sample's
  composition timestamp (µs), sorted. "Frame N" means exactly the Nth entry —
  correct even with B-frame reordering and variable frame rate.
- **Seeking to frame N**: reset the decoder, re-enter the bitstream at the
  nearest sync sample at-or-before N in decode order, decode forward, and
  discard every output below frame N's timestamp. The displayed frame is
  frame N — never a neighbour, which is what `video.currentTime = t` gives you.
- **Stepping** consumes the decoded frame queue one `VideoFrame` at a time
  (backwards = seek to N−1).
- Composition-time offsets from B-frame files (raw `ctts`, normally masked by
  the edit list) are normalized so frame 0 presents at exactly t = 0.
- Playback is paced by mapping `performance.now()` onto media timestamps. If
  *rendering* falls behind, frames are skipped to stay on clock (counted in
  the footer as "skipped for pacing"); if the *decoder* falls behind, the
  clock rebases so no frame is ever silently lost.

The amber strip above the scrubber plots every **keyframe** (sync sample) in
the file — the real random-access structure that determines seek cost.

## Audio and the clock hierarchy

During 1× playback the **audio hardware clock is the master**: decoded AAC
frames become `AudioBufferSourceNode`s scheduled at exact context times
(chained by float duration so µs rounding never opens clicks), and the video
render loop paces itself against `AudioContext.currentTime` mapped back to
media time. That is the only way lips and sound stay together over minutes.
The stats footer shows which clock is driving (`clock audio` / `clock wall`).

Consequences of that hierarchy:
- Pause, stepping, and scrubbing are silent and stay frame-exact
  (wall/no clock — video truth).
- Seeking while playing restarts audio at the new frame's timestamp.
- At rates other than 1× audio is disabled and the wall clock paces video.
- If the video decoder ever falls behind during audio playback, audio
  continuity wins and video catches up (skips are counted); with the wall
  clock the opposite choice is made — the clock rebases so no frame is lost.

The stsd channel count in MP4s is unreliable, so the demuxer parses the AAC
AudioSpecificConfig for the true sample rate and channel count, and track
timestamps are normalized through the edit list (`elst`), which is what
aligns B-frame composition offsets on video and encoder priming on audio.

`window.vsPlayer` / `window.vsAudio` are exposed for console experiments.

## Multi-client sync

Open the page on any number of machines pointing at the same server and give
each a role (header dropdown, or URL params):

```
http://SERVER:8417/?role=master&src=test/frames-30fps-audio.mp4
http://SERVER:8417/?role=follower&fullscreen
```

URL params: `role` (master/follower), `src` (server-relative file to load),
`loop` — loop playback at end of file, and `fullscreen` (or `fs`) — takes
the stage fullscreen (video only, cursor hidden). Browsers require a user gesture for fullscreen, so if the immediate
request is refused, the first click or keypress on the page triggers it; the
⛶ button and the F key toggle it any time. For unattended wall nodes, launch
the browser with `--start-fullscreen` or `--kiosk` instead.

Followers auto-load whatever file the master announces (when it was loaded
by URL — `?src=` or a synced path), lock their transport controls, and slave
their render clock to the master. Play, pause, seek, step, and rate changes
on the master drive everyone.

How it works — the transport (a WebSocket) matters less than the design:

- **Shared clock.** Each client estimates the server's microsecond clock
  NTP-style (offset of the minimum-RTT sample). On a LAN this agrees to well
  under 1 ms — ~30× tighter than one frame at 30 fps.
- **Declarative state, not commands.** The master broadcasts
  `{mediaTimeUs, atSharedUs, rate, playing, src, seq}` (on every transport
  action, re-anchored every 500 ms). Followers evaluate
  `mediaTimeUs + (sharedNow − atSharedUs) × rate` locally each frame, so
  message latency cancels out entirely: a client that receives state late —
  or reconnects after an outage — lands on the same frame as everyone else
  with a single message.
- **Clock hierarchy on a follower**: sync > wall. Audio is silenced
  (independent DACs cannot share a clock); play audio on one designated node
  (the master, whose own clock is its audio hardware — the periodic
  re-anchor transmits that clock to the followers).
- `GET /status` reports each client's displayed frame and its deviation from
  the master mapping, measured in the shared clock domain — transport
  latency does not pollute the measurement.
- **Master liveness & arbitration.** Master ownership is granted by the
  server (last claim wins, token-stamped). If the master disconnects — or
  goes silent past 3 s, e.g. a hung machine — the server freezes the
  timeline: it extrapolates the mapping to "now", broadcasts it as a paused
  state, and notifies everyone (followers show `MASTER LOST`; late joiners
  inherit the frozen frame instead of a runaway ghost timeline). Opening a
  new `?role=master` takes over instantly; the previous master is demoted
  (its page flips to follower) and its stale anchors are rejected, so two
  masters can never fight over the timeline.

Measured on localhost with the beep test clip: a visible follower tracks
within one frame period (≲33 ms); on pause every client converges to the
identical frame (error 0.0 ms).

**Browser throttling caveat**: Chrome suspends rendering (and eventually
freezes JS entirely) in hidden/occluded pages. A hidden follower degrades to
coarse ~1 s tracking via a fallback timer, and resyncs exactly the moment it
is visible again. For wall/kiosk deployments run pages fullscreen and
consider launching Chrome with `--disable-backgrounding-occluded-windows`.
Tabs playing audio (the master) are exempt from freezing.

## Verify it yourself

`test/frames-30fps.mp4` is a 300-frame, 30 fps H.264 clip (GOP 60, B-frames)
with the frame number burned into every frame. Load it, scrub anywhere, step
with ←/→: the burned-in `FRAME n` must always match the FRAME readout.
`test/frames-30fps-audio.mp4` adds an AAC track with a 1 kHz beep at every
second boundary — each beep must land exactly as frames 0, 30, 60, … display.
Regenerate the base clip with:

```sh
ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=10" \
  -vf "drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:\
text='FRAME %{n}':x=(w-tw)/2:y=(h-th)/2:fontsize=96:fontcolor=white:\
box=1:boxcolor=black@0.7:boxborderw=20" \
  -c:v libx264 -pix_fmt yuv420p -g 60 -bf 2 test/frames-30fps.mp4
```

## Controls

| Input | Action |
|---|---|
| Space | play / pause |
| ← / → | step one frame |
| Shift+← / Shift+→ | jump ±1 s |
| Home / End | first / last frame |
| scrubber | frame-accurate scrub (1 frame per step) |
| Go to frame + Enter | jump to an exact frame index |
| 🔁 / L | loop at end of file |
| ⛶ / F | fullscreen (stage only) |

## Files

- `index.html` — UI (no build step, no external requests)
- `server.js` — zero-dep Node: static files, `/sync` WebSocket, `/status`
- `js/mp4box/` — vendored MP4Box.js v2.4.1 (native ES module, bridged to `window.MP4Box`)
- `js/demuxer.js` — MP4Box wrapper → decoder configs + sample tables (video + audio)
- `js/player.js` — `FramePlayer`: decode pipeline, clock hierarchy, seek/step logic
- `js/audio.js` — `AudioEngine`: AudioDecoder → sample-accurate Web Audio scheduling
- `js/syncclient.js` — `SyncClient`: NTP-style shared clock + state exchange
- `js/main.js` — UI wiring, GOP strip, keyboard transport, sync roles

## Current limitations

- Audio codecs: AAC (`mp4a.40.x`, including QuickTime-style sample entries
  with the `esds` nested in a `wave` box or missing entirely — the config is
  repaired from the mdhd timescale and a minimal AudioSpecificConfig is
  synthesized) and MP3-in-MP4 (`mp4a.6b`/`.69`, remapped to WebCodecs'
  `mp3`). With several audio tracks the most decodable one is chosen
  (AAC > MP3 > Opus/FLAC > AC-3). An unsupported or mid-stream-failing
  audio track degrades to silent playback — video and sync are unaffected.
  Opus-in-MP4 would still need `dOps` description extraction.
- Whole file is held in memory (that's what makes random access instant);
  fine up to a few GB, not for streaming. For streaming, the same pipeline
  works with incremental `appendBuffer` + on-demand sample windows.
- MP4/MOV containers only (WebM would need a different demuxer, e.g. jswebm).
- Timecode display assumes constant frame rate (non-drop-frame); the frame
  index and media time are always exact regardless.
- HEVC support depends on platform decoders (Safari yes; Chrome only where
  the OS provides it).
