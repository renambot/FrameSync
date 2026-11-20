'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const stage = $('stage');
  const canvas = $('screen');
  const dropHint = $('drop-hint');
  const spinner = $('spinner');
  let loading = false; // a file's index is being read: the big spinner owns the stage
  const errorBox = $('error');

  const tcEl = $('timecode');
  const frameNowEl = $('frame-now');
  const frameTotalEl = $('frame-total');
  const mediaTimeEl = $('media-time');

  const btnOpen = $('btn-open');
  const mediaMenu = $('media-menu');
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
  const btnIn = $('btn-in');
  const btnOut = $('btn-out');
  const btnClearRange = $('btn-clear-range');
  let loopOn = false;
  const filterSel = $('filter-sel');
  const stereoLayoutSel = $('stereo-layout');
  const convWrap = $('conv-wrap');
  const convInput = $('stereo-conv');
  const btnSwapEyes = $('btn-swap-eyes');

  const slider = $('scrubber');
  const gopCanvas = $('gop-strip');
  const infoEl = $('file-info');
  const statsEl = $('stats');
  const roleSel = $('role');
  const syncStatusEl = $('sync-status');
  const btnCopyUrl = $('btn-copy-url');

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
    btnOpen.disabled = true;
  }

  /** Show a message in the error bar. Non-fatal: playback keeps whatever state it had. */
  function showError(msg) {
    errorBox.hidden = false; // unhide first: an alert region announces text set after it is live
    errorBox.textContent = msg;
  }
  function clearError() { errorBox.hidden = true; }

  /**
   * Say something to screen readers without showing it. Only for transitions
   * (file loaded, URL copied, master lost or back, role changed) — never for
   * the sync readout, which rewrites itself with the RTT on every sample and
   * would be read out continuously.
   */
  const announceEl = $('announce');
  function announce(msg) {
    announceEl.textContent = '';
    setTimeout(() => { announceEl.textContent = msg; }, 50); // re-announce identical text
  }

  // ---- control hints --------------------------------------------------
  //
  // Every button's shortcut hint lives in `title`, which keyboard and touch
  // users never see. Where the browser has interest invokers, each title moves
  // into a popover="hint" element the button points at with `interestfor`,
  // which shows on hover and focus and wires the description for assistive
  // tech itself. Elsewhere the title stays. Selects cannot carry interestfor,
  // so they keep title either way.
  const hintFor = new Map();
  if ('interestForElement' in HTMLButtonElement.prototype) {
    let n = 0;
    for (const el of document.querySelectorAll('button[title], a[title]')) {
      const hint = document.createElement('div');
      hint.id = `hint-${++n}`;
      hint.popover = 'hint';
      hint.className = 'hint';
      hint.textContent = el.title;
      el.removeAttribute('title');
      el.setAttribute('interestfor', hint.id);
      document.body.append(hint);
      hintFor.set(el, hint);
    }
  }
  /** Update a control's hint text, whichever mechanism carries it. */
  function setHint(el, text) {
    const hint = hintFor.get(el);
    if (hint) hint.textContent = text; else el.title = text;
  }

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
    // Small corner spinner while the decoder waits for sample data; the big
    // one during a load takes precedence.
    if (!loading) {
      spinner.classList.add('small');
      spinner.hidden = !s.waitingData;
    }
    const mb = (s.fetchedBytes || 0) / 1e6;
    statsEl.textContent =
      `decode queue ${s.decodeQueue} · buffered ${s.buffered} · ` +
      `skipped for pacing ${s.dropped} · clock ${s.clock || 'wall'} · ` +
      `fetched ${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB · waits for data ${s.dataWaits || 0}`;
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
    const at = (i) => (i / (n - 1 || 1)) * (w - 1);

    // Loop range, drawn first so the keyframe ticks stay legible on top of
    // it. Green (#3ddc84), not the UI's amber, and that is the point: amber
    // means the file's own structure and where the playhead is, green means
    // the range you chose. In amber the ticks and the playhead disappeared
    // into the band, being the same hue as it. An open end runs to the edge
    // of the strip, which is what looping with one point set actually does.
    if (player.inPoint !== null || player.outPoint !== null) {
      const x0 = player.inPoint === null ? 0 : at(player.inPoint);
      const x1 = player.outPoint === null ? w : at(player.outPoint);
      g.fillStyle = 'rgba(61, 220, 132, 0.22)';
      g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      // Thinner and dimmer than the playhead (2px, full opacity) so the
      // range's ends never read as the playhead sitting on top of them.
      g.fillStyle = 'rgba(61, 220, 132, 0.85)';
      if (player.inPoint !== null) g.fillRect(x0, 0, 1, h);
      if (player.outPoint !== null) g.fillRect(x1 - 1, 0, 1, h);
    }

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

  /** A local file is read through Blob.slice as decoding reaches each block. */
  async function loadFile(file) {
    return loadSource(new BlobByteSource(file), file.name, null);
  }

  /**
   * Load a server-relative URL. Only the index is read up front; sample
   * data arrives as Range requests while playing, so the file's size no
   * longer matters to memory. `loadingSrc` guards against a second load
   * starting while one is in flight (a follower can be told to load the
   * same src repeatedly while the first index read is still running).
   */
  async function loadFromUrl(src) {
    loadingSrc = true; // one URL load at a time, whoever initiates it
    try {
      const source = await UrlByteSource.open(src, 1 << 20);
      return await loadSource(source, src.split('/').pop(), src);
    } finally {
      loadingSrc = false;
    }
  }

  /**
   * The one path every load funnels through: demux the index, configure
   * video and audio, wire the player up, and reset the UI to the new file.
   * Re-applies the pending filter and, for a follower, the last master
   * state, so a file arriving late still lands in the right place with the
   * right look.
   */
  async function loadSource(source, name, src) {
    clearError();
    dropHint.hidden = false;
    dropHint.textContent = 'Reading the index of ' + name + '…';
    loading = true;
    spinner.classList.remove('small');
    spinner.hidden = false;
    try {
      const demuxed = await demuxMP4(source);
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
        ? await audioEngine.load(demuxed.audio.config, demuxed.audio.samples, demuxed.reader)
        : false;
      if (hasAudio) player.attachAudio(audioEngine);

      await player.load(demuxed.video.config, demuxed.video.samples, demuxed.reader);

      // Handy for sync experiments from the console / other pages.
      window.vsPlayer = player;
      window.vsAudio = audioEngine;
      window.vsFilter = gpuFilter;

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
      announce(`Loaded ${name}, ${i.sampleCount} frames`);
      setControlsEnabled(true);
      btnMute.disabled = !hasAudio;
      volSlider.disabled = !hasAudio;
      btnMute.textContent = hasAudio && audioEngine.muted ? '🔇' : '🔊';
      player.loop = loopOn;
      renderLoopRange(); // a new file starts with no range — destroy() cleared it
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
    } finally {
      loading = false;
      spinner.hidden = true;
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
          if (masterLost) announce('Master is back');
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
          announce('Master lost: timeline frozen');
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
      // fetch), do NOT start a second one — loadSource re-runs adoption when
      // it finishes.
      if (!loadingSrc) loadFromUrl(s.src).catch((err) => showError(String(err.message || err)));
      return;
    }
    if (!player || !player.frameCount || adopting) return;
    adopting = true;
    try {
      const playing = s.playing && s.rate !== 0;
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
      sconv: stereoConv,
    });
  }

  /**
   * Follower: adopt a master state. Filter and src changes are handled first
   * because they can require a load; the clock is only followed once the
   * right file is actually in the player, and loadSource re-applies the state
   * on arrival. Playing states hand a mapping to followExternal() rather than
   * a position, so the follower keeps tracking between messages.
   */
  async function applyState(s) {
    lastMasterState = s;
    if (s.filter !== undefined && (s.filter !== filterName
        || Boolean(s.swapeyes) !== swapEyes
        || (s.slayout || 'sbs') !== stereoLayout
        || finiteConv(s.sconv) !== stereoConv)) {
      filterName = s.filter || 'none';
      swapEyes = Boolean(s.swapeyes);
      stereoLayout = s.slayout || 'sbs';
      stereoConv = finiteConv(s.sconv);
      applyFilter();
    }
    if (s.src && s.src !== loadedSrc) {
      if (!loadingSrc) loadFromUrl(s.src).catch((err) => showError(String(err.message || err)));
      return; // loadSource re-applies lastMasterState once loaded
    }
    if (!player || !player.frameCount || !sync) return;
    if (s.playing && s.rate !== 0) {
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
    for (const el of [btnPlay, btnRestart, btnBack, btnFwd, btnJumpBack, btnJumpFwd,
                      slider, rateSel, frameGoto, btnLoop, btnIn, btnOut, btnClearRange]) {
      el.disabled = follower || !haveVideo;
    }
    syncFilterControls(); // follower filters come from the master
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
    for (const el of [btnPlay, btnRestart, btnBack, btnFwd, btnJumpBack, btnJumpFwd,
                      slider, rateSel, frameGoto, btnLoop, btnIn, btnOut, btnClearRange]) {
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

  /**
   * Rebuild the menu: server media, then recent local files, then Browse….
   * Items are buttons with a data-action, dispatched by one click handler on
   * the menu, so the list can be rebuilt freely while it is open.
   */
  function populateMediaMenu() {
    // A rebuild while the menu is open (the server list arriving) must not
    // drop keyboard focus on the floor: remember which item had it.
    const items = [...mediaMenu.querySelectorAll('.menu-item')];
    const focused = items.indexOf(document.activeElement);
    mediaMenu.innerHTML = '';
    // Each heading opens a role="group" that carries the same label, so
    // screen readers hear "Server media" as context and the visible heading
    // is not read twice.
    let current = mediaMenu;
    const group = (label) => {
      current = document.createElement('div');
      current.setAttribute('role', 'group');
      current.setAttribute('aria-label', label);
      const h = document.createElement('div');
      h.className = 'menu-group';
      h.textContent = label;
      h.setAttribute('aria-hidden', 'true');
      current.append(h);
      mediaMenu.append(current);
    };
    const item = (label, action, meta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item';
      b.setAttribute('role', 'menuitem');
      b.dataset.action = action;
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = label;
      b.append(l);
      if (meta) {
        const m = document.createElement('span');
        m.className = 'meta';
        m.textContent = meta;
        b.append(m);
      }
      current.append(b);
    };
    if (serverMedia.length) {
      group('Server media');
      for (const m of serverMedia) item(m.src, 'src:' + m.src, fmtSize(m.size));
    }
    if (recents.length) {
      group('Recent local files');
      for (const r of recents.slice(0, 8)) item(r.name, 'recent:' + r.name);
    }
    group('Local file');
    item('Browse…', 'browse');
    if (focused >= 0) {
      const rebuilt = mediaMenu.querySelectorAll('.menu-item');
      rebuilt[Math.min(focused, rebuilt.length - 1)].focus();
    }
  }

  /**
   * Ask the server what it can serve. Failure is expected and silent — the
   * page also runs off plain static hosting with no /media endpoint, where the
   * picker is still useful for local files.
   */
  async function refreshServerMedia() {
    try {
      const r = await fetch('media'); // relative: works behind path prefixes
      if (r.ok) {
        const list = await r.json();
        if (JSON.stringify(list) === JSON.stringify(serverMedia)) return; // unchanged: no rebuild
        serverMedia = list;
        populateMediaMenu();
      }
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
      populateMediaMenu();
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

  /** Run a menu action; the menu has already closed. */
  function runMediaAction(v) {
    if (v === 'browse') openLocal();
    else if (v.startsWith('src:')) loadFromUrl(v.slice(4)).catch((e) => showError(String(e.message || e)));
    else if (v.startsWith('recent:')) openRecent(v.slice(7));
  }

  let menuOpen = false;
  const hasPopover = 'popover' in HTMLElement.prototype;
  if (hasPopover) {
    // A top-layer popover ignores its parent, and the UA sheet centres it in
    // the viewport. With anchor positioning the CSS places it under the
    // button; otherwise place it here, and again on resize while open.
    const anchored = CSS.supports('anchor-name: --a');
    const placeMenu = () => {
      if (anchored) return;
      const r = btnOpen.getBoundingClientRect();
      mediaMenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - mediaMenu.offsetWidth - 8))}px`;
      mediaMenu.style.top = `${r.bottom + 4}px`;
    };
    mediaMenu.addEventListener('beforetoggle', (e) => {
      if (e.newState === 'open') { refreshServerMedia(); populateMediaMenu(); }
    });
    mediaMenu.addEventListener('toggle', (e) => {
      menuOpen = e.newState === 'open';
      if (!menuOpen) return;
      placeMenu();
      mediaMenu.querySelector('.menu-item')?.focus();
    });
    window.addEventListener('resize', () => { if (menuOpen) placeMenu(); });
    mediaMenu.addEventListener('click', (e) => {
      const b = e.target.closest('.menu-item');
      if (!b) return;
      mediaMenu.hidePopover();
      // Choosing with the mouse hands focus back to the stage so the transport
      // keys work straight away; a keyboard pick leaves focus on the button.
      if (pointerDroveInput) stage.focus({ preventScroll: true });
      runMediaAction(b.dataset.action);
    });
    // role="menu" promises arrow-key movement; Escape and outside clicks are
    // the popover's own light dismiss.
    mediaMenu.addEventListener('keydown', (e) => {
      const items = [...mediaMenu.querySelectorAll('.menu-item')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
      else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
      else if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      if (next) { e.preventDefault(); next.focus(); }
    });
  } else {
    // No popover API (and no polyfill, by the zero-dependency rule): the
    // button goes straight to the file browser.
    btnOpen.removeAttribute('popovertarget');
    btnOpen.addEventListener('click', () => openLocal());
  }

  refreshServerMedia();
  loadRecents();
  populateMediaMenu();

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
    'left-eye': 8, 'right-eye': 9, difference: 10,
    'side-by-side': 11, 'side-by-side-squished': 12,
  };
  // Stereo filters read a packed eye pair, so they all take the layout menu
  // and the eye swap, and none use the amount slider. Only the interlace
  // needs pixel-exact rows; the anaglyphs and the single-eye views tolerate
  // scaling freely.
  const STEREO_KIND = {
    stereo: 'interlace', anaglyph: 'anaglyph', 'anaglyph-dubois': 'anaglyph',
    'left-eye': 'eye', 'right-eye': 'eye', difference: 'diff',
    'side-by-side': 'sbs-out', 'side-by-side-squished': 'sbs-out',
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
  let stereoConv = 0; // horizontal image translation, px of total separation
  let filterUIBlocked = null; // reason the whole filter UI is unusable, or null
  // A convergence value can arrive from the UI, a URL, or a master's anchor.
  // Only the first of those is a control we own, so normalise at every entry:
  // Number('1e999') and Number('Infinity') are both Infinity, which the
  // shader survives but which has no business in stored state, a synced
  // tuple, or a launch URL.
  const finiteConv = (v) => (Number.isFinite(v) ? v : 0);
  // Cap relative to the eye's own width. An absolute pixel bound is
  // meaningless on a wall: 400 px is a fifth of a 1080p eye and 3 % of an 8K
  // one. A tenth of the eye is already far past any real correction (those
  // run under 2 %), and it means the same thing at every resolution.
  const CONV_FRACTION = 0.1;

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
    filterUIBlocked = why;
    filterSel.title = why;
    syncFilterControls();
  }

  /**
   * Enable exactly the stereo controls the current filter can use, and keep
   * them present the whole time — a control that vanishes moves everything
   * beside it, so the row would reshuffle on every filter change.
   *
   * The single owner of these four `disabled` flags. Three unrelated things
   * decide them — whether the filter uses the control, whether this page is a
   * follower, and whether WebGPU exists at all — and each used to write them
   * directly, so whichever ran last won and the other two were forgotten.
   */
  function syncFilterControls() {
    const kind = STEREO_KIND[filterName] || null;
    // Convergence moves the eyes relative to each other, which needs both of
    // them on screen — for a single-eye view it would just pan the picture.
    // And |L-R| is symmetric, so eye swap cannot change the difference view.
    const blocked = Boolean(filterUIBlocked) || role === 'follower';
    filterSel.disabled = blocked;
    stereoLayoutSel.disabled = blocked || !kind;
    convInput.disabled = blocked || !kind || kind === 'eye';
    btnSwapEyes.disabled = blocked || !kind || kind === 'diff';
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
    // The eye is half the frame only when the pair is packed across x at
    // full width; half-SBS and top/bottom each give the eye the full width.
    const eyeW = meta ? (stereoLayout === 'sbs' ? meta.info.width / 2 : meta.info.width) : 0;
    const convMax = eyeW ? Math.max(1, Math.round(eyeW * CONV_FRACTION)) : 0;
    if (convMax) {
      stereoConv = Math.max(-convMax, Math.min(convMax, finiteConv(stereoConv)));
      convInput.min = String(-convMax);
      convInput.max = String(convMax);
      convInput.title =
        `Convergence: horizontal shift between the eyes, in pixels of total separation (±${convMax})`;
    }
    convInput.value = String(stereoConv);
    syncFilterControls();
    btnSwapEyes.classList.toggle('active', swapEyes);
    btnSwapEyes.setAttribute('aria-pressed', String(swapEyes));
    canvas.classList.toggle('stereo', kind === 'interlace');
    if (!player) return;
    if (gpuFilter && filterName !== 'none' && FILTER_IDS[filterName]) {
      gpuFilter.set(FILTER_IDS[filterName], swapEyes,
                    LAYOUT_IDS[stereoLayout], stereoConv);
      // The side-by-side outputs cut a wall tile inside each eye themselves.
      gpuFilter.setWall(viewport ? {
        viewport, fit: viewportFit, grid: wallGrid,
        monitorAspect: (window.screen && screen.width && screen.height) ? screen.width / screen.height : 16 / 9,
      } : null);
      player.filterFn = (f) => gpuFilter.apply(f);
      player.filterOwnsViewport = () => gpuFilter.viewportApplied;
    } else {
      player.filterFn = null;
      player.filterOwnsViewport = null;
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
  // 'input' so dragging the spinner or holding a key tracks live; the
  // broadcast is rate-limited, as with any continuous control.
  convInput.addEventListener('input', () => {
    stereoConv = finiteConv(Number(convInput.value));
    applyFilter(); // clamps to the eye-relative cap and writes the value back
    broadcastNow();
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

  /**
   * Reflect the loop range in the controls and the GOP strip. The clear
   * button only exists while there is something to clear, the same way the
   * stereo controls come and go with the filter that needs them.
   */
  function renderLoopRange() {
    const hasIn = Boolean(player) && player.inPoint !== null;
    const hasOut = Boolean(player) && player.outPoint !== null;
    btnIn.classList.toggle('active', hasIn);
    btnOut.classList.toggle('active', hasOut);
    btnClearRange.hidden = !(hasIn || hasOut);
    if (player && player.currentIndex >= 0) drawGopStrip(player.currentIndex);
  }

  /**
   * Move one end of the loop range to the playhead. Pressing the same end
   * again where it already sits clears it, so a range comes apart with the
   * same key that built it. Turns looping on when a range first appears — a
   * range is a statement of intent to repeat it.
   */
  function setRangeEnd(which) {
    if (!player || !player.frameCount) return;
    const isIn = which === 'in';
    const already = isIn ? player.inPoint : player.outPoint;
    const value = already === player.currentIndex ? null : player.currentIndex;
    const wasEmpty = player.inPoint === null && player.outPoint === null;
    player.setLoopRange(isIn ? value : player.inPoint,
                        isIn ? player.outPoint : value);
    if (wasEmpty && !loopOn &&
        (player.inPoint !== null || player.outPoint !== null)) {
      setLoop(true);
    }
    renderLoopRange();
  }

  btnIn.addEventListener('click', () => setRangeEnd('in'));
  btnOut.addEventListener('click', () => setRangeEnd('out'));
  btnClearRange.addEventListener('click', () => {
    if (!player) return;
    player.setLoopRange(null, null);
    renderLoopRange();
  });

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

  /**
   * Whether a focused element owns the keyboard outright. Naming individual
   * fields — which is what the transport handler used to do — regresses the
   * moment a field is added: the convergence input arrived unguarded and
   * answered i/o/arrows/space as transport commands while being typed into.
   * Ask what the target IS instead. Buttons are deliberately absent: they
   * only need Space (handled at the call site), and excluding them outright
   * would break stepping right after clicking a transport button.
   */
  const ownsKeyboard = (el) => el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement
    || Boolean(el && el.isContentEditable);

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
    if ((e.key === 'f' || e.key === 'F') && !menuOpen && !ownsKeyboard(e.target) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggleFullscreen();
    }
  });

  roleSel.addEventListener('change', () => setRole(roleSel.value));

  // A control that keeps focus swallows the transport keys, by design — so
  // choosing a filter with the mouse would leave Space changing the dropdown
  // instead of playing. Hand focus back to the stage once a menu has been
  // used, but only when a pointer drove it: arrowing through a select fires
  // `change` on every step, and blurring there would eject a keyboard user
  // mid-navigation.
  let pointerDroveInput = false;
  window.addEventListener('pointerdown', () => { pointerDroveInput = true; }, true);
  window.addEventListener('keydown', () => { pointerDroveInput = false; }, true);

  for (const menu of [filterSel, stereoLayoutSel, rateSel, screenSel, roleSel]) {
    menu.addEventListener('change', () => {
      if (pointerDroveInput) stage.focus({ preventScroll: true });
    });
  }

  // Keyboard transport.
  window.addEventListener('keydown', (e) => {
    if (!player || role === 'follower' || menuOpen || ownsKeyboard(e.target)) return;
    // Space activates a focused button; stealing it would leave every button
    // unusable from the keyboard, since preventDefault suppresses the click.
    if (e.key === ' ' && e.target instanceof HTMLButtonElement) return;
    switch (e.key) {
      case ' ': e.preventDefault(); player.toggle(); break;
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? jumpSeconds(-1) : player.stepBack(); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? jumpSeconds(1) : player.stepForward(); break;
      case 'Home': e.preventDefault(); player.seekToFrame(0); break;
      case 'End': e.preventDefault(); player.seekToFrame(player.frameCount - 1); break;
      case 'l': case 'L': e.preventDefault(); setLoop(!loopOn); break;
      case 'i': case 'I': e.preventDefault(); setRangeEnd('in'); break;
      case 'o': case 'O': e.preventDefault(); setRangeEnd('out'); break;
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

  // ---- launch URL --------------------------------------------------------

  // Wall geometry is launch-time only — there is no UI that changes it — so
  // it rides along verbatim instead of being reconstructed from the parsed
  // viewport rect, which would be lossy (?tile and ?crop both land there).
  const LAUNCH_PASSTHROUGH = ['tile', 'crop', 'wall', 'fit'];

  /**
   * The URL that launches *another* node with this one's setup: live UI
   * state (src, loop, filter, stereo layout, eye swap, target display,
   * fullscreen) on top of the launch-time wall geometry. Setting up a wall
   * means writing one of these per node by hand today, so the output is
   * optimised for a human reading it: flags stay bare (`?loop`, not
   * `?loop=`), and the slashes in a path and the commas in a grid spec are
   * left as themselves — both are legal in a query value, and `tile=1%2C0`
   * is unreadable.
   */
  function launchUrl() {
    const enc = (v) => encodeURIComponent(v).replace(/%2F/g, '/').replace(/%2C/g, ',');
    const launched = new URLSearchParams(location.search);
    const q = [];
    for (const k of LAUNCH_PASSTHROUGH) {
      if (launched.has(k)) q.push(`${k}=${enc(launched.get(k))}`);
    }
    if (loadedSrc) q.push(`src=${enc(loadedSrc)}`);
    // Always follower, never master, even when this page IS the master: the
    // URL exists to be pasted into the other nodes, exactly one client may
    // own the timeline, and the server demotes the incumbent on every new
    // master claim — so a master URL on eight nodes would have them take
    // mastership from each other in turn. Solo stays solo (no sync at all).
    if (role !== 'solo') q.push('role=follower');
    if (loopOn) q.push('loop');
    if (filterName !== 'none') {
      q.push(`filter=${filterName}`);
      // Layout and eye swap only mean anything to a stereo filter, and the
      // defaults are already the defaults — emit neither unless it matters.
      if (STEREO_KIND[filterName]) {
        if (stereoLayout !== 'sbs') q.push(`slayout=${stereoLayout}`);
        if (swapEyes) q.push('swapeyes');
        if (stereoConv) q.push(`sconv=${stereoConv}`);
      }
    }
    if (desiredScreen !== null) q.push(`screen=${desiredScreen}`);
    if (document.fullscreenElement) q.push('fullscreen');
    return location.origin + location.pathname + (q.length ? '?' + q.join('&') : '');
  }

  /**
   * Copy text in both worlds. navigator.clipboard needs a secure context,
   * and the wall case — plain http:// to another machine — is precisely
   * where there isn't one, so fall back to the legacy textarea +
   * execCommand path, which still works there. Returns whether it landed.
   */
  async function copyText(text) {
    try {
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  btnCopyUrl.addEventListener('click', async () => {
    const url = launchUrl();
    setHint(btnCopyUrl, `Copy launch URL for another node\n${url}`);
    if (await copyText(url)) {
      announce('Launch URL copied');
      btnCopyUrl.textContent = '✓';
      setTimeout(() => { btnCopyUrl.textContent = '🔗'; }, 1200);
    } else {
      // No clipboard anywhere — put it somewhere it can at least be selected.
      showError(`Could not reach the clipboard. Launch URL: ${url}`);
    }
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
    stereoConv = finiteConv(Number(params.get('sconv')));
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
