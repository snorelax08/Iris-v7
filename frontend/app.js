
document.addEventListener('DOMContentLoaded', () => {
  const analytics = window.IrisAnalytics || {
    capture: function () {}
  };

  const environment = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "development"
    : "production";

  const authParams = new URLSearchParams(location.search);

  analytics.capture("app_opened", {
    app_version: "iris-v7",
    environment,
    speech_locale: window.AKON_SPEECH_LANG || "en-IN"
  });

  if (authParams.get("logged_in") === "true") {
    analytics.capture("spotify_auth_succeeded", {
      auth_method: "spotify_oauth"
    });
  }

  const authError = authParams.get("error");

  if (authError) {
    analytics.capture("spotify_auth_failed", {
      error_code: authError === "access_denied" ? "access_denied" : "oauth_failed"
    });
  }

  if (authParams.has("logged_in") || authParams.has("error")) {
    history.replaceState({}, document.title, location.pathname);
  }

  const loginBtn = document.getElementById('loginBtn');
  const appDiv = document.getElementById('app');
  const micBtn = document.getElementById('micBtn');
  const listenBtn = document.getElementById('listenBtn');

  const listeningStatusEl = document.getElementById('listeningStatus');
  const lastCommandEl = document.getElementById('lastCommand');
  const nowPlayingEl = document.getElementById('nowPlaying');
  const playbackStatusEl = document.getElementById('playbackStatus');

  const debugToggle = document.getElementById('debugToggle');
  const debugLog = document.getElementById('debugLog');

  let currentVolume = 70;
  let volumeBeforeMute = 70;

  let pendingPlayback = null;
  let activeInputMode = "hands_free";

  function createCommandId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return "cmd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function confidenceBucket(score) {
    if (typeof score !== "number") return "unknown";
    if (score < 0.65) return "low";
    if (score < 0.85) return "medium";
    return "high";
  }

  function commandCategory(type) {
    const categories = {
      play_song: "song_request",
      select_option: "song_selection",
      reject: "reject",
      pause: "pause",
      resume: "resume",
      next: "next",
      previous: "previous",
      volume_up: "volume_up",
      volume_down: "volume_down",
      volume_set: "volume_set",
      mute: "mute",
      unmute: "unmute"
    };

    return categories[type] || "other";
  }

  async function trackCommandAction(commandId, category, action) {
    let success = false;

    try {
      const result = await action();
      success = result !== false;
      return result;
    } finally {
      analytics.capture("command_action_completed", {
        command_id: commandId,
        command_category: category,
        success
      });
    }
  }

  loginBtn.addEventListener('click', () => {
    window.location.href = '/auth/login';
  });

  checkLoginStatus();

  function serverUi(state) {
    try {
      const note = document.getElementById('serverNote');
      if (note) note.classList.toggle('hidden', state !== 'waking');
      window.dispatchEvent(new CustomEvent('iris:server', { detail: { state } }));
    } catch (e) {}
  }

  async function checkLoginStatus(attempt = 0) {
    const retry = (window.IRIS_FLAGS || {}).coldStart !== false;

    try {
      const res = await fetch('/auth/status');

      if (retry && !res.ok) {
        throw new Error(`/auth/status returned ${res.status}`);
      }

      const data = await res.json();

      if (attempt > 0) serverUi('up');

      if (data.logged_in) {
        loginBtn.classList.add('hidden');
        appDiv.classList.remove('hidden');
        setupPlayer();
        setupVoice();
      }
    } catch (err) {
      if (retry && attempt < 7) {
        serverUi('waking');
        setTimeout(
          () => checkLoginStatus(attempt + 1),
          Math.min(1000 * Math.pow(2, attempt), 15000)
        );
        return;
      }

      if (retry) serverUi('down');
      console.error('Failed to check login status:', err);
    }
  }

  function setupPlayer() {
    SpotifyController.init(
      () => {
        listeningStatusEl.textContent = 'Player ready';

        analytics.capture("player_ready", {
          player_type: "web_playback_sdk"
        });
      },
      (state) => {
        const track = state.track_window && state.track_window.current_track;

        nowPlayingEl.textContent = track
          ? `${track.name} — ${track.artists.map((a) => a.name).join(', ')}`
          : 'Nothing';

        playbackStatusEl.textContent = state.paused ? 'Paused' : 'Playing';

        if (
          track &&
          !state.paused &&
          pendingPlayback &&
          track.uri === pendingPlayback.uri &&
          Date.now() - pendingPlayback.startedAt < 20000
        ) {
          analytics.capture("playback_started", {
            command_id: pendingPlayback.commandId,
            time_to_playback_ms: Date.now() - pendingPlayback.startedAt
          });

          pendingPlayback = null;
        }

        try {
          window.dispatchEvent(new CustomEvent('akon:state', { detail: state }));
        } catch (e) {}
      }
    );
  }

  function setupVoice() {
    const voiceReady = VoiceControl.init(handleCommand);

    let voicePhase = 'off';
    let previousPhase = 'off';

    window.addEventListener('akon:phase', (e) => {
      const off = e.detail && e.detail.phase === 'off';
      const nextPhase = (e.detail && e.detail.phase) || 'idle';

      micBtn.textContent = off ? 'Turn on microphone' : 'Mute microphone';
      micBtn.setAttribute('aria-pressed', String(off));

      voicePhase = nextPhase;

      if (nextPhase === 'listening' && previousPhase !== 'listening') {
        analytics.capture("voice_session_started", {
          input_mode: activeInputMode,
          speech_locale: window.AKON_SPEECH_LANG || "en-IN"
        });
      }

      if (previousPhase === 'listening' && nextPhase !== 'listening') {
        analytics.capture("voice_session_ended", {
          end_reason: nextPhase
        });

        activeInputMode = "hands_free";
      }

      if (listenBtn) {
        const listening = voicePhase === 'listening';

        listenBtn.textContent = listening
          ? 'Listening… (tap to cancel)'
          : 'Start listening';

        listenBtn.setAttribute('aria-pressed', String(listening));
      }

      previousPhase = nextPhase;
    });

    window.addEventListener('iris:listen', () => {
      try {
        if (!voiceReady || typeof VoiceControl.listenNow !== 'function') return;

        activeInputMode = "tap_to_talk";

        if (voicePhase === 'listening') {
          VoiceControl.cancelListening();
        } else {
          VoiceControl.listenNow();
        }
      } catch (err) {
        dlog(`Start listening failed: ${err.message}`, 'warn');
      }
    });

    if (listenBtn) {
      listenBtn.addEventListener('click', (e) => {
        window.dispatchEvent(
          new CustomEvent('iris:listen', { detail: { source: 'button' } })
        );

        if (e.detail > 0) listenBtn.blur();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.key !== 'l' && e.key !== 'L')
      ) return;

      if (appDiv.classList.contains('hidden')) return;

      const tag = (e.target.tagName || '').toLowerCase();

      if (
        ['input', 'textarea', 'select', 'button', 'a'].includes(tag) ||
        e.target.isContentEditable
      ) return;

      e.preventDefault();

      window.dispatchEvent(
        new CustomEvent('iris:listen', { detail: { source: 'key' } })
      );
    });

    micBtn.addEventListener('click', () => {
      if (!voiceReady) return;

      if (VoiceControl.isEnabled()) {
        VoiceControl.stop();
      } else {
        VoiceControl.start();
      }
    });

    if (voiceReady) VoiceControl.start();

    const onFirstGesture = (e) => {
      if (SpotifyController.activate()) {
        window.removeEventListener('pointerdown', onFirstGesture, true);
        window.removeEventListener('keydown', onFirstGesture, true);
      }

      if (
        voiceReady &&
        VoiceControl.isBlocked() &&
        e.target !== micBtn
      ) {
        VoiceControl.start();
      }
    };

    window.addEventListener('pointerdown', onFirstGesture, true);
    window.addEventListener('keydown', onFirstGesture, true);

    window.addEventListener('akon:autoplay-blocked', () => {
      if (window.showToast) {
        window.showToast(
          'The browser blocked sound. Tap anywhere on the page to allow it.',
          'warn',
          7000
        );
      }
    });
  }

  const dlog = (msg, level) =>
    window.AkonDebug && window.AkonDebug.log(msg, level);

  const who = (t) => `${t.name} — ${t.artists.join(', ')}`;

  let pending = {
    options: [],
    current: -1,
    expires: 0
  };

  function setPending(options, current = -1) {
    pending = {
      options: options || [],
      current,
      expires: Date.now() + 60000
    };
  }

  function pendingOptions() {
    return Date.now() < pending.expires ? pending.options : [];
  }

  let commandSeq = 0;

  async function playResolved(track, seq, commandId) {
    if (seq !== commandSeq) return false;

    try {
      window.dispatchEvent(
        new CustomEvent('akon:match', {
          detail: {
            name: track.name,
            artist: track.artists.join(', '),
            score: track.score,
            art: track.art
          }
        })
      );
    } catch (e) {}

    pendingPlayback = {
      commandId,
      uri: track.uri,
      startedAt: Date.now()
    };

    analytics.capture("playback_attempted", {
      command_id: commandId,
      playback_method: "spotify_controller"
    });

    try {
      const success = await SpotifyController.playTrack(
        track.uri,
        track.albumUri
      );

      if (!success) {
        analytics.capture("playback_failed", {
          command_id: commandId,
          error_code: "play_request_failed",
          playback_method: "spotify_controller"
        });

        if (pendingPlayback && pendingPlayback.commandId === commandId) {
          pendingPlayback = null;
        }
      }

      return success;
    } catch (err) {
      analytics.capture("playback_failed", {
        command_id: commandId,
        error_code: "play_request_error",
        playback_method: "spotify_controller"
      });

      if (pendingPlayback && pendingPlayback.commandId === commandId) {
        pendingPlayback = null;
      }

      throw err;
    }
  }

  function resolvedUi(detail) {
    try {
      window.dispatchEvent(new CustomEvent('akon:resolved', { detail }));
    } catch (e) {}
  }

  async function resolveAndPlay(query, alternatives, implicit, seq, commandId) {
    nowPlayingEl.textContent = `Searching: ${query}...`;

    const searchStartedAt = Date.now();

    let result;

    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          alternatives,
          implicit
        })
      });

      if (!res.ok) {
        throw new Error(`resolve returned ${res.status}`);
      }

      result = await res.json();
    } catch (err) {
      analytics.capture("song_search_completed", {
        command_id: commandId,
        outcome: "error",
        latency_ms: Date.now() - searchStartedAt,
        confidence_bucket: "unknown",
        candidate_count: 0,
        used_llm_fallback: false
      });

      dlog(`Song lookup failed: ${err.message}`, 'error');

      if (seq === commandSeq) {
        nowPlayingEl.textContent = 'Search failed — try again';
      }

      resolvedUi({
        action: 'error',
        message: 'Search failed — try again'
      });

      return;
    }

    const candidateCount = result.action === "play"
      ? 1 + ((result.alternatives || []).length)
      : ((result.options || []).length);

    analytics.capture("song_search_completed", {
      command_id: commandId,
      outcome: ["play", "choose", "not_found"].includes(result.action)
        ? result.action
        : "error",
      latency_ms: Date.now() - searchStartedAt,
      confidence_bucket: confidenceBucket(result.confidence),
      candidate_count: candidateCount,
      used_llm_fallback: result.source === "llm"
    });

    if (seq !== commandSeq) return;

    const top = (result.debug && result.debug.top) || [];

    dlog(
      `Resolve -> ${result.action} (${result.confidence}, ${result.source}, ${result.debug && result.debug.ms}ms) | ` +
      top.slice(0, 3).map((t) => `${t.track} = ${t.score}`).join(' | ')
    );

    if (result.action === 'play') {
      setPending([result.track, ...result.alternatives], 0);

      await playResolved(result.track, seq, commandId);

      resolvedUi({
        action: 'play',
        message: result.alternatives.length ? result.message : '',
        options: [result.track, ...result.alternatives],
        alternatives: result.alternatives
      });

      return;
    }

    if (result.action === 'choose') {
      setPending(result.options);

      nowPlayingEl.textContent = result.message;
      dlog(result.message, 'warn');

      resolvedUi({
        action: 'choose',
        message: result.message,
        options: result.options || [],
        alternatives: []
      });

      return;
    }

    setPending([]);

    nowPlayingEl.textContent = result.message || 'Song not found';

    dlog('Song not found', 'warn');

    resolvedUi({
      action: 'not_found',
      message: result.message,
      options: [],
      alternatives: []
    });
  }

  const OPTION_WORDS = ['one', 'two', 'three'];

  window.addEventListener('iris:select', (e) => {
    try {
      const index = e.detail && e.detail.index;

      if (!OPTION_WORDS[index]) return;

      const cmd = `option ${OPTION_WORDS[index]}`;

      handleCommand(cmd, `${cmd} (tapped)`, []);
    } catch (err) {
      dlog(`Option tap failed: ${err.message}`, 'warn');
    }
  });

  async function changeVolume(delta) {
    const current = await SpotifyController.getVolume();

    if (current !== null) currentVolume = current;

    currentVolume = Math.max(0, Math.min(100, currentVolume + delta));

    return SpotifyController.setVolume(currentVolume);
  }

  async function handleCommand(command, fullTranscript, altCommands = []) {
    lastCommandEl.textContent = fullTranscript;

    const seq = ++commandSeq;
    const commandId = createCommandId();

    const intent = AkonIntent.extractIntent(command);
    const category = commandCategory(intent.type);

    const isTapped = fullTranscript.includes("(tapped)");

    analytics.capture("voice_command_received", {
      command_id: commandId,
      command_category: category,
      input_mode: isTapped ? "ui_tap" : activeInputMode,
      speech_locale: window.AKON_SPEECH_LANG || "en-IN"
    });

    analytics.capture("intent_parsed", {
      command_id: commandId,
      intent_type: intent.type || "unknown",
      parse_status: intent.type && intent.type !== "unknown"
        ? "recognized"
        : "unrecognized"
    });

    dlog(`Intent: ${JSON.stringify(intent)}`);

    try {
      switch (intent.type) {
        case 'play_song': {
          const alts = altCommands
            .map((a) => AkonIntent.extractIntent(a))
            .filter((i) => i.type === 'play_song')
            .map((i) => i.query);

          await resolveAndPlay(
            intent.query,
            alts,
            intent.implicit,
            seq,
            commandId
          );

          break;
        }

        case 'select_option': {
          analytics.capture("song_option_selected", {
            command_id: commandId,
            selection_position: intent.index + 1,
            selection_method: isTapped ? "tap" : "voice"
          });

          const opts = pendingOptions();

          if (opts[intent.index]) {
            pending.current = intent.index;
            await playResolved(opts[intent.index], seq, commandId);
          } else {
            await resolveAndPlay(
              intent.fallbackQuery,
              [],
              false,
              seq,
              commandId
            );
          }

          break;
        }

        case 'reject': {
          const opts = pendingOptions();
          const nextIdx = pending.current + 1;

          if (opts[nextIdx]) {
            analytics.capture("song_option_selected", {
              command_id: commandId,
              selection_position: nextIdx + 1,
              selection_method: "voice"
            });

            pending.current = nextIdx;

            await playResolved(opts[nextIdx], seq, commandId);
          } else {
            await trackCommandAction(
              commandId,
              "next",
              () => SpotifyController.nextTrack()
            );
          }

          break;
        }

        case 'pause':
          await trackCommandAction(
            commandId,
            "pause",
            () => SpotifyController.pause()
          );
          break;

        case 'resume':
          await trackCommandAction(
            commandId,
            "resume",
            () => SpotifyController.resume()
          );
          break;

        case 'next':
          await trackCommandAction(
            commandId,
            "next",
            () => SpotifyController.nextTrack()
          );
          break;

        case 'previous':
          await trackCommandAction(
            commandId,
            "previous",
            () => SpotifyController.previousTrack()
          );
          break;

        case 'volume_up':
          await trackCommandAction(
            commandId,
            "volume_up",
            () => changeVolume(intent.step || 15)
          );
          break;

        case 'volume_down':
          await trackCommandAction(
            commandId,
            "volume_down",
            () => changeVolume(-(intent.step || 15))
          );
          break;

        case 'volume_set':
          currentVolume = intent.value;

          await trackCommandAction(
            commandId,
            "volume_set",
            () => SpotifyController.setVolume(currentVolume)
          );

          break;

        case 'mute': {
          const v = await SpotifyController.getVolume();

          if (v) volumeBeforeMute = v;

          await trackCommandAction(
            commandId,
            "mute",
            () => SpotifyController.setVolume(0)
          );

          break;
        }

        case 'unmute':
          await trackCommandAction(
            commandId,
            "unmute",
            () => SpotifyController.setVolume(volumeBeforeMute || 60)
          );

          break;

        default:
          dlog(`Unrecognized command after wake word`, 'warn');
      }
    } catch (err) {
      dlog(`Command failed: ${err.message}`, 'error');
    }

    maybeRefreshDebugPanel();
  }

  if (debugToggle && debugLog) {
    debugToggle.addEventListener('click', async () => {
      const isHidden = debugLog.classList.contains('hidden');

      if (isHidden) {
        debugLog.classList.remove('hidden');
        debugToggle.textContent = 'Hide Debug Info';

        await refreshDebugPanel();
      } else {
        debugLog.classList.add('hidden');
        debugToggle.textContent = 'Show Debug Info';
      }
    });
  }

  function maybeRefreshDebugPanel() {
    if (debugLog && !debugLog.classList.contains('hidden')) {
      refreshDebugPanel();
    }
  }

  async function refreshDebugPanel() {
    if (!debugLog) return;

    let serverState = {};

    try {
      const res = await fetch('/auth/debug');
      serverState = await res.json();
    } catch (err) {
      serverState = {
        error: 'Could not reach /auth/debug'
      };
    }

    const clientLines = (window.AkonDebug && window.AkonDebug.logs) || [];

    debugLog.textContent =
      '--- Server auth/device state ---\n' +
      JSON.stringify(serverState, null, 2) +
      '\n\n--- Client log (most recent last) ---\n' +
      clientLines.join('\n');
  }
});
