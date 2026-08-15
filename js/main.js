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

  let sync = null;
  let role = 'solo';
  let loadedSrc = null;      // server-relative URL the file came from, if any
  let lastMasterState = null;
  let loadingSrc = false;
  let broadcastTimer = null;
  let lastBroadcast = 0;

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
    mediaTimeEl.textContent = (tsMicros / 1e6).toFixed(6) + ' s';
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
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`Could not fetch ${src} (${resp.status})`);
    return loadBuffer(await resp.arrayBuffer(), src.split('/').pop(), src);
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
        : (demuxed.audio ? 'audio track unsupported' : 'no audio');
      infoEl.textContent =
        `${name} · ${i.codec} · ${i.width}×${i.height} · ` +
        `${i.nominalFps.toFixed(3)} fps · ${i.sampleCount} frames · ` +
        `${keyframes} keyframes · ${i.durationSec.toFixed(3)} s · ${audioLabel}`;

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
      loadedSrc = src;
      updateRoleUI();
      if (role === 'follower' && lastMasterState) applyState(lastMasterState);
      if (role === 'master') broadcastNow(true);
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
        onState: (s) => { if (role === 'follower') applyState(s); },
        onStatus: renderSyncStatus,
      });
      sync.connect();
      sync.setReporter(() => ({
        frame: player ? player.currentIndex : -1,
        mediaUs: player && player.currentFrame ? player.currentFrame.timestamp : 0,
        sharedUs: sync.sharedNowUs(),
      }));
      if (role === 'master') {
        // Periodic re-anchor: keeps followers locked to the master's actual
        // clock (audio hardware) even as it drifts from the wall clock.
        broadcastTimer = setInterval(() => broadcastNow(true), 500);
      }
    }
    updateRoleUI();
    renderSyncStatus(sync);
  }

  function broadcastNow(force = false) {
    if (role !== 'master' || !sync || !sync.connected || !player || !player.frameCount) return;
    const now = performance.now();
    if (!force && now - lastBroadcast < 100) return;
    lastBroadcast = now;
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
    if (s.src && s.src !== loadedSrc && !loadingSrc) {
      loadingSrc = true;
      try { await loadFromUrl(s.src); }
      catch (err) { showError(String(err.message || err)); }
      finally { loadingSrc = false; }
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
    for (const el of [btnPlay, btnBack, btnFwd, btnJumpBack, btnJumpFwd, slider, rateSel, frameGoto]) {
      el.disabled = follower || !haveVideo;
    }
  }

  function renderSyncStatus(s) {
    if (role === 'solo') { syncStatusEl.textContent = ''; return; }
    if (!s || !s.connected) { syncStatusEl.textContent = `○ ${role} · connecting…`; return; }
    const rtt = s.rttMs === null ? '—' : s.rttMs.toFixed(1);
    syncStatusEl.textContent = `● ${role} · rtt ${rtt} ms`;
  }

  function setControlsEnabled(on) {
    for (const el of [btnPlay, btnBack, btnFwd, btnJumpBack, btnJumpFwd, slider, rateSel, frameGoto]) {
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

  btnMute.addEventListener('click', () => {
    if (!audioEngine) return;
    audioEngine.setMuted(!audioEngine.muted);
    btnMute.textContent = audioEngine.muted ? '🔇' : '🔊';
  });
  volSlider.addEventListener('input', () => {
    if (audioEngine) audioEngine.setVolume(Number(volSlider.value) / 100);
  });

  function jumpSeconds(sec) {
    if (!player) return;
    player.pause();
    player.seekRelative(Math.round(sec * fpsInt));
  }

  slider.addEventListener('input', () => {
    if (!player) return;
    player.pause();
    player.seekToFrame(Number(slider.value));
  });

  frameGoto.addEventListener('focus', () => frameGoto.select());
  frameGoto.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && player && frameGoto.value !== '') {
      player.pause();
      player.seekToFrame(Number(frameGoto.value));
      frameGoto.blur();
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
      case 'Home': e.preventDefault(); player.pause(); player.seekToFrame(0); break;
      case 'End': e.preventDefault(); player.pause(); player.seekToFrame(player.frameCount - 1); break;
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
  const paramSrc = params.get('src');
  if (paramSrc) loadFromUrl(paramSrc).catch((e) => showError(String(e.message || e)));
})();
