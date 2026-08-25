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

  const mediaSel = $('media-sel');
  const fileInput = $('file-input');
  const btnPlay = $('btn-play');
  const btnRestart = $('btn-restart');
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
  const filterSel = $('filter-sel');
  const stereoLayoutSel = $('stereo-layout');
  const btnSwapEyes = $('btn-swap-eyes');

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

  let viewport = null;      // normalized tile/crop rect for tiled walls
  let viewportFit = 'fill';
  let wallGrid = null;
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
    mediaSel.disabled = true;
  }

  /** Show a message in the error bar. Non-fatal: playback keeps whatever state it had. */
  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() { errorBox.hidden = true; }

  // ---- readout --------------------------------------------------------

  /**
   * HH:MM:SS:FF from a frame index. Derived from the index and an integer fps
   * rather than from the media timestamp, so the frame field always counts
   * 0..fps-1 exactly — assumes constant, non-drop-frame rate.
   */
  function timecode(index, fps) {
    const ff = index % fps;
    const totalSec = Math.floor(index / fps);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
  }

  /** Player callback: a new frame is on screen — refresh every readout from it. */
  function onFrame(index, tsMicros) {
    tcEl.textContent = timecode(index, fpsInt);
    frameNowEl.textContent = String(index).padStart(String(meta.info.sampleCount - 1).length, '0');
    mediaTimeEl.textContent = (tsMicros / 1e6).toFixed(3) + ' s';
    if (document.activeElement !== slider) slider.value = index;
    drawGopStrip(index);
    if (!player.playing) broadcastNow(); // paused seeks/steps propagate promptly
  }

  /** Player callback: play/pause changed. Forced broadcast — a transition must not be coalesced away. */
  function onPlayState(playing) {
    btnPlay.textContent = playing ? '❚❚' : '▶';
    btnPlay.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    broadcastNow(true);
  }

  /** Player callback: pipeline health line (queue depths, pacing drops, active clock). */
  function onStats(s) {
    statsEl.textContent =
      `decode queue ${s.decodeQueue} · buffered ${s.buffered} · ` +
      `skipped for pacing ${s.dropped} · clock ${s.clock || 'wall'}`;
  }

  // ---- GOP strip: every keyframe in the file, plus the playhead --------

  /**
   * Draw the keyframe map: one tick per sync sample plus the playhead. This is
   * the file's real random-access structure, so the spacing of the ticks is
   * also a readout of what a seek is about to cost. Re-sized to the device
   * pixel ratio each call, since a 1 px tick must not be blurred away.
   */
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

  /**
   * Load a server-relative URL. The whole file is fetched before demuxing —
   * that is what makes every seek instant — so `loadingSrc` guards against a
   * second load starting while one is in flight (a follower can be told to
   * load the same src repeatedly while the first fetch is still running).
   */
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

  /**
   * The one path every load funnels through: demux, configure video and
   * audio, wire the player up, and reset the UI to the new file. Re-applies
   * the pending filter and, for a follower, the last master state, so a file
   * arriving late still lands in the right place with the right look.
   */
  async function loadBuffer(buffer, name, src) {
    clearError();
    dropHint.hidden = false;
    dropHint.textContent = 'Demuxing ' + name + '…';
    try {
      const demuxed = await demuxMP4(buffer);
      meta = demuxed;
      fpsInt = Math.max(1, Math.round(demuxed.info.nominalFps));

      // User settings survive a file change: rate, volume, mute (loop,
      // tile, role, and screen already persist as module state).
      const prevMuted = audioEngine ? audioEngine.muted : false;
      const prevVolume = audioEngine ? audioEngine.volume : Number(volSlider.value) / 100;

      if (player) player.destroy();
      if (audioEngine) audioEngine.destroy();
      player = new FramePlayer(canvas, { onFrame, onPlayState, onStats, onError: (e) => showError(String(e.message || e)) });
      player.setRate(Number(rateSel.value));

      audioEngine = new AudioEngine();
      audioEngine.setVolume(prevVolume);
      audioEngine.setMuted(prevMuted);
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
      applyFilter();
      if (viewport) player.setViewport(viewport, { fit: viewportFit, wallGrid });
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

  /**
   * Publish this master's playback state, rate-limited to ~10 Hz. force=true
   * skips the limiter and is for events that must not be coalesced away
   * (play/pause, a filter change). The seq===0 branch is the join problem: a
   * new master must not stamp its own frame over a timeline that is already
   * running, so it defers to a stored state or waits briefly for one.
   */
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

  /**
   * Send the anchor: where the playhead is, and the shared-clock instant it
   * was there. Followers extrapolate from the pair, so latency on this
   * message cannot shift anyone's playback. Carries the src and the look
   * (filter, amount, layout, eye swap) so a follower can self-configure.
   */
  function sendAnchor() {
    lastBroadcast = performance.now();
    sync.sendState({
      mediaTimeUs: Math.round(player.clockNowUs()),
      atSharedUs: Math.round(sync.sharedNowUs()),
      rate: player.playing ? player.rate : 0,
      playing: player.playing,
      src: loadedSrc,
      filter: filterName,
      swapeyes: swapEyes,
      slayout: stereoLayout,
    });
  }

  /**
   * Follower: adopt a master state. Filter and src changes are handled first
   * because they can require a load; the clock is only followed once the
   * right file is actually in the player, and loadBuffer re-applies the state
   * on arrival. Playing states hand a mapping to followExternal() rather than
   * a position, so the follower keeps tracking between messages.
   */
  async function applyState(s) {
    lastMasterState = s;
    if (s.filter !== undefined && (s.filter !== filterName
        || Boolean(s.swapeyes) !== swapEyes
        || (s.slayout || 'sbs') !== stereoLayout)) {
      filterName = s.filter || 'none';
      swapEyes = Boolean(s.swapeyes);
      stereoLayout = s.slayout || 'sbs';
      applyFilter();
    }
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

  /**
   * Enable exactly what this role may touch. A follower's transport is
   * disabled outright — its timeline belongs to the master, and a local seek
   * would only be overwritten on the next anchor.
   */
  function updateRoleUI() {
    const follower = role === 'follower';
    const haveVideo = Boolean(player && player.frameCount);
    for (const el of [btnPlay, btnRestart, btnBack, btnFwd, btnJumpBack, btnJumpFwd, slider, rateSel, frameGoto, btnLoop]) {
      el.disabled = follower || !haveVideo;
    }
    if (gpuFilter) { // follower filters come from the master
      filterSel.disabled = follower;
      stereoLayoutSel.disabled = follower;
      btnSwapEyes.disabled = follower;
    }
  }

  /** The header's one-line sync readout: role, RTT, and follower error. */
  function renderSyncStatus(s) {
    if (role === 'solo') { syncStatusEl.textContent = ''; return; }
    if (!s || !s.connected) { syncStatusEl.textContent = `○ ${role} · connecting…`; return; }
    const rtt = s.rttMs === null ? '—' : s.rttMs.toFixed(1);
    syncStatusEl.textContent = `● ${role} · rtt ${rtt} ms` +
      (masterLost && role === 'follower' ? ' · MASTER LOST' : '');
  }

  /** Gate every transport control on "a file is loaded", then re-apply role limits. */
  function setControlsEnabled(on) {
    for (const el of [btnPlay, btnRestart, btnBack, btnFwd, btnJumpBack, btnJumpFwd, slider, rateSel, frameGoto, btnLoop]) {
      el.disabled = !on;
    }
  }
  setControlsEnabled(false);

  // ---- controls ---------------------------------------------------------

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  // ---- media picker: server files + recent local files + browse ---------

  const hasFSAccess = 'showOpenFilePicker' in window;
  let serverMedia = []; // [{src, size}] from GET /media
  let recents = [];     // [{name, handle, usedAt}] from IndexedDB

  const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';

  /** Rebuild the picker: server media, then recent local files, then Browse…. */
  function populateMediaSel() {
    mediaSel.innerHTML = '';
    mediaSel.append(new Option('Open video…', ''));
    if (serverMedia.length) {
      const g = document.createElement('optgroup');
      g.label = 'Server media';
      for (const m of serverMedia) g.append(new Option(`${m.src} · ${fmtSize(m.size)}`, 'src:' + m.src));
      mediaSel.append(g);
    }
    if (recents.length) {
      const g = document.createElement('optgroup');
      g.label = 'Recent local files';
      for (const r of recents.slice(0, 8)) g.append(new Option(r.name, 'recent:' + r.name));
      mediaSel.append(g);
    }
    mediaSel.append(new Option('Browse…', 'browse'));
    mediaSel.value = '';
  }

  /**
   * Ask the server what it can serve. Failure is expected and silent — the
   * page also runs off plain static hosting with no /media endpoint, where the
   * picker is still useful for local files.
   */
  async function refreshServerMedia() {
    try {
      const r = await fetch('media'); // relative: works behind path prefixes
      if (r.ok) { serverMedia = await r.json(); populateMediaSel(); }
    } catch (e) { /* solo static hosting has no /media — picker still works */ }
  }

  // Recent local files persist as File System Access handles in IndexedDB
  // (Chromium). Reopening one asks a one-click read permission per session.
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('framesync', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('recents', { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Read the recents list, newest first. Any failure degrades to an empty list. */
  async function loadRecents() {
    if (!hasFSAccess) return;
    try {
      const db = await idb();
      recents = await new Promise((resolve, reject) => {
        const req = db.transaction('recents').objectStore('recents').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      recents.sort((a, b) => b.usedAt - a.usedAt);
      populateMediaSel();
    } catch (e) { recents = []; }
  }

  /**
   * Record a file handle as recently used and trim the list to eight. Wholly
   * best-effort: a failure here must never interfere with the load that
   * prompted it, so everything is swallowed.
   */
  async function rememberRecent(handle) {
    if (!hasFSAccess || !handle) return;
    try {
      const db = await idb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('recents', 'readwrite');
        const store = tx.objectStore('recents');
        store.put({ name: handle.name, handle, usedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      await loadRecents();
      if (recents.length > 8) { // trim oldest
        const db2 = await idb();
        const tx = db2.transaction('recents', 'readwrite');
        for (const r of recents.slice(8)) tx.objectStore('recents').delete(r.name);
      }
    } catch (e) { /* recents are best-effort */ }
  }

  /**
   * Browse for a file. Prefers showOpenFilePicker, whose handle can be stored
   * and reopened later; falls back to a plain <input type=file> elsewhere,
   * which loads fine but cannot be remembered.
   */
  async function openLocal() {
    if (!hasFSAccess) { fileInput.click(); return; }
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.m4v'] } }],
      });
    } catch (e) { return; } // cancelled
    rememberRecent(handle);
    await loadFile(await handle.getFile());
  }

  /**
   * Reopen a stored handle. Read permission does not survive the session, so a
   * re-grant is requested; a declined prompt is a silent no-op, while a moved
   * or deleted file is reported — the user needs to know why it did not open.
   */
  async function openRecent(name) {
    const rec = recents.find((r) => r.name === name);
    if (!rec) return;
    try {
      let perm = await rec.handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await rec.handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return;
      rememberRecent(rec.handle);
      await loadFile(await rec.handle.getFile());
    } catch (e) {
      showError(`Could not reopen ${name}: ${e.message || e}`);
    }
  }

  mediaSel.addEventListener('pointerdown', () => refreshServerMedia());
  mediaSel.addEventListener('change', () => {
    const v = mediaSel.value;
    mediaSel.value = '';
    if (v === 'browse') openLocal();
    else if (v.startsWith('src:')) loadFromUrl(v.slice(4)).catch((e) => showError(String(e.message || e)));
    else if (v.startsWith('recent:')) openRecent(v.slice(7));
  });

  refreshServerMedia();
  loadRecents();
  populateMediaSel();

  btnPlay.addEventListener('click', () => player?.toggle());
  btnRestart.addEventListener('click', () => player?.seekToFrame(0));
  btnBack.addEventListener('click', () => player?.stepBack());
  btnFwd.addEventListener('click', () => player?.stepForward());
  btnJumpBack.addEventListener('click', () => jumpSeconds(-1));
  btnJumpFwd.addEventListener('click', () => jumpSeconds(1));
  rateSel.addEventListener('change', () => player?.setRate(Number(rateSel.value)));

  // ---- GPU filters (WebGPU) ----------------------------------------------

  const FILTER_IDS = {
    none: 0, grayscale: 1, sepia: 2, invert: 3, swirl: 4,
    stereo: 5, anaglyph: 6, 'anaglyph-dubois': 7,
    'left-eye': 8, 'right-eye': 9,
  };
  // Stereo filters read a packed eye pair, so they all take the layout menu
  // and the eye swap, and none use the amount slider. Only the interlace
  // needs pixel-exact rows; the anaglyphs and the single-eye views tolerate
  // scaling freely.
  const STEREO_KIND = {
    stereo: 'interlace', anaglyph: 'anaglyph', 'anaglyph-dubois': 'anaglyph',
    'left-eye': 'eye', 'right-eye': 'eye',
  };
  // How the source packs the pair — orthogonal to the technique above, which
  // is why it is its own menu rather than a filter per combination.
  const LAYOUT_IDS = {
    sbs: GPUFilter.LAYOUT_SBS,
    'half-sbs': GPUFilter.LAYOUT_HALF_SBS,
    tb: GPUFilter.LAYOUT_TB,
  };
  let gpuFilter = null;
  let filterName = 'none';
  let swapEyes = false;
  let stereoLayout = 'sbs';

  (async () => {
    if (!GPUFilter.supported) { disableFilterUI('WebGPU not available in this browser'); return; }
    gpuFilter = new GPUFilter();
    if (!(await gpuFilter.init())) {
      gpuFilter = null;
      disableFilterUI('WebGPU initialization failed');
    }
  })();

  /** No usable WebGPU: grey the filter controls out and say so in the tooltip. */
  function disableFilterUI(why) {
    filterSel.disabled = true;
    stereoLayoutSel.disabled = true;
    btnSwapEyes.disabled = true;
    filterSel.title = why;
  }

  /**
   * Push the filter state into both the UI and the player, and the single
   * place either is allowed to change. Called on every edit and after every
   * load — the settings are page state, not per-file state, so they survive a
   * file change. Redraws when paused, since nothing else would.
   */
  function applyFilter() {
    filterSel.value = filterName;
    const kind = STEREO_KIND[filterName] || null;
    stereoLayoutSel.value = stereoLayout;
    stereoLayoutSel.hidden = !kind;
    btnSwapEyes.hidden = !kind;
    btnSwapEyes.classList.toggle('active', swapEyes);
    btnSwapEyes.setAttribute('aria-pressed', String(swapEyes));
    canvas.classList.toggle('stereo', kind === 'interlace');
    if (!player) return;
    if (gpuFilter && filterName !== 'none' && FILTER_IDS[filterName]) {
      gpuFilter.set(FILTER_IDS[filterName], swapEyes, LAYOUT_IDS[stereoLayout]);
      player.filterFn = (f) => gpuFilter.apply(f);
    } else {
      player.filterFn = null;
    }
    if (!player.playing) player.redraw();
  }

  filterSel.addEventListener('change', () => {
    filterName = filterSel.value;
    applyFilter();
    broadcastNow(true);
  });
  stereoLayoutSel.addEventListener('change', () => {
    stereoLayout = stereoLayoutSel.value;
    applyFilter();
    broadcastNow(true);
  });
  btnSwapEyes.addEventListener('click', () => {
    swapEyes = !swapEyes;
    applyFilter();
    broadcastNow(true);
  });

  /** Set looping on the player and the button together (they can drift otherwise). */
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

  /**
   * Get the display list, requesting it at most once and caching it. The call
   * prompts for permission, so callers must be inside a user gesture; a
   * refusal returns null and fullscreen falls back to the current display.
   */
  async function ensureScreens() {
    if (!hasWindowMgmt) return null;
    if (!screenDetails) {
      try { screenDetails = await window.getScreenDetails(); } catch (e) { return null; }
      screenDetails.addEventListener('screenschange', populateScreenSel);
      populateScreenSel();
    }
    return screenDetails;
  }

  /**
   * Rebuild the display list, keeping the current pick where possible — this
   * also runs on 'screenschange', and a monitor being plugged in must not
   * silently retarget a wall node's fullscreen.
   */
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

  /**
   * Take the stage fullscreen, on the chosen display when one is selected and
   * permitted. Browsers only grant fullscreen inside a gesture, so a refusal
   * is swallowed: the ?fullscreen path retries on the first real interaction.
   */
  async function enterFullscreen() {
    let opts;
    if (desiredScreen !== null) {
      const d = await ensureScreens();
      if (d && d.screens[desiredScreen]) opts = { screen: d.screens[desiredScreen] };
    }
    try { await stage.requestFullscreen(opts); } catch (e) { /* no gesture yet */ }
  }

  /** Fullscreen toggle behind both the ⛶ button and the F key. */
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
    // Grab the handle synchronously (dataTransfer dies after the event) so
    // dropped files land in the recents list; fall back to the plain File.
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    const handlePromise = item && item.getAsFileSystemHandle
      ? item.getAsFileSystemHandle().catch(() => null) : null;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (handlePromise) {
      handlePromise.then((h) => { if (h && h.kind === 'file') rememberRecent(h); });
    }
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
  // ?fit=contain (default with ?tile) aspect-fits the video into the wall's
  // combined surface — letterboxed globally, never distorted; ?fit=fill
  // stretches the slice edge-to-edge (for content pre-matched to the wall).
  // ?wall=cols,rows supplies wall geometry when using ?crop with contain.
  const paramTile = params.get('tile');
  if (paramTile) {
    const [col, row, cols, rows] = paramTile.split(',').map(Number);
    if (cols >= 1 && rows >= 1 && col >= 0 && col < cols && row >= 0 && row < rows) {
      viewport = { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows };
      wallGrid = { cols, rows };
      viewportFit = 'contain';
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
  const paramWall = params.get('wall');
  if (paramWall) {
    const [cols, rows] = paramWall.split(',').map(Number);
    if (cols >= 1 && rows >= 1) wallGrid = { cols, rows };
  }
  const paramFit = params.get('fit');
  if (paramFit === 'contain' || paramFit === 'fill') viewportFit = paramFit;
  if (viewport && viewportFit === 'contain') viewportLabel += ' · contain';
  if (viewport) stage.classList.add('tiled');

  if (params.has('loop')) setLoop(true);
  let paramFilter = params.get('filter');
  const paramLayout = params.get('slayout');
  if (paramLayout && paramLayout in LAYOUT_IDS) {
    stereoLayout = paramLayout;
  } else if (paramFilter && paramFilter.endsWith('-half')) {
    // Legacy kiosk URLs: the half-SBS variants used to be separate filters.
    paramFilter = paramFilter.slice(0, -'-half'.length);
    stereoLayout = 'half-sbs';
  }
  if (paramFilter && paramFilter in FILTER_IDS) {
    filterName = paramFilter;
    swapEyes = params.has('swapeyes');
    applyFilter();
  }
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
