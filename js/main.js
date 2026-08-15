'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const stage = $('stage');
  const canvas = $('screen');
  const dropHint = $('drop-hint');
  const errorBox = $('error');

  const tcEl = $('timecode');
  const frameNowEl = $('frame-now');
  const frameTotalEl = $('frame-total');
  const mediaTimeEl = $('media-time');

  const btnOpen = $('btn-open');
  const fileInput = $('file-input');
  const btnPlay = $('btn-play');
  const btnBack = $('btn-back');
  const btnFwd = $('btn-fwd');
  const btnJumpBack = $('btn-jump-back');
  const btnJumpFwd = $('btn-jump-fwd');
  const rateSel = $('rate');
  const frameGoto = $('frame-goto');
  const btnMute = $('btn-mute');
  const volSlider = $('volume');
  const btnFs = $('btn-fs');
  const btnLoop = $('btn-loop');
  let loopOn = false;

  const slider = $('scrubber');
  const gopCanvas = $('gop-strip');
  const infoEl = $('file-info');
  const statsEl = $('stats');
  const roleSel = $('role');
  const syncStatusEl = $('sync-status');

  let player = null;
  let audioEngine = null;
  let hasAudio = false;
  let meta = null; // demux result for the loaded file
  let fpsInt = 25;

  let viewport = null;      // normalized crop for tiled walls
  let viewportLabel = '';
  let sync = null;
  let role = 'solo';
  let loadedSrc = null;      // server-relative URL the file came from, if any
  let lastMasterState = null;
  let loadingSrc = false;
  let broadcastTimer = null;
  let lastBroadcast = 0;
  let masterLost = false;
  let adopting = false; // master is joining an existing timeline; hold anchors
  let masterSince = 0;  // when this page became master (for the first-anchor grace)

  // ---- capability gate -----------------------------------------------

  if (!('VideoDecoder' in window)) {
    showError('This browser has no WebCodecs support. Use a current Chrome, Edge, or Safari 16.4+.');
    btnOpen.disabled = true;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() { errorBox.hidden = true; }

  // ---- readout --------------------------------------------------------

  function timecode(index, fps) {
    const ff = index % fps;
    const totalSec = Math.floor(index / fps);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
  }

  function onFrame(index, tsMicros) {
    tcEl.textContent = timecode(index, fpsInt);
    frameNowEl.textContent = String(index).padStart(String(meta.info.sampleCount - 1).length, '0');
    mediaTimeEl.textContent = (tsMicros / 1e6).toFixed(3) + ' s';
    if (document.activeElement !== slider) slider.value = index;
    drawGopStrip(index);
    if (!player.playing) broadcastNow(); // paused seeks/steps propagate promptly
  }

  function onPlayState(playing) {
    btnPlay.textContent = playing ? '❚❚' : '▶';
    btnPlay.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    broadcastNow(true);
  }

  function onStats(s) {
    statsEl.textContent =
      `decode queue ${s.decodeQueue} · buffered ${s.buffered} · ` +
      `skipped for pacing ${s.dropped} · clock ${s.clock || 'wall'}`;
  }

  // ---- GOP strip: every keyframe in the file, plus the playhead --------

  function drawGopStrip(currentIndex) {
    if (!meta) return;
    const dpr = window.devicePixelRatio || 1;
    const w = gopCanvas.clientWidth, h = gopCanvas.clientHeight;
    if (gopCanvas.width !== w * dpr || gopCanvas.height !== h * dpr) {
      gopCanvas.width = w * dpr;
      gopCanvas.height = h * dpr;
    }
    const g = gopCanvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const n = player.frameCount;
    // Keyframe ticks — the real random-access points of this file.
    g.fillStyle = 'rgba(255, 179, 0, 0.55)';
    for (let i = 0; i < n; i++) {
      if (player.samples[player.presOrder[i]] && player.samples[player.presOrder[i]].isKey) {
        g.fillRect((i / (n - 1 || 1)) * (w - 1), 2, 1, h - 4);
      }
    }
    // Playhead.
    g.fillStyle = '#ffb300';
    g.fillRect((currentIndex / (n - 1 || 1)) * (w - 2), 0, 2, h);
  }

  // ---- loading ---------------------------------------------------------

  async function loadFile(file) {
    return loadBuffer(await file.arrayBuffer(), file.name, null);
  }

  async function loadFromUrl(src) {
    loadingSrc = true; // one URL load at a time, whoever initiates it
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`Could not fetch ${src} (${resp.status})`);
      return await loadBuffer(await resp.arrayBuffer(), src.split('/').pop(), src);
    } finally {
      loadingSrc = false;
    }
  }

  async function loadBuffer(buffer, name, src) {
    clearError();
    dropHint.hidden = false;
    dropHint.textContent = 'Demuxing ' + name + '…';
    try {
      const demuxed = await demuxMP4(buffer);
      meta = demuxed;
      fpsInt = Math.max(1, Math.round(demuxed.info.nominalFps));

      if (player) player.destroy();
      if (audioEngine) audioEngine.destroy();
      player = new FramePlayer(canvas, { onFrame, onPlayState, onStats, onError: (e) => showError(String(e.message || e)) });

      audioEngine = new AudioEngine();
      hasAudio = demuxed.audio
        ? await audioEngine.load(demuxed.audio.config, demuxed.audio.samples)
        : false;
      if (hasAudio) player.attachAudio(audioEngine);

      await player.load(demuxed.video.config, demuxed.video.samples);

      // Handy for sync experiments from the console / other pages.
      window.vsPlayer = player;
      window.vsAudio = audioEngine;

      const i = demuxed.info;
      const keyframes = demuxed.video.samples.filter((s) => s.isKey).length;
      const audioLabel = hasAudio
        ? `${i.audio.codec} ${(i.audio.sampleRate / 1000).toFixed(1)} kHz ${i.audio.channels} ch`
        : (i.audio ? `${i.audio.codec} audio unsupported` : 'no audio');
      infoEl.textContent =
        `${name} · ${i.codec} · ${i.width}×${i.height} · ` +
        `${i.nominalFps.toFixed(3)} fps · ${i.sampleCount} frames · ` +
        `${keyframes} keyframes · ${i.durationSec.toFixed(3)} s · ${audioLabel}` +
        (viewportLabel ? ` · ${viewportLabel}` : '');

      frameTotalEl.textContent = i.sampleCount - 1;
      slider.max = i.sampleCount - 1;
      slider.value = 0;
      frameGoto.max = i.sampleCount - 1;
      dropHint.hidden = true;
      stage.classList.add('loaded');
      setControlsEnabled(true);
      btnMute.disabled = !hasAudio;
      volSlider.disabled = !hasAudio;
      btnMute.textContent = hasAudio && audioEngine.muted ? '🔇' : '🔊';
      player.loop = loopOn;
      if (viewport) player.setViewport(viewport);
      loadedSrc = src;
      updateRoleUI();
      if (role === 'follower' && lastMasterState) applyState(lastMasterState);
      if (role === 'master') {
        if (lastMasterState && sync && sync.seq === 0) adoptState(lastMasterState);
        else broadcastNow(true);
      }
    } catch (err) {
      dropHint.hidden = false;
      dropHint.textContent = 'Drop an MP4 here, or choose a file.';
      showError(String(err.message || err));
    }
  }

  // ---- sync roles -------------------------------------------------------

  function setRole(newRole) {
    role = newRole;
    roleSel.value = newRole;
    if (sync) { sync.close(); sync = null; }
    clearInterval(broadcastTimer);
    broadcastTimer = null;
    lastMasterState = null;
    if (player) player.stopExternal();

    if (role !== 'solo') {
      sync = new SyncClient(role, {
        onState: (s) => {
          masterLost = false;
          if (role === 'follower') applyState(s);
          // A master that has not yet anchored anything adopts the ongoing
          // timeline instead of resetting it (the server sends the stored
          // state right after the grant).
          else if (role === 'master' && sync && sync.seq === 0) adoptState(s);
        },
        onStatus: renderSyncStatus,
        onDemoted: () => {
          if (role === 'master') {
            setRole('follower');
            showError('Another client claimed master — this page is now a follower.');
          }
        },
        onMasterLost: () => {
          masterLost = true;
          renderSyncStatus(sync);
        },
      });
      sync.connect();
      sync.setReporter(() => ({
        frame: player ? player.currentIndex : -1,
        mediaUs: player && player.currentFrame ? player.currentFrame.timestamp : 0,
        sharedUs: sync.sharedNowUs(),
      }));
      if (role === 'master') {
        masterSince = performance.now();
        // Periodic re-anchor: keeps followers locked to the master's actual
        // clock (audio hardware) even as it drifts from the wall clock.
        broadcastTimer = setInterval(() => broadcastNow(true), 500);
      }
    }
    updateRoleUI();
    renderSyncStatus(sync);
  }

  /**
   * A (re)joining master resumes the wall's current position instead of
   * resetting it: seek to where the mapping says the timeline is now, keep
   * playing if it was playing, and only then start anchoring from here.
   */
  async function adoptState(s) {
    lastMasterState = s;
    if (s.src && s.src !== loadedSrc) {
      // Not loaded yet. If a load is already in flight (e.g. the ?src param
      // fetch), do NOT start a second one — loadBuffer re-runs adoption when
      // it finishes.
      if (!loadingSrc) loadFromUrl(s.src).catch((err) => showError(String(err.message || err)));
      return;
    }
    if (!player || !player.frameCount || adopting) return;
    adopting = true;
    try {
      const playing = s.playing && s.rate > 0;
      const nowUs = playing
        ? s.mediaTimeUs + (sync.sharedNowUs() - s.atSharedUs) * s.rate
        : s.mediaTimeUs;
      await player.seekToFrame(player._indexForTime(nowUs));
      if (playing) {
        player.setRate(s.rate);
        rateSel.value = String(s.rate);
        player.play();
      }
    } finally {
      adopting = false;
    }
    // Adoption complete — this is deliberately the master's first anchor,
    // bypassing the not-yet-adopted gate below.
    if (sync && sync.connected && player && player.frameCount) sendAnchor();
  }

  function broadcastNow(force = false) {
    if (adopting) return;
    if (role !== 'master' || !sync || !sync.connected || !player || !player.frameCount) return;
    if (sync.seq === 0) {
      // No anchor sent yet. If a stored state has arrived, adoption owns the
      // first anchor — never stamp our own frame over the running timeline.
      if (lastMasterState) return;
      // Otherwise grace-wait so the server's stored state (if any) can
      // arrive; a genuinely fresh server has none and we anchor after it.
      if (performance.now() - masterSince < 1500) return;
    }
    const now = performance.now();
    if (!force && now - lastBroadcast < 100) return;
    sendAnchor();
  }

  function sendAnchor() {
    lastBroadcast = performance.now();
    sync.sendState({
      mediaTimeUs: Math.round(player.clockNowUs()),
      atSharedUs: Math.round(sync.sharedNowUs()),
      rate: player.playing ? player.rate : 0,
      playing: player.playing,
      src: loadedSrc,
    });
  }

  async function applyState(s) {
    lastMasterState = s;
    if (s.src && s.src !== loadedSrc) {
      if (!loadingSrc) loadFromUrl(s.src).catch((err) => showError(String(err.message || err)));
      return; // loadBuffer re-applies lastMasterState once loaded
    }
    if (!player || !player.frameCount || !sync) return;
    if (s.playing && s.rate > 0) {
      player.followExternal(() =>
        s.mediaTimeUs + (sync.sharedNowUs() - s.atSharedUs) * s.rate);
    } else {
      player.stopExternal();
      const target = player._indexForTime(s.mediaTimeUs);
      if (target !== player.currentIndex) player.seekToFrame(target);
    }
  }

  function updateRoleUI() {
    const follower = role === 'follower';
    const haveVideo = Boolean(player && player.frameCount);
    for (const el of [btnPlay, btnBack, btnFwd, btnJumpBack, btnJumpFwd, slider, rateSel, frameGoto, btnLoop]) {
      el.disabled = follower || !haveVideo;
    }
  }

  function renderSyncStatus(s) {
    if (role === 'solo') { syncStatusEl.textContent = ''; return; }
    if (!s || !s.connected) { syncStatusEl.textContent = `○ ${role} · connecting…`; return; }
    const rtt = s.rttMs === null ? '—' : s.rttMs.toFixed(1);
    syncStatusEl.textContent = `● ${role} · rtt ${rtt} ms` +
      (masterLost && role === 'follower' ? ' · MASTER LOST' : '');
  }

  function setControlsEnabled(on) {
    for (const el of [btnPlay, btnBack, btnFwd, btnJumpBack, btnJumpFwd, slider, rateSel, frameGoto, btnLoop]) {
      el.disabled = !on;
    }
  }
  setControlsEnabled(false);

  // ---- controls ---------------------------------------------------------

  btnOpen.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  btnPlay.addEventListener('click', () => player?.toggle());
  btnBack.addEventListener('click', () => player?.stepBack());
  btnFwd.addEventListener('click', () => player?.stepForward());
  btnJumpBack.addEventListener('click', () => jumpSeconds(-1));
  btnJumpFwd.addEventListener('click', () => jumpSeconds(1));
  rateSel.addEventListener('change', () => player?.setRate(Number(rateSel.value)));

  function setLoop(on) {
    loopOn = on;
    if (player) player.loop = on;
    btnLoop.classList.toggle('active', on);
    btnLoop.setAttribute('aria-pressed', String(on));
  }
  btnLoop.addEventListener('click', () => setLoop(!loopOn));

  btnMute.addEventListener('click', () => {
    if (!audioEngine) return;
    audioEngine.setMuted(!audioEngine.muted);
    btnMute.textContent = audioEngine.muted ? '🔇' : '🔊';
  });
  volSlider.addEventListener('input', () => {
    if (audioEngine) audioEngine.setVolume(Number(volSlider.value) / 100);
  });

  // Jumps and scrubs preserve the play state — a playing video keeps playing
  // from the new position. Only single-frame stepping (◀︎/▶︎, arrows) pauses.
  function jumpSeconds(sec) {
    if (!player) return;
    player.seekRelative(Math.round(sec * fpsInt));
  }

  slider.addEventListener('input', () => {
    if (!player) return;
    player.seekToFrame(Number(slider.value));
  });
  // Release focus after a mouse/touch scrub so the play loop resumes moving
  // the thumb (it leaves a focused slider alone while the user is on it).
  slider.addEventListener('pointerup', () => slider.blur());

  frameGoto.addEventListener('focus', () => frameGoto.select());
  frameGoto.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && player && frameGoto.value !== '') {
      player.seekToFrame(Number(frameGoto.value));
      frameGoto.blur();
    }
  });

  // Fullscreen shows the stage only (pure video, no console) — works in any
  // role, including followers, whose transport is otherwise locked.
  // With the Window Management API (Chromium, secure context) it can target
  // a specific display: pick one in the selector or pass ?screen=N.
  const screenSel = $('screen-sel');
  let desiredScreen = null; // null = whatever screen the window is on
  let screenDetails = null;
  const hasWindowMgmt = 'getScreenDetails' in window;
  if (!hasWindowMgmt) screenSel.hidden = true;

  async function ensureScreens() {
    if (!hasWindowMgmt) return null;
    if (!screenDetails) {
      try { screenDetails = await window.getScreenDetails(); } catch (e) { return null; }
      screenDetails.addEventListener('screenschange', populateScreenSel);
      populateScreenSel();
    }
    return screenDetails;
  }

  function populateScreenSel() {
    if (!screenDetails) return;
    const prev = screenSel.value;
    screenSel.innerHTML = '';
    screenSel.append(new Option('current screen', 'auto'));
    screenDetails.screens.forEach((s, i) => {
      const label = `${i}: ${s.label || s.width + '×' + s.height}${s.isPrimary ? ' ★' : ''}`;
      screenSel.append(new Option(label, String(i)));
    });
    if ([...screenSel.options].some((o) => o.value === prev)) screenSel.value = prev;
    else if (desiredScreen !== null && screenDetails.screens[desiredScreen]) {
      screenSel.value = String(desiredScreen);
    }
  }

  // Enumerating displays prompts for permission, so do it lazily inside a
  // real gesture: the first time the selector is opened.
  screenSel.addEventListener('pointerdown', () => { ensureScreens(); });
  screenSel.addEventListener('change', () => {
    desiredScreen = screenSel.value === 'auto' ? null : Number(screenSel.value);
    if (document.fullscreenElement) enterFullscreen(); // move it live
  });

  async function enterFullscreen() {
    let opts;
    if (desiredScreen !== null) {
      const d = await ensureScreens();
      if (d && d.screens[desiredScreen]) opts = { screen: d.screens[desiredScreen] };
    }
    try { await stage.requestFullscreen(opts); } catch (e) { /* no gesture yet */ }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else enterFullscreen();
  }
  btnFs.addEventListener('click', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'f' || e.key === 'F') && e.target !== frameGoto && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggleFullscreen();
    }
  });

  roleSel.addEventListener('change', () => setRole(roleSel.value));

  // Keyboard transport.
  window.addEventListener('keydown', (e) => {
    if (!player || role === 'follower' || e.target === frameGoto || e.target === slider) return;
    switch (e.key) {
      case ' ': e.preventDefault(); player.toggle(); break;
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? jumpSeconds(-1) : player.stepBack(); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? jumpSeconds(1) : player.stepForward(); break;
      case 'Home': e.preventDefault(); player.seekToFrame(0); break;
      case 'End': e.preventDefault(); player.seekToFrame(player.frameCount - 1); break;
      case 'l': case 'L': e.preventDefault(); setLoop(!loopOn); break;
    }
  });

  // Drag & drop.
  for (const ev of ['dragover', 'dragenter']) {
    stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('dragging'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove('dragging'); });
  }
  stage.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  window.addEventListener('resize', () => {
    if (player && player.currentIndex >= 0) drawGopStrip(player.currentIndex);
  });

  // ---- startup from URL params: ?role=master|follower&src=test/foo.mp4 ---
  const params = new URLSearchParams(location.search);
  const paramRole = params.get('role');
  if (paramRole === 'master' || paramRole === 'follower') setRole(paramRole);
  // Tiled-wall crop: ?tile=col,row,cols,rows (grid slice) or
  // ?crop=x,y,w,h (normalized 0–1 rect; wins over tile — use it for
  // bezel-compensated insets). Decode is full-frame; only the blit crops.
  const paramTile = params.get('tile');
  if (paramTile) {
    const [col, row, cols, rows] = paramTile.split(',').map(Number);
    if (cols >= 1 && rows >= 1 && col >= 0 && col < cols && row >= 0 && row < rows) {
      viewport = { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows };
      viewportLabel = `tile ${col},${row} of ${cols}×${rows}`;
    }
  }
  const paramCrop = params.get('crop');
  if (paramCrop) {
    const [x, y, w, h] = paramCrop.split(',').map(Number);
    if (w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1) {
      viewport = { x, y, w, h };
      viewportLabel = `crop ${x},${y} ${w}×${h}`;
    }
  }
  if (viewport) stage.classList.add('tiled');

  if (params.has('loop')) setLoop(true);
  const paramSrc = params.get('src');
  if (paramSrc) loadFromUrl(paramSrc).catch((e) => showError(String(e.message || e)));

  // ?screen=N: display index used for fullscreen (Window Management API).
  const paramScreen = params.get('screen');
  if (paramScreen !== null && hasWindowMgmt) {
    desiredScreen = Number(paramScreen);
    screenSel.value = ''; // reflected once displays are enumerated
  }

  // ?fullscreen (or ?fs): browsers only grant fullscreen from a user
  // gesture, so try right away and otherwise arm a one-shot: the first
  // click or keypress anywhere takes the stage fullscreen (on the
  // ?screen=N display when set — the first use may need a second gesture
  // if the display-permission prompt consumes the first one).
  if (params.has('fullscreen') || params.has('fs')) {
    enterFullscreen();
    const once = () => {
      if (!document.fullscreenElement) enterFullscreen();
    };
    window.addEventListener('pointerdown', once, { once: true });
    window.addEventListener('keydown', once, { once: true });
  }
})();
