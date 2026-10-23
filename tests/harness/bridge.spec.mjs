// Unit suite for tests/harness/bridge.js (the scene-half bridge logic).
//
// Run standalone:  node --test tests/harness/bridge.spec.mjs
// Also invoked by pytest (tests/test_scene_bridge.py), which parses the TAP
// summary so the browser-independent logic is counted in the same report.
//
// These are the deterministic, DOM-free guarantees. The browser run proves the
// same module behaves inside a real page (see tests/test_scene_bridge.py).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SceneBridge = require('./bridge.js');

const MEDIA = 'http://127.0.0.1:41234';
const EVIL = 'http://127.0.0.1:41235';

/** Minimal MessageEvent stand-in: only origin/data/source are read. */
function msg(origin, data, source) {
  return { origin, data, source: source === undefined ? null : source };
}

/** Clock we drive by hand, so no test sleeps. */
function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    at: () => t,
  };
}

/** The bridge only needs add/removeEventListener from a window. */
function fakeWin() {
  return {
    handlers: [],
    addEventListener(type, fn) {
      this.handlers.push([type, fn]);
    },
    removeEventListener(type, fn) {
      this.handlers = this.handlers.filter((h) => h[0] !== type || h[1] !== fn);
    },
  };
}

function makeBridge(extra = {}) {
  const clock = extra.clock || makeClock();
  const bridge = SceneBridge.createSceneBridge({ mediaOrigin: MEDIA, now: clock.now, ...extra });
  return { bridge, clock };
}

// ---------------------------------------------------------------- origin gate

test('T16b: we-frame from a foreign origin is rejected and changes nothing', () => {
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  const before = bridge.state();

  const r = bridge.handleMessage(msg(EVIL, { op: 'we-frame', t: 1 }), before.startedAt + 10);

  assert.equal(r.accepted, false);
  assert.equal(r.reason, SceneBridge.REASONS.ORIGIN_MISMATCH);

  const after = bridge.state();
  assert.equal(after.frames, 0, 'frame counter must not move');
  assert.equal(after.phase, before.phase, 'state machine must not move');
  assert.equal(after.rejected.total, 1);
  assert.equal(after.rejected.byReason['origin-mismatch'], 1);
});

test('T16b: an origin that merely *starts with* mediaOrigin is still rejected', () => {
  // The classic startsWith() bug: "http://127.0.0.1:41234.evil.test" and
  // "http://127.0.0.1:412340" both pass a prefix test.
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  for (const evil of [
    'http://127.0.0.1:41234.evil.test',
    'http://127.0.0.1:412340',
    'http://127.0.0.1:41234.example.com',
    'https://127.0.0.1:41234', // scheme differs -> different origin
    'null',
    '',
  ]) {
    const r = bridge.handleMessage(msg(evil, { op: 'we-frame', t: 1 }), 1010);
    assert.equal(r.accepted, false, `must reject ${JSON.stringify(evil)}`);
    assert.equal(r.reason, SceneBridge.REASONS.ORIGIN_MISMATCH);
  }
  assert.equal(bridge.state().frames, 0);
});

test('T16b: a forged error frame from a foreign origin cannot force the fallback', () => {
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  const r = bridge.handleMessage(msg(EVIL, { op: 'error', message: 'nope' }), 1010);

  assert.equal(r.accepted, false);
  const s = bridge.state();
  assert.equal(s.phase, 'booting', 'no fallback from an untrusted error');
  assert.equal(s.errors.length, 0);
  assert.equal(s.failures, 0);
});

test('untrusted traffic never reaches the op switch (unknown op from foreign origin)', () => {
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  const r = bridge.handleMessage(msg(EVIL, { op: 'setPaused' }), 1010);
  // origin is checked first, so the reason is the origin, not the op
  assert.equal(r.reason, SceneBridge.REASONS.ORIGIN_MISMATCH);
  assert.equal(bridge.state().rejected.byReason['unknown-op'], undefined);
});

test('trusted origin with an op outside CONTRACT §2.2 is rejected as unknown-op', () => {
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  const r = bridge.handleMessage(msg(MEDIA, { op: 'setPaused', v: true }), 1010);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, SceneBridge.REASONS.UNKNOWN_OP);
  assert.equal(bridge.state().frames, 0);
});

// --------------------------------------------------------------- accept path

test('trusted we-frame is accepted and three of them turn the state machine live', () => {
  const { bridge, clock } = makeBridge();
  bridge.start(fakeWin());

  assert.equal(bridge.handleMessage(msg(MEDIA, { op: 'we-frame', t: 1 }), clock.advance(30)).accepted, true);
  assert.equal(bridge.state().phase, 'booting');
  bridge.handleMessage(msg(MEDIA, { op: 'we-frame', t: 2 }), clock.advance(30));
  assert.equal(bridge.state().phase, 'booting', 'two heartbeats are not enough');
  bridge.handleMessage(msg(MEDIA, { op: 'we-frame', t: 3 }), clock.advance(30));

  const s = bridge.state();
  assert.equal(s.phase, 'live');
  assert.equal(s.frames, 3);
  assert.equal(s.firstFrameAt, 1030);
  assert.equal(s.lastFrameAt, 1090);
  assert.equal(s.rejected.total, 0);
});

test('frames-per-second is derived from the frames actually received', () => {
  const { bridge, clock } = makeBridge();
  bridge.start(fakeWin());
  for (let i = 0; i < 5; i += 1) {
    bridge.handleMessage(msg(MEDIA, { op: 'we-frame', t: i }), clock.advance(100));
  }
  // 4 intervals over 400 ms -> 10 fps
  assert.equal(bridge.state().framesPerSecond, 10);
});

test('trusted error frame falls back immediately and records the message', () => {
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  bridge.handleMessage(msg(MEDIA, { op: 'error', message: 'scene.pkg 解析失败' }), 1200);

  const s = bridge.state();
  assert.equal(s.phase, 'fallback');
  assert.equal(s.fallbackReason, 'error-frame');
  assert.equal(s.failures, 1);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].message, /scene\.pkg/);
  assert.equal(s.sceneLive, true, 'one failure is not enough to mark the wallpaper dead');
});

test('non-object payloads from the trusted origin are ignored', () => {
  const { bridge } = makeBridge();
  bridge.start(fakeWin());
  const cases = [
    [null, SceneBridge.REASONS.NOT_OBJECT],
    [undefined, SceneBridge.REASONS.NOT_OBJECT],
    [42, SceneBridge.REASONS.NOT_OBJECT],
    ['we-frame', SceneBridge.REASONS.NOT_OBJECT],
    // an array *is* an object, but it has no matching op
    [['we-frame'], SceneBridge.REASONS.UNKNOWN_OP],
    [{}, SceneBridge.REASONS.UNKNOWN_OP],
  ];
  for (const [payload, expected] of cases) {
    const r = bridge.handleMessage(msg(MEDIA, payload), 1010);
    assert.equal(r.accepted, false, `must reject ${JSON.stringify(payload)}`);
    assert.equal(r.reason, expected);
  }
  assert.equal(bridge.state().frames, 0);
  assert.equal(bridge.state().rejected.total, cases.length);
});

test('a bridge with no mediaOrigin rejects everything (fail closed)', () => {
  const bridge = SceneBridge.createSceneBridge({ now: () => 1 });
  bridge.start(fakeWin());
  const r = bridge.handleMessage(msg('http://127.0.0.1:41234', { op: 'we-frame' }), 1);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, SceneBridge.REASONS.NO_MEDIA_ORIGIN);
  assert.equal(bridge.state().frames, 0);
});

test('expectedSourceWindow adds a source check on top of the origin check', () => {
  const win = { marker: 'the-iframe' };
  const { bridge } = makeBridge({ expectedSourceWindow: win });
  bridge.start(fakeWin());

  const wrong = bridge.handleMessage(msg(MEDIA, { op: 'we-frame' }, { other: true }), 1010);
  assert.equal(wrong.reason, SceneBridge.REASONS.SOURCE_MISMATCH);
  const right = bridge.handleMessage(msg(MEDIA, { op: 'we-frame' }, win), 1020);
  assert.equal(right.accepted, true);
  assert.equal(bridge.state().frames, 1);
});

// ------------------------------------------------------------- 10 s watchdog

test('§9: 10 s without a first heartbeat falls back to the preview', () => {
  const { bridge, clock } = makeBridge({ heartbeatTimeoutMs: 10000, minFramesForLive: 3 });
  bridge.start(fakeWin());

  assert.equal(bridge.tick(clock.advance(9999)).phase, 'booting', 'not yet');
  const s = bridge.tick(clock.advance(1));
  assert.equal(s.phase, 'fallback');
  assert.equal(s.fallbackReason, 'heartbeat-timeout');
});

test('§9: a live scene that stops sending heartbeats falls back after 10 s', () => {
  const { bridge, clock } = makeBridge({ heartbeatTimeoutMs: 10000 });
  bridge.start(fakeWin());
  for (let i = 0; i < 3; i += 1) bridge.handleMessage(msg(MEDIA, { op: 'we-frame' }), clock.advance(10));
  assert.equal(bridge.state().phase, 'live');

  assert.equal(bridge.tick(clock.advance(9000)).phase, 'live');
  const s = bridge.tick(clock.advance(1000));
  assert.equal(s.phase, 'fallback');
  assert.equal(s.fallbackReason, 'heartbeat-lost');
});

test('§9: two consecutive failures set sceneLive=false, and the second needs a retry', () => {
  const { bridge, clock } = makeBridge({ heartbeatTimeoutMs: 10000 });
  bridge.start(fakeWin());

  bridge.tick(clock.advance(10000));
  assert.equal(bridge.state().failures, 1);
  assert.equal(bridge.state().sceneLive, true);

  // Without an explicit retry the state stays latched: no second failure.
  bridge.tick(clock.advance(10000));
  assert.equal(bridge.state().failures, 1);

  bridge.retry(clock.at());
  bridge.tick(clock.advance(10000));
  const s = bridge.state();
  assert.equal(s.failures, 2);
  assert.equal(s.sceneLive, false, 'two consecutive failures mark it dead for the session');
});

test('a heartbeat arriving during a fallback is recorded but does not un-fallback', () => {
  const { bridge, clock } = makeBridge();
  bridge.start(fakeWin());
  bridge.tick(clock.advance(10000));
  assert.equal(bridge.state().phase, 'fallback');

  bridge.handleMessage(msg(MEDIA, { op: 'we-frame' }), clock.advance(5));
  const s = bridge.state();
  assert.equal(s.phase, 'fallback', 'the preview stays until an explicit retry (§9)');
  assert.ok(s.recoveredAt !== null);
});

test('retry() resets the frame accounting but keeps the failure tally', () => {
  const { bridge, clock } = makeBridge();
  bridge.start(fakeWin());
  bridge.handleMessage(msg(MEDIA, { op: 'we-frame' }), clock.advance(10));
  bridge.tick(clock.advance(10000));

  const s = bridge.retry(clock.at());
  assert.equal(s.frames, 0);
  assert.equal(s.phase, 'booting');
  assert.equal(s.fallbackReason, null);
  assert.equal(s.failures, 1, 'failures survive a retry (they are consecutive-failure history)');
});

test('tick() on an idle bridge (never started) is a no-op', () => {
  const { bridge, clock } = makeBridge();
  const s = bridge.tick(clock.advance(60000));
  assert.equal(s.phase, 'idle');
});

// ------------------------------------------------------------- src / control

test('buildHostSrc emits the documented query surface for a scene', () => {
  const url = SceneBridge.buildHostSrc({
    origin: MEDIA + '/',
    type: 'scene',
    src: '/s/tok',
    fit: 'cover',
    sceneFps: 15,
    muted: true,
    opaque: true,
  });
  assert.equal(
    url,
    `${MEDIA}/gl/host.html?type=scene&src=%2Fs%2Ftok&fit=cover&sceneFps=15&muted=true&opaque=1`,
  );
});

test('buildHostSrc percent-encodes the scene URL and carries mediaBase', () => {
  const url = SceneBridge.buildHostSrc({
    origin: MEDIA,
    type: 'scene',
    src: '/s/a b/c?d=1',
    mediaBase: MEDIA,
    renderDpr: 1,
  });
  const q = new URLSearchParams(url.split('?')[1]);
  assert.equal(q.get('src'), '/s/a b/c?d=1');
  assert.equal(q.get('mediaBase'), MEDIA);
  assert.equal(q.get('renderDpr'), '1');
});

test('buildEnvelope only accepts CONTRACT §2.1 ops and sets __we:1', () => {
  assert.deepEqual(SceneBridge.buildEnvelope('setPaused', { v: true }), {
    __we: 1,
    op: 'setPaused',
    v: true,
  });
  assert.throws(() => SceneBridge.buildEnvelope('we-frame'), /CONTRACT/);
  assert.throws(() => SceneBridge.buildEnvelope('nope'), /CONTRACT/);
  // every §2.1 op must be buildable
  for (const op of SceneBridge.CONTROL_OPS) {
    assert.equal(SceneBridge.buildEnvelope(op, {}).__we, 1);
  }
  assert.equal(SceneBridge.CONTROL_OPS.length, 9, 'CONTRACT §2.1 lists 9 ops');
});

test('sendControl records and forwards exactly one envelope', () => {
  const { bridge } = makeBridge();
  const posted = [];
  bridge.sendControl((m) => posted.push(m), 'setFps', { n: 30 });

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { __we: 1, op: 'setFps', n: 30 });
  assert.equal(bridge.state().controlSent.length, 1);
  assert.throws(() => bridge.sendControl(() => {}, 'bogus'), /CONTRACT/);
});

test('subscribers observe transitions and a throwing subscriber cannot break the bridge', () => {
  const { bridge, clock } = makeBridge();
  const seen = [];
  bridge.onChange(() => {
    throw new Error('subscriber blew up');
  });
  bridge.onChange((s, change) => seen.push(change.type));

  bridge.start(fakeWin());
  for (let i = 0; i < 3; i += 1) bridge.handleMessage(msg(MEDIA, { op: 'we-frame' }), clock.advance(10));
  bridge.tick(clock.advance(10000));

  assert.deepEqual(seen, ['start', 'live', 'fallback']);
});

test('state() returns a copy, so callers cannot mutate the bridge', () => {
  const { bridge } = makeBridge();
  const s = bridge.state();
  s.frames = 999;
  assert.equal(bridge.state().frames, 0);
});
