/**
 * Scene half of MOD-008 — host-page bridge for a WebWallGL scene iframe.
 *
 * Pure logic, no DOM access, no globals beyond the UMD wrapper: the same file is
 * loaded by tests/harness.html (classic script -> `window.SceneBridge`) and by
 * node --test (CommonJS `require`). Every entry point takes an injected clock
 * (`now`) so timing tests are deterministic.
 *
 * Contract references (see vendor/webwallgl/CONTRACT.md, the single source of
 * truth — do not re-grep the vendor bundle for these):
 *   §2.2  child -> parent messages are exactly `{op:"we-frame", t}` and
 *         `{op:"error"}`. There is no other child->parent op.
 *   §2.1  parent -> child envelopes are `{__we:1, op, ...}`.
 *   §1    query parameters for the render page (type/src/fit/sceneFps/...).
 *
 * Design (§9 / §10.1): `{op:"error"}` or 10 s without a heartbeat falls back to
 * the preview image; two consecutive failures mark the wallpaper
 * `sceneLive=false` for the session (it stays eligible for rotation).
 *
 * SECURITY: `event.origin` is compared by exact string equality against
 * `mediaOrigin`. Never `startsWith`, never a regex, never `URL`-normalised,
 * because `http://127.0.0.1:8000.evil.test` starts with `http://127.0.0.1:8000`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.SceneBridge = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Defaults straight from §9 / §10.1. */
  var DEFAULTS = {
    // §9: 场景宿主 10s 无心跳 -> 回退 preview 图
    heartbeatTimeoutMs: 10000,
    // T16: 心跳 >= 3 次才算「画面在跑」（心跳 ≠ 渲染成功，见 pixel 通道）
    minFramesForLive: 3,
    // §9: 连续 2 次失败 -> sceneLive=false（仅本次会话）
    maxFailures: 2,
  };

  /** Child -> parent ops allowed by CONTRACT §2.2. */
  var CHILD_OPS = ['we-frame', 'error'];

  /** Parent -> child ops allowed by CONTRACT §2.1 (control plane). */
  var CONTROL_OPS = [
    'setPaused',
    'setVolume',
    'setFps',
    'applyProps',
    'pointer',
    'pointerLeave',
    'audio',
    'media',
    'wheel',
  ];

  var REASONS = {
    OK: 'ok',
    NO_MEDIA_ORIGIN: 'no-media-origin',
    ORIGIN_MISMATCH: 'origin-mismatch',
    NOT_OBJECT: 'not-object',
    UNKNOWN_OP: 'unknown-op',
    SOURCE_MISMATCH: 'source-mismatch',
  };

  function nowMs(clock) {
    return typeof clock === 'function' ? clock() : Date.now();
  }

  /**
   * Build the render-page URL exactly as §10.1 / CONTRACT §1 spell it.
   * `src` is percent-encoded because it is itself a URL carrying a path.
   */
  function buildHostSrc(spec) {
    var s = spec || {};
    var origin = s.origin;
    if (!origin) throw new Error('buildHostSrc: origin required');
    var params = [
      ['type', s.type || 'canvas'],
      ['src', s.src || ''],
      ['fit', s.fit || 'cover'],
      ['sceneFps', String(s.sceneFps || 15)],
      ['muted', s.muted === false ? 'false' : 'true'],
      ['opaque', s.opaque === false ? '0' : '1'],
    ];
    if (s.renderDpr) params.push(['renderDpr', String(s.renderDpr)]);
    // CONTRACT §1 #10: mediaBase is what makes the renderer's diagnostic beacon
    // (`${mediaBase}/diag?msg=…&lvl=…`, see e1() in the bundle) reachable, and
    // what relative `src` values get clamped against.
    if (s.mediaBase) params.push(['mediaBase', s.mediaBase]);
    var qs = params
      .map(function (kv) {
        return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]);
      })
      .join('&');
    return origin.replace(/\/+$/, '') + '/gl/host.html?' + qs;
  }

  /** CONTRACT §2.1 envelope. */
  function buildEnvelope(op, payload) {
    if (CONTROL_OPS.indexOf(op) === -1) {
      throw new Error('buildEnvelope: op not in CONTRACT §2.1: ' + op);
    }
    var msg = { __we: 1, op: op };
    var p = payload || {};
    for (var k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) msg[k] = p[k];
    }
    return msg;
  }

  function createSceneBridge(options) {
    var opts = options || {};
    var mediaOrigin = opts.mediaOrigin || null;
    var heartbeatTimeoutMs =
      typeof opts.heartbeatTimeoutMs === 'number'
        ? opts.heartbeatTimeoutMs
        : DEFAULTS.heartbeatTimeoutMs;
    var minFramesForLive =
      typeof opts.minFramesForLive === 'number' ? opts.minFramesForLive : DEFAULTS.minFramesForLive;
    var maxFailures = typeof opts.maxFailures === 'number' ? opts.maxFailures : DEFAULTS.maxFailures;
    var expectedSourceWindow = opts.expectedSourceWindow || null;
    var clock = typeof opts.now === 'function' ? opts.now : null;

    var listeners = [];
    var attachedTo = null;

    var state = {
      mediaOrigin: mediaOrigin,
      phase: 'idle', // idle | booting | live | fallback
      startedAt: null,
      frames: 0,
      firstFrameAt: null,
      lastFrameAt: null,
      // heartbeat-only liveness; pixel evidence lives in `probe` (harness side)
      framesPerSecond: null,
      errors: [],
      rejected: { total: 0, byReason: {}, origins: {} },
      fallbackReason: null,
      failures: 0,
      sceneLive: true,
      controlSent: [],
      recoveredAt: null,
    };

    function snapshot() {
      return JSON.parse(JSON.stringify(state));
    }

    function emit(change) {
      var snap = snapshot();
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](snap, change);
        } catch (e) {
          /* a subscriber must not break the bridge */
        }
      }
    }

    function reject(reason, origin) {
      state.rejected.total += 1;
      state.rejected.byReason[reason] = (state.rejected.byReason[reason] || 0) + 1;
      var key = typeof origin === 'string' ? origin : String(origin);
      state.rejected.origins[key] = (state.rejected.origins[key] || 0) + 1;
      return { accepted: false, reason: reason };
    }

    function toFallback(reason, at) {
      if (state.phase === 'fallback') return;
      state.phase = 'fallback';
      state.fallbackReason = reason;
      state.failures += 1;
      if (state.failures >= maxFailures) state.sceneLive = false;
      emit({ type: 'fallback', reason: reason, at: at });
    }

    /**
     * Pure message gate. Order matters: origin before payload shape, because an
     * untrusted origin must not even get to influence counters.
     */
    function handleMessage(event, at) {
      var now = typeof at === 'number' ? at : nowMs(clock);
      if (!mediaOrigin) return reject(REASONS.NO_MEDIA_ORIGIN, event && event.origin);
      if (!event || typeof event.origin !== 'string' || event.origin !== mediaOrigin) {
        return reject(REASONS.ORIGIN_MISMATCH, event && event.origin);
      }
      if (expectedSourceWindow && event.source !== expectedSourceWindow) {
        return reject(REASONS.SOURCE_MISMATCH, event.origin);
      }
      var data = event.data;
      if (!data || typeof data !== 'object') return reject(REASONS.NOT_OBJECT, event.origin);
      if (CHILD_OPS.indexOf(data.op) === -1) return reject(REASONS.UNKNOWN_OP, event.origin);

      if (data.op === 'error') {
        state.errors.push({
          at: now,
          message: String(data.message || data.reason || data.error || 'error'),
        });
        toFallback('error-frame', now);
        emit({ type: 'error-frame' });
        return { accepted: true, reason: REASONS.OK, op: 'error' };
      }

      // we-frame
      state.frames += 1;
      if (state.firstFrameAt === null) state.firstFrameAt = now;
      state.lastFrameAt = now;
      if (state.frames > 1) {
        var span = now - state.firstFrameAt;
        if (span > 0) state.framesPerSecond = Math.round(((state.frames - 1) / span) * 1000 * 10) / 10;
      }
      if (state.phase === 'fallback') {
        // Latched: a late heartbeat records recovery but does not un-fallback
        // on its own (§9 says the preview stays until an explicit retry).
        state.recoveredAt = now;
      } else if (state.frames >= minFramesForLive) {
        if (state.phase !== 'live') {
          state.phase = 'live';
          emit({ type: 'live' });
        }
      } else if (state.phase === 'idle') {
        state.phase = 'booting';
        state.startedAt = now;
      }
      return { accepted: true, reason: REASONS.OK, op: 'we-frame' };
    }

    function start(win) {
      var target = win || (typeof window !== 'undefined' ? window : null);
      if (!target || typeof target.addEventListener !== 'function') {
        throw new Error('start: needs a window with addEventListener');
      }
      if (attachedTo) detach();
      attachedTo = target;
      state.phase = state.frames >= minFramesForLive ? 'live' : 'booting';
      state.startedAt = nowMs(clock);
      state.listener = function (ev) {
        handleMessage(ev, nowMs(clock));
      };
      target.addEventListener('message', state.listener);
      emit({ type: 'start' });
      return api;
    }

    function detach() {
      if (attachedTo && state.listener) {
        attachedTo.removeEventListener('message', state.listener);
      }
      attachedTo = null;
      state.listener = null;
      return api;
    }

    /** Heartbeat supervision; call on a timer. */
    function tick(at) {
      var now = typeof at === 'number' ? at : nowMs(clock);
      if (state.phase === 'booting' && state.startedAt !== null) {
        if (now - state.startedAt >= heartbeatTimeoutMs && state.frames < minFramesForLive) {
          toFallback('heartbeat-timeout', now);
        }
      } else if (state.phase === 'live' && state.lastFrameAt !== null) {
        if (now - state.lastFrameAt >= heartbeatTimeoutMs) {
          toFallback('heartbeat-lost', now);
        }
      }
      return snapshot();
    }

    function retry(at) {
      var now = typeof at === 'number' ? at : nowMs(clock);
      state.frames = 0;
      state.firstFrameAt = null;
      state.lastFrameAt = null;
      state.framesPerSecond = null;
      state.fallbackReason = null;
      state.recoveredAt = null;
      state.phase = 'booting';
      state.startedAt = now;
      emit({ type: 'retry' });
      return snapshot();
    }

    /** Same-origin diagnostic channel (harness only) — never counts as heartbeat. */
    function noteProbe(probe) {
      state.probe = probe;
      emit({ type: 'probe' });
      return snapshot();
    }

    function sendControl(post, op, payload) {
      var msg = buildEnvelope(op, payload);
      state.controlSent.push({ op: op, at: nowMs(clock), msg: msg });
      if (typeof post === 'function') post(msg);
      return msg;
    }

    function onChange(fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return api;
    }

    var api = {
      state: function () {
        return snapshot();
      },
      start: start,
      detach: detach,
      handleMessage: handleMessage,
      tick: tick,
      retry: retry,
      noteProbe: noteProbe,
      sendControl: sendControl,
      onChange: onChange,
      reasons: REASONS,
    };
    return api;
  }

  return {
    createSceneBridge: createSceneBridge,
    buildHostSrc: buildHostSrc,
    buildEnvelope: buildEnvelope,
    DEFAULTS: DEFAULTS,
    CHILD_OPS: CHILD_OPS,
    CONTROL_OPS: CONTROL_OPS,
    REASONS: REASONS,
  };
});
