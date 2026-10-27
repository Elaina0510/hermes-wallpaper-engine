/**
 * T2.3 — behaviour tests for `desktop/src/10-layer.js` (MOD-007).
 *
 * Run with:  node --test tests/frontend/10-layer.test.mjs
 *
 * How it loads the module: this file is a concatenation fragment, so the harness
 * evaluates the *concatenated product* shape — core part first, layer part
 * second, one shared function scope. The core part's single whitelisted import
 * is stripped and re-created as a scope binding, exactly like the sibling core
 * test does.
 *
 * WHAT IS REAL vs STUBBED (read this before trusting a green run):
 *   real   — all control flow, the store, the DOM the module builds (jsdom really
 *            creates/attaches/removes elements, so opacity/class/src/attachment
 *            assertions are assertions about real DOM state);
 *   real   — the 2s gate: the timer is taken from the injected `ctx.setTimeout`
 *            double, so the test fires the *product's own* callback. The 2000ms
 *            constant is never changed for the test.
 *   stub   — jsdom does not decode media (`readyState` stays 0, no
 *            `loadeddata`/`load` ever fires, `play()/pause()/load()` are
 *            "Not implemented"). Tests that need a ready element install an
 *            `HTMLMediaElement.prototype` stub that (a) fakes readyState,
 *            (b) records play/pause/load calls, (c) offers `__advance(ms)` to
 *            move currentTime — i.e. a hand-cranked playback clock.
 *            T14 (`readyState>=2` + `currentTime` increasing) therefore covers
 *            the module's contract with the media element, NOT real decoding.
 *            `jsdom does not decode media (honest coverage limit)` pins that gap
 *            down so nobody mistakes this suite for a playback test.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')
const CORE_PATH = path.join(PLUGIN_ROOT, 'desktop', 'src', '00-core.js')
const LAYER_PATH = path.join(PLUGIN_ROOT, 'desktop', 'src', '10-layer.js')
const CORE_SOURCE = readFileSync(CORE_PATH, 'utf8')
const LAYER_SOURCE = readFileSync(LAYER_PATH, 'utf8')

// --------------------------------------------------------------------------- //
// dev-only dependency resolution (jsdom 29) — never a plugin runtime import
// --------------------------------------------------------------------------- //

const DEP_BASES = [
  process.env.WE_NODE_MODULES,
  // The Hermes tree that owns this plugin: <HERMES_HOME>/hermes-agent.
  // Relative to the plugin so a clone never carries someone's install path.
  path.join(PLUGIN_ROOT, '..', '..', 'hermes-agent'),
  path.join(PLUGIN_ROOT, '..', '..'),
  PLUGIN_ROOT,
].filter(Boolean)

function resolveDeps() {
  const tried = []
  for (const base of DEP_BASES) {
    try {
      const req = createRequire(pathToFileURL(path.join(base, 'package.json')).href)
      const jsdom = req('jsdom')
      return { JSDOM: jsdom.JSDOM, VirtualConsole: jsdom.VirtualConsole, base }
    } catch (error) {
      tried.push(`${base}: ${error.message.split('\n')[0]}`)
    }
  }
  return { error: tried.join(' | ') }
}

const DEPS = resolveDeps()

// --------------------------------------------------------------------------- //
// loading the concatenated product shape
// --------------------------------------------------------------------------- //

const IMPORT_RE = /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm

const LAYER_SYMBOLS = [
  'WE_LAYER_ROOT_ATTR',
  'WE_LAYER_ROOT_CLASS',
  'WE_LAYER_STYLE_ID',
  'WE_LAYER_CLASS',
  'WE_LAYER_MEDIA_CLASS',
  'WE_LAYER_VIDEO_CLASS',
  'WE_LAYER_IMAGE_CLASS',
  'WE_LAYER_FALLBACK_CLASS',
  'WE_LAYER_IN_CLASS',
  'WE_LAYER_OUT_CLASS',
  'WE_LAYER_CONTENT_TIMEOUT_MS',
  'WE_LAYER_FADE_MS',
  'WE_LAYER_RENDERED_KINDS',
  'WE_LAYER_SCRIM_CLASS',
  'WE_LAYER_CSS',
  'weLayerRuntime',
  'weLayerSettings',
  'weLayerRound',
  'weLayerLookFilter',
  'weLayerApplyScrim',
  'weLayerPlayUrl',
  'weLayerPreviewUrl',
  'weLayerEnsureStyle',
  'weLayerEnsureRoot',
  'weLayerCreateNode',
  'weLayerApplySettings',
  'weLayerArmReveal',
  'weLayerContentReady',
  'weLayerContentFailed',
  'weLayerActivate',
  'weLayerActivateStatic',
  'weLayerFallback',
  'weLayerSetCurrent',
  'weLayerSync',
  'weLayerMount',
  'weLayerDispose',
  'weLayerReload',
  'weLayerState',
  'weLayerRoot',
]

const CORE_SYMBOLS = [
  'WE_LAYER',
  'WE_TOAST',
  'WE_BOOT',
  'weGetState',
  'weSet',
  'weGetStore',
  'weToast',
  'weApplyConfig',
  'weApplyLibrary',
  'weIsPlayable',
  'weMediaOrigin',
]

const SYMBOLS = [...CORE_SYMBOLS, ...LAYER_SYMBOLS]

const REACT_STUB = {
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot()
  },
}

function loadBundle() {
  const matches = Array.from(CORE_SOURCE.matchAll(IMPORT_RE))
  assert.equal(matches.length, 1, 'the core part must contain exactly one import statement')
  const [statement] = matches
  assert.equal(statement[2], 'react', 'the only import must be the whitelisted react binding')
  const coreBody = CORE_SOURCE.replace(statement[0], '')
  const body = `${coreBody}\n${LAYER_SOURCE}`
  const factory = new Function(
    '__react',
    '__names',
    `const { useSyncExternalStore } = __react;\n${body}\nreturn __names.reduce(function collect(acc, name) { acc[name] = eval(name); return acc }, {})`,
  )
  return factory(REACT_STUB, SYMBOLS)
}

// --------------------------------------------------------------------------- //
// fixtures
// --------------------------------------------------------------------------- //

function makeConfig(overrides = {}) {
  return {
    version: 2,
    currentId: 'id-a',
    settings: {
      enabled: true,
      scrim: 0.25,
      panelBase: 55,
      cardBase: 45,
      wallpaperBlur: 0,
      wallpaperOpacity: 100,
      brightness: 100,
      contrast: 100,
      saturate: 100,
      objectFit: 'cover',
      flip: false,
      playbackRate: 1,
      videoMuted: true,
      videoVolume: 0,
      pauseOnHidden: true,
      pauseOnBlur: false,
      sceneLive: true,
      sceneLiveFps: 15,
      switchTransition: 'fade',
      rotation: { enabled: false, intervalMinutes: 10, shuffle: false },
      typeFilter: 'all',
      contentRating: 'all',
      userProps: {},
      extraLibraryRoots: [],
      ...(overrides.settings || {}),
    },
    ...(overrides.currentId === undefined ? {} : { currentId: overrides.currentId }),
    ...(overrides.version === undefined ? {} : { version: overrides.version }),
  }
}

function makeItem(overrides = {}) {
  return {
    id: 'id-a',
    weId: '2001',
    kind: 'video',
    title: 'A 壁纸',
    source: 'workshop',
    path: 'C:/lib/2001/a.mp4',
    dir: 'C:/lib/2001',
    entry: null,
    preview: null,
    rating: 'everyone',
    sizeBytes: 1024,
    mtimeMs: 1700000000000,
    props: {},
    schemeColor: 'rgb(10,20,30)',
    play: { type: 'video', url: '/m/tok-a' },
    ...overrides,
  }
}

const ORIGIN = 'http://127.0.0.1:7788'

// --------------------------------------------------------------------------- //
// ctx double: the flat, disposer-returning timer surface (F22) + a manual clock
// --------------------------------------------------------------------------- //

function makeCtx() {
  const timers = []
  const restCalls = []
  return {
    timers,
    restCalls,
    storage: {},
    setTimeout(fn, ms) {
      const entry = { fn, ms, cleared: false, fired: false }
      timers.push(entry)
      return function dispose() {
        entry.cleared = true
      }
    },
    onDispose() {
      restCalls.push({ path: 'onDispose' })
    },
    rest(suffix, opts) {
      restCalls.push({ path: suffix, opts })
      return Promise.resolve({ ok: true, config: null })
    },
  }
}

function liveTimers(ctx, ms) {
  return ctx.timers.filter(
    (entry) => !entry.cleared && !entry.fired && (ms === undefined || entry.ms === ms),
  )
}

function fireTimer(entry) {
  entry.fired = true
  entry.fn()
}

/** Fire the product's own content gate — no constant is changed for the test. */
function fireContentGate(ctx, ms = 2000) {
  const gate = liveTimers(ctx, ms)[0]
  assert.ok(gate, `expected one armed ${ms}ms gate, timers=${JSON.stringify(ctx.timers.map((t) => t.ms))}`)
  fireTimer(gate)
}

// --------------------------------------------------------------------------- //
// media stub (jsdom cannot decode) + boot harness
// --------------------------------------------------------------------------- //

/**
 * Replace the jsdom media pipeline with a hand-cranked one. Clearly a stub:
 * `readyState`, `paused` and `currentTime` motion are simulated.
 */
function installMediaStub(dom) {
  const proto = dom.window.HTMLMediaElement.prototype
  Object.defineProperty(proto, 'readyState', {
    configurable: true,
    get() {
      return typeof this.__readyState === 'number' ? this.__readyState : 0
    },
  })
  Object.defineProperty(proto, 'paused', {
    configurable: true,
    get() {
      return this.__paused !== false
    },
  })
  proto.play = function play() {
    this.__paused = false
    this.__playCalls = (this.__playCalls || 0) + 1
    return Promise.resolve()
  }
  proto.pause = function pause() {
    this.__paused = true
    this.__pauseCalls = (this.__pauseCalls || 0) + 1
  }
  proto.load = function load() {
    this.__loadCalls = (this.__loadCalls || 0) + 1
  }
  proto.__advance = function advance(ms) {
    if (this.__paused === false) {
      this.currentTime = (this.currentTime || 0) + ms / 1000
    }
    return this.currentTime
  }
}

function makeDom(jsdomDepless) {
  const { JSDOM, VirtualConsole } = DEPS
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {}) // "Not implemented: HTMLMediaElement..." noise
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { virtualConsole })
  return dom
}

function setup(options = {}) {
  if (DEPS.error) {
    throw new Error(`jsdom unavailable: ${DEPS.error}`)
  }
  const core = loadBundle()
  const dom = makeDom()
  if (options.stubMedia !== false) {
    installMediaStub(dom)
  }
  globalThis.document = dom.window.document
  globalThis.window = dom.window
  if (options.viewport) {
    // jsdom has no layout engine: pin the window viewport so the cold-start
    // "no box yet" path is reachable in tests.
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: options.viewport[0] })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: options.viewport[1] })
  }
  const ctx = makeCtx()
  const items = options.items || [makeItem()]
  core.weApplyLibrary({
    engineFound: true,
    mediaOrigin: options.mediaOrigin === undefined ? ORIGIN : options.mediaOrigin,
    errors: [],
    items,
  })
  core.weApplyConfig(options.config || makeConfig())
  core.weLayerMount(ctx)
  return {
    core,
    dom,
    doc: dom.window.document,
    ctx,
    root: () => dom.window.document.querySelector('[data-wallpaper-layer]'),
    layers: () => Array.from(dom.window.document.querySelectorAll('.we-layer')),
    state: () => core.weLayerState(),
    storeLayer: () => core.weGetState().layer,
  }
}

function layerOf(id) {
  return globalThis.document.querySelector(`.we-layer[data-we-id="${id}"]`)
}

function videoOf(id) {
  const layer = layerOf(id)
  return layer ? layer.querySelector('video') : null
}

function fire(dom, target, type) {
  target.dispatchEvent(new dom.window.Event(type))
}

// --------------------------------------------------------------------------- //
// DOM structure
// --------------------------------------------------------------------------- //

test('mounts one bottom-most, pointer-transparent host box on document.body', () => {
  const env = setup()
  const root = env.root()
  assert.ok(root, 'a [data-wallpaper-layer] host must exist')
  assert.equal(root.parentNode, env.doc.body)
  assert.equal(root.className, 'we-layer-stack')
  assert.equal(root.getAttribute('aria-hidden'), 'true')
  assert.equal(root.style.position, 'fixed')
  assert.equal(root.style.zIndex, '-1')
  assert.equal(root.style.pointerEvents, 'none')
  assert.equal(root.style.top, '0px')
  assert.equal(root.style.left, '0px')

  const style = env.doc.getElementById('we-layer-style')
  assert.ok(style, 'the keyframes stylesheet must be injected')
  assert.match(style.textContent, /@keyframes we-layer-fade-in/)
  assert.match(style.textContent, /\.we-layer--switch-in/)
})

test('a video wallpaper becomes .we-layer--video > video.we-layer__media and enters loading', () => {
  const env = setup()
  assert.equal(env.storeLayer(), 'loading')

  const layers = env.layers()
  assert.equal(layers.length, 1)
  const layer = layers[0]
  assert.ok(layer.classList.contains('we-layer'))
  assert.ok(layer.classList.contains('we-layer--video'))
  assert.equal(layer.getAttribute('data-we-id'), 'id-a')
  assert.equal(layer.style.opacity, '1')
  assert.equal(layer.style.pointerEvents, 'none')

  const video = layer.querySelector('video.we-layer__media')
  assert.ok(video, 'the media child must be a <video>')
  assert.equal(video.getAttribute('src'), `${ORIGIN}/m/tok-a`)
  assert.ok(video.hasAttribute('playsinline'))
  assert.ok(video.hasAttribute('preload'))
  assert.equal(video.loop, true)
  assert.equal(video.muted, true, 'settings.videoMuted=true must mute the element')
  assert.equal(video.controls, false)
})

test('an image wallpaper renders <img class="we-layer__media">', () => {
  const env = setup({
    items: [makeItem({ id: 'id-img', kind: 'image', play: { type: 'image', url: '/m/tok-img' } })],
    config: makeConfig({ currentId: 'id-img' }),
  })
  const layer = env.layers()[0]
  assert.ok(layer.classList.contains('we-layer--image'))
  const img = layer.querySelector('img.we-layer__media')
  assert.ok(img, 'the media child must be an <img>')
  assert.equal(img.getAttribute('src'), `${ORIGIN}/m/tok-img`)
  assert.equal(env.storeLayer(), 'loading')
})

test('root is a single element across switches (no host leak)', () => {
  const env = setup({ items: [makeItem(), makeItem({ id: 'id-b', play: { type: 'video', url: '/m/tok-b' } })] })
  env.core.weApplyConfig(makeConfig({ currentId: 'id-b' }))
  assert.equal(env.doc.querySelectorAll('[data-wallpaper-layer]').length, 1)
})

// --------------------------------------------------------------------------- //
// state machine — happy path
// --------------------------------------------------------------------------- //

test('loadeddata: loading -> active, gate disarmed, media playing', () => {
  const env = setup()
  const video = videoOf('id-a')
  assert.equal(liveTimers(env.ctx, 2000).length, 1, 'one 2s gate while loading')

  video.__readyState = 4
  fire(env.dom, video, 'loadeddata')

  assert.equal(env.storeLayer(), 'active')
  assert.equal(env.state().mode, 'live')
  assert.equal(liveTimers(env.ctx, 2000).length, 0, 'the gate must be disarmed on loaded')
  assert.equal(video.__playCalls, 1)
  assert.equal(layerOf('id-a').getAttribute('data-we-state'), 'active')
})

test('canplay also counts as loaded (readyState>=2 browsers vary on which fires first)', () => {
  const env = setup()
  const video = videoOf('id-a')
  video.__readyState = 3
  fire(env.dom, video, 'canplay')
  assert.equal(env.storeLayer(), 'active')
})

test('re-selecting the same wallpaper does not build a second layer', () => {
  const env = setup()
  const video = videoOf('id-a')
  video.__readyState = 4
  fire(env.dom, video, 'loadeddata')

  env.core.weApplyConfig(makeConfig()) // same currentId again
  assert.equal(env.layers().length, 1)
  assert.equal(env.storeLayer(), 'active')
})

// --------------------------------------------------------------------------- //
// T16d / T16e — cut vs fade
// --------------------------------------------------------------------------- //

function activateA(env) {
  const video = videoOf('id-a')
  video.__readyState = 4
  fire(env.dom, video, 'loadeddata')
  assert.equal(env.storeLayer(), 'active')
  return { layer: layerOf('id-a'), video }
}

test('T16d cut: the old layer is removed before the new content is ready, with no transition class', () => {
  const env = setup({
    items: [makeItem(), makeItem({ id: 'id-b', title: 'B', play: { type: 'video', url: '/m/tok-b' } })],
    config: makeConfig({ settings: { switchTransition: 'cut' } }),
  })
  const a = activateA(env)

  env.core.weApplyConfig(makeConfig({ currentId: 'id-b', settings: { switchTransition: 'cut' } }))

  // The new layer has not reported loadeddata yet.
  assert.equal(env.storeLayer(), 'loading')
  assert.equal(a.layer.parentNode, null, 'cut must detach the old layer immediately')
  assert.equal(a.video.__pauseCalls, 1, 'cut releases the old media (pause)')
  assert.ok(a.video.__loadCalls >= 1, `cut releases the old media (load after src=""), got ${a.video.__loadCalls}`)
  assert.equal(a.video.getAttribute('src'), '', 'src must be cleared')

  const layers = env.layers()
  assert.equal(layers.length, 1)
  assert.equal(layers[0].getAttribute('data-we-id'), 'id-b')
  for (const layer of layers) {
    assert.ok(!layer.classList.contains('we-layer--switch-in'), 'cut is not a fade-in')
    assert.ok(!layer.classList.contains('we-layer--switch-out'), 'cut never fades anything out')
  }
  assert.equal(layers[0].style.animationDuration, '', 'cut sets no transition duration')
})

test('T16e fade: the old layer stays pinned at opacity:1 (never faded out) until the new layer loads', () => {
  const env = setup({
    items: [makeItem(), makeItem({ id: 'id-b', title: 'B', play: { type: 'video', url: '/m/tok-b' } })],
    config: makeConfig({ settings: { switchTransition: 'fade' } }),
  })
  const a = activateA(env)
  const root = env.root()

  env.core.weApplyConfig(makeConfig({ currentId: 'id-b', settings: { switchTransition: 'fade' } }))

  assert.equal(env.storeLayer(), 'loading')
  assert.equal(a.layer.parentNode, root, 'fade keeps the old layer mounted as the underlay')
  assert.equal(a.layer.style.opacity, '1', 'the underlay must stay opaque')
  assert.ok(!a.layer.classList.contains('we-layer--switch-out'), 'the old layer must not fade out')
  assert.equal(a.layer.getAttribute('data-we-state'), 'retired')
  assert.ok(!a.video.__pauseCalls, 'the old media keeps rendering during the fade')

  const incoming = layerOf('id-b')
  assert.ok(incoming, 'the incoming layer is mounted on top')
  assert.ok(incoming.classList.contains('we-layer--switch-in'), 'fade-in belongs to the incoming layer')
  assert.equal(incoming.style.animationDuration, '1800ms', 'F24 base duration')

  const nextVideo = incoming.querySelector('video')
  nextVideo.__readyState = 4
  fire(env.dom, nextVideo, 'loadeddata')

  assert.equal(env.storeLayer(), 'active')
  assert.equal(a.layer.parentNode, null, 'the old layer is retired only after the new one loaded')
  assert.equal(a.video.__pauseCalls, 1, 'retiring the old layer releases its media')
  assert.ok(!incoming.classList.contains('we-layer--switch-in'), 'snapped to full opacity before the underlay dies')
  assert.equal(incoming.style.opacity, '1')
  const layers = env.layers()
  assert.equal(layers.length, 1)
})

test('fade: switching again mid-load keeps exactly one underlay and one gate', () => {
  const env = setup({
    items: [
      makeItem(),
      makeItem({ id: 'id-b', play: { type: 'video', url: '/m/tok-b' } }),
      makeItem({ id: 'id-c', play: { type: 'video', url: '/m/tok-c' } }),
    ],
    config: makeConfig({ settings: { switchTransition: 'fade' } }),
  })
  activateA(env)
  env.core.weApplyConfig(makeConfig({ currentId: 'id-b', settings: { switchTransition: 'fade' } }))
  env.core.weApplyConfig(makeConfig({ currentId: 'id-c', settings: { switchTransition: 'fade' } }))

  const ids = env.layers().map((layer) => layer.getAttribute('data-we-id'))
  assert.deepEqual(ids, ['id-b', 'id-c'], 'the superseded pending layer is dropped, the underlay stays')
  assert.equal(env.state().pendingId, 'id-c')
  assert.equal(env.state().gated, true)
  assert.equal(liveTimers(env.ctx, 2000).length, 1, 'exactly one live gate')
})

// --------------------------------------------------------------------------- //
// 2s content gate -> fallback (§7.4)
// --------------------------------------------------------------------------- //

test('2s gate expiry with a preview: loading -> fallback, preview image becomes the layer', () => {
  const env = setup({
    items: [makeItem({ preview: 'C:\\lib\\2001\\preview.jpg' })],
  })
  assert.equal(env.storeLayer(), 'loading')
  assert.equal(videoOf('id-a').getAttribute('src'), `${ORIGIN}/m/tok-a`)

  fireContentGate(env.ctx)

  assert.equal(env.storeLayer(), 'fallback')
  const fallback = env.doc.querySelector('.we-layer--fallback')
  assert.ok(fallback, 'the preview layer must exist')
  const img = fallback.querySelector('img.we-layer__media')
  assert.ok(img)
  assert.equal(img.getAttribute('src'), 'file:///C:/lib/2001/preview.jpg')
  assert.equal(env.layers().length, 1, 'the failed live layer is gone')
  assert.equal(env.doc.querySelectorAll('.we-layer--video').length, 0)

  // preview loaded -> active-static, reported as `fallback` (enum has no active-static)
  fire(env.dom, img, 'load')
  assert.equal(env.state().mode, 'static')
  assert.equal(env.storeLayer(), 'fallback')
  assert.equal(fallback.getAttribute('data-we-state'), 'static')
  assert.equal(liveTimers(env.ctx, 2000).length, 0)
})

test('2s gate expiry without a preview: layer removed, idle + error toast', () => {
  const env = setup()
  fireContentGate(env.ctx)

  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
  const toast = env.core.weGetState().toast
  assert.ok(toast, 'a toast must be raised')
  assert.equal(toast.kind, 'error')
  assert.match(toast.text, /加载|超时/)
  assert.equal(env.state().gated, false)
})

test('fallback preview failure: idle + error toast', () => {
  const env = setup({ items: [makeItem({ preview: 'C:\\lib\\2001\\preview.jpg' })] })
  fireContentGate(env.ctx)
  const img = env.doc.querySelector('.we-layer--fallback img')
  fire(env.dom, img, 'error')

  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
  assert.equal(env.core.weGetState().toast.kind, 'error')
  assert.match(env.core.weGetState().toast.text, /预览图/)
})

test('media error event takes the same fallback branch as the timeout', () => {
  const env = setup({ items: [makeItem({ preview: 'C:\\lib\\2001\\preview.jpg' })] })
  fire(env.dom, videoOf('id-a'), 'error')
  assert.equal(env.storeLayer(), 'fallback')
  assert.ok(env.doc.querySelector('.we-layer--fallback'))
})

test('no media origin: degrade to the preview instead of building a broken <video>', () => {
  const env = setup({ mediaOrigin: '', items: [makeItem({ preview: 'D:/lib/p.jpg' })] })
  assert.equal(env.storeLayer(), 'fallback')
  assert.equal(env.doc.querySelectorAll('video').length, 0)
  const img = env.doc.querySelector('.we-layer--fallback img')
  assert.equal(img.getAttribute('src'), 'file:///D:/lib/p.jpg')
})

test('no media origin and no preview: idle + toast naming the media server', () => {
  const env = setup({ mediaOrigin: '' })
  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
  assert.match(env.core.weGetState().toast.text, /媒体服务不可用/)
})

// --------------------------------------------------------------------------- //
// cold-start recovery: heavy gate + bounded auto-retry
// --------------------------------------------------------------------------- //

test('a scene gets the 15s gate; a video keeps the 2s budget', () => {
  const scene = setup({ items: [sceneItem()], config: makeConfig({ currentId: 'id-scene' }) })
  assert.equal(liveTimers(scene.ctx, 15000).length, 1, 'the scene gate must be the long one')
  assert.equal(liveTimers(scene.ctx, 2000).length, 0, 'a scene must not be judged by the 2s budget')

  const video = setup()
  assert.equal(liveTimers(video.ctx, 2000).length, 1)
  assert.equal(liveTimers(video.ctx, 15000).length, 0)
})

test('a fallback re-arms one retry and the live layer comes back by itself', () => {
  const env = setup({ items: [makeItem({ preview: 'C:\\lib\\2001\\preview.jpg' })] })
  fireContentGate(env.ctx)
  assert.equal(env.storeLayer(), 'fallback')

  const retry = liveTimers(env.ctx, 5000)
  assert.equal(retry.length, 1, 'exactly one retry armed after a transient failure')
  fireTimer(retry[0])

  assert.equal(env.storeLayer(), 'loading', 'the retry rebuilds the live layer, not the preview')
  assert.ok(env.doc.querySelector('.we-layer--video video'), 'the live <video> is back')
  assert.ok(env.state().notes.some((note) => note.indexOf('retry:') === 0))
})

test('auto-retry stops after two attempts so a broken wallpaper settles', () => {
  const env = setup({ items: [makeItem({ preview: 'C:\\lib\\2001\\preview.jpg' })] })
  fireContentGate(env.ctx)
  fireTimer(liveTimers(env.ctx, 5000)[0])
  fireContentGate(env.ctx)
  fireTimer(liveTimers(env.ctx, 5000)[0])
  fireContentGate(env.ctx)

  assert.equal(env.storeLayer(), 'fallback')
  assert.equal(liveTimers(env.ctx, 5000).length, 0, 'a third retry would loop on a broken wallpaper')
  assert.ok(env.state().notes.some((note) => note.indexOf('retry-exhausted:') === 0))
})

test('the fallback preview is contained, never cover-cropped like a wallpaper', () => {
  const env = setup({ items: [makeItem({ preview: 'C:\\lib\\2001\\preview.jpg' })] })
  fireContentGate(env.ctx)
  const img = env.doc.querySelector('.we-layer--fallback img')
  assert.equal(img.style.objectFit, 'contain', 'a 1:1 preview must not be blown up by cover')
})

// --------------------------------------------------------------------------- //
// unsupported kinds
// --------------------------------------------------------------------------- //

test('application wallpapers build no layer and raise no toast (not user-selectable)', () => {
  const env = setup({
    items: [makeItem({ id: 'id-app', kind: 'application', play: null })],
    config: makeConfig({ currentId: 'id-app' }),
  })
  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
  assert.equal(env.core.weGetState().toast, null)
  assert.ok(env.state().notes.some((note) => note.includes('unsupported')))
})

test('web wallpapers mount the WebWallGL render page with type=web', () => {
  const env = setup({
    items: [
      makeItem({
        id: 'id-web',
        kind: 'web',
        path: null,
        entry: 'index.html',
        dir: 'C:/lib/4001',
        preview: 'C:/lib/4001/preview.jpg',
        play: { type: 'web', url: '/s/tok-web/index.html' },
      }),
    ],
    config: makeConfig({ currentId: 'id-web' }),
  })
  const layer = env.layers()[0]
  assert.ok(layer.classList.contains('we-layer--web'))
  const frame = layer.querySelector('iframe.we-layer__media')
  assert.ok(frame, 'web renders as an iframe (author page inside the render page)')

  const q = new URL(frame.getAttribute('src')).searchParams
  assert.equal(q.get('type'), 'web', 'type=web dispatches to the renderer web chain')
  assert.equal(q.get('src'), '/s/tok-web/index.html', 'web src IS the author page, not a directory base')
  assert.equal(q.get('mediaBase'), ORIGIN)
  assert.equal(q.get('opaque'), '1')
  assert.equal(env.storeLayer(), 'loading')

  fire(env.dom, frame, 'load')
  assert.equal(env.storeLayer(), 'active')
})

test('switching from a live video to an application item removes the layer', () => {
  const env = setup({
    items: [makeItem(), makeItem({ id: 'id-app', kind: 'application', play: null })],
  })
  activateA(env)
  env.core.weApplyConfig(makeConfig({ currentId: 'id-app' }))
  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
})

test('a refused selection is sticky: later store writes do not re-run the refusal', () => {
  // `application` is the one kind that is not playable at all (needs an
  // external process), so it takes the refuse branch and is remembered.
  const env = setup({
    items: [makeItem({ id: 'id-app', kind: 'application', play: null })],
    config: makeConfig({ currentId: 'id-app' }),
  })
  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
  const notesAfterRefusal = env.state().notes.length

  // Any other store write (a panel toggle, a settings change) re-notifies the
  // subscription; the refusal must not run again (that would recurse forever).
  env.core.weSet({ panelOpen: true })
  assert.equal(env.layers().length, 0)
  assert.equal(env.state().notes.length, notesAfterRefusal, 'the refusal must not be re-noted')
})

test('weLayerReload retries a failed selection on purpose', () => {
  const env = setup({ items: [makeItem({ preview: 'C:\\lib\\p.jpg' })] })
  fireContentGate(env.ctx)
  assert.equal(env.storeLayer(), 'fallback')

  env.core.weLayerReload()
  assert.equal(env.storeLayer(), 'loading', 'reload rebuilds the live layer')
  assert.equal(env.doc.querySelectorAll('video').length, 1)
})

// --------------------------------------------------------------------------- //
// enabled=false (§7.6) + dispose
// --------------------------------------------------------------------------- //

test('enabled=false removes the layer and returns to idle; re-enabling reloads', () => {
  const env = setup()
  activateA(env)
  const video = videoOf('id-a')

  env.core.weApplyConfig(makeConfig({ settings: { enabled: false } }))

  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.layers().length, 0)
  assert.equal(env.state().currentId, null, 'the id is dropped so re-enabling re-applies it')
  assert.equal(video.__pauseCalls, 1, 'disabling releases the media')
  assert.equal(liveTimers(env.ctx, 2000).length, 0)

  env.core.weApplyConfig(makeConfig({ settings: { enabled: true } }))
  assert.equal(env.storeLayer(), 'loading')
  assert.equal(env.layers().length, 1)
})

test('weLayerDispose tears down DOM, stylesheet, timers, listeners and the subscription', () => {
  const env = setup({
    items: [makeItem(), makeItem({ id: 'id-b', play: { type: 'video', url: '/m/tok-b' } })],
  })
  activateA(env)
  env.core.weApplyConfig(makeConfig({ currentId: 'id-b' })) // leaves a live gate
  const gate = liveTimers(env.ctx, 2000)[0]
  assert.ok(gate, 'sanity: a gate is armed while loading')

  env.core.weLayerDispose()

  assert.equal(env.doc.querySelector('[data-wallpaper-layer]'), null, 'host box removed')
  assert.equal(env.doc.getElementById('we-layer-style'), null, 'stylesheet removed')
  assert.equal(env.layers().length, 0)
  assert.equal(gate.cleared, true, 'the gate timer disposer must run')
  assert.equal(env.storeLayer(), 'idle')
  assert.equal(env.core.weGetStore().listenerCount(), 0, 'store subscription removed')
  assert.equal(env.state().mounted, false)

  // A late store change must not resurrect anything.
  env.core.weApplyConfig(makeConfig({ currentId: 'id-a' }))
  assert.equal(env.doc.querySelector('[data-wallpaper-layer]'), null)
})

test('dispose on an unmounted layer is a no-op (idempotent)', () => {
  const env = setup()
  env.core.weLayerDispose()
  env.core.weLayerDispose()
  assert.equal(env.state().mounted, false)
  assert.equal(env.storeLayer(), 'idle')
})

// --------------------------------------------------------------------------- //
// settings projection + visibility pause
// --------------------------------------------------------------------------- //

test('object-fit / flip / playback rate / audio settings land on the media element', () => {
  const env = setup({
    config: makeConfig({
      settings: { objectFit: 'contain', flip: true, playbackRate: 1.5, videoMuted: false, videoVolume: 0.4 },
    }),
  })
  const video = videoOf('id-a')
  assert.equal(video.style.objectFit, 'contain')
  assert.equal(video.style.transform, 'scaleX(-1)')
  assert.equal(video.playbackRate, 1.5)
  assert.equal(video.muted, false)
  assert.equal(video.volume, 0.4)
})

test('settings changes are re-applied to the live layer without a reload', () => {
  const env = setup()
  activateA(env)
  env.core.weApplyConfig(makeConfig({ settings: { objectFit: 'fill', playbackRate: 2 } }))
  const video = videoOf('id-a')
  assert.equal(video.style.objectFit, 'fill')
  assert.equal(video.playbackRate, 2)
  assert.equal(env.layers().length, 1, 'no rebuild for a look change')
})

test('visibility hidden pauses playback but keeps store.layer=active (enum has no paused)', () => {
  const env = setup()
  const { video } = activateA(env)
  let visibility = 'visible'
  Object.defineProperty(env.doc, 'visibilityState', { configurable: true, get: () => visibility })

  visibility = 'hidden'
  fire(env.dom, env.doc, 'visibilitychange')

  assert.equal(env.state().paused, true)
  assert.equal(video.__pauseCalls, 1)
  assert.equal(env.storeLayer(), 'active', 'layer stays active; the pause is a runtime flag')

  const playsBefore = video.__playCalls
  visibility = 'visible'
  fire(env.dom, env.doc, 'visibilitychange')
  assert.equal(env.state().paused, false)
  assert.ok(video.__playCalls > playsBefore, 'resume replays the media')
})

// --------------------------------------------------------------------------- //
// T14 — readyState / currentTime (media stub: NOT real decoding)
// --------------------------------------------------------------------------- //

test('T14 (stubbed media) active video reports readyState>=2 and an advancing currentTime', () => {
  const env = setup()
  const video = videoOf('id-a')

  // Stub of the browser's decode pipeline: this is what jsdom cannot do.
  video.__readyState = 4
  fire(env.dom, video, 'loadeddata')
  assert.equal(env.storeLayer(), 'active')
  assert.ok(video.readyState >= 2, `readyState=${video.readyState}`)

  // Stub playback clock: 0 -> 0.5s -> 1.0s while playing.
  const t0 = video.currentTime
  const t1 = video.__advance(500)
  const t2 = video.__advance(500)
  assert.equal(t0, 0)
  assert.ok(t1 > t0, `currentTime must advance: ${t0} -> ${t1}`)
  assert.ok(t2 > t1, `currentTime must keep advancing: ${t1} -> ${t2}`)
  assert.equal(video.paused, false, 'the module called play()')
})

test('jsdom does not decode media (honest coverage limit)', async () => {
  const env = setup({ stubMedia: false })
  const video = videoOf('id-a')
  assert.equal(video.readyState, 0, 'jsdom never decodes: readyState stays 0')
  assert.equal(video.paused, true)

  // Give a real macrotask a chance: no loadeddata/load will ever arrive on its own.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(env.storeLayer(), 'loading', 'the module waits for a real event nobody sent')
})

// --------------------------------------------------------------------------- //
// source hygiene (T10b/T10c at the source level)
// --------------------------------------------------------------------------- //

test('the layer part declares no import/export and never touches ctx.timer', () => {
  assert.equal(
    Array.from(LAYER_SOURCE.matchAll(IMPORT_RE)).length,
    0,
    'no import statement of any kind is allowed outside the core part',
  )
  assert.equal(/^\s*export\b/m.test(LAYER_SOURCE), false, 'no export is allowed here')
  assert.equal(/\bctx\s*\.\s*timer\b/.test(LAYER_SOURCE), false, 'ctx.timer does not exist (F22)')
  assert.equal(/\bctx\s*\.\s*setInterval\b/.test(LAYER_SOURCE), false, 'rotation is not this module')

  // every scheduling call must go through ctx.setTimeout
  const withoutCtxCalls = LAYER_SOURCE.replace(/ctx\.setTimeout/g, '')
  assert.equal(/(^|[^.\w])setTimeout\s*\(/m.test(withoutCtxCalls), false, 'no bare setTimeout')
  assert.equal(/(^|[^.\w])setInterval\s*\(/m.test(withoutCtxCalls), false, 'no bare setInterval')
})

test('the layer part does not leak sibling source file names into the product', () => {
  for (const needle of ['./00-core.js', './10-layer.js', './99-register.js', '../desktop']) {
    assert.equal(LAYER_SOURCE.includes(needle), false, `${needle} must not appear`)
  }
})

test('url helpers: play URL needs an origin, preview path becomes a file URL', () => {
  const core = loadBundle()
  const state = { library: { mediaOrigin: 'http://127.0.0.1:1/' } }
  assert.equal(core.weLayerPlayUrl(state, makeItem()), 'http://127.0.0.1:1/m/tok-a')
  assert.equal(core.weLayerPlayUrl({ library: { mediaOrigin: '' } }, makeItem()), '')
  assert.equal(core.weLayerPlayUrl(state, makeItem({ play: null })), '')
  assert.equal(core.weLayerPreviewUrl(state, makeItem({ preview: null })), '')
  assert.equal(core.weLayerPreviewUrl(state, makeItem({ preview: 'C:\\a b\\p.jpg' })), 'file:///C:/a%20b/p.jpg')
  assert.equal(core.weLayerPreviewUrl(state, makeItem({ preview: 'https://x/y.png' })), 'https://x/y.png')
  assert.equal(core.weLayerPreviewUrl(state, makeItem({ preview: '/p/1' })), 'http://127.0.0.1:1/p/1')
})

// ---------------------------------------------------------------------------
// the opaque <html> background — the bug that made a working layer invisible
// ---------------------------------------------------------------------------

test('the layer clears an opaque <html> background and restores it on teardown', () => {
  // The host's boot script pins an OPAQUE inline background on <html>
  // (apps/desktop/index.html). A z-index:-1 layer sits BEHIND that paint, so the
  // wallpaper was fully covered: node in the DOM, video loading, nothing
  // visible. weLayerEnsureRoot therefore snapshots the inline value, writes
  // `transparent`, and weLayerDispose puts the snapshot back — never a guess.
  const warm = setup()
  const html = warm.doc.documentElement
  warm.core.weLayerDispose() // release the layer setup() built

  // Seed the host's real posture: an OPAQUE inline background. NOTE: jsdom
  // normalises `#111111` to `rgb(17, 17, 17)`, so the expectation is written in
  // the normalised form — the point is that restore returns WHATEVER WAS THERE,
  // not that it round-trips the literal text.
  html.style.setProperty('background-color', '#111111')
  const ORIGINAL = html.style.getPropertyValue('background-color')
  assert.equal(ORIGINAL, 'rgb(17, 17, 17)', 'the opaque baseline is in place')

  // Re-arm the layer inside the SAME document so the snapshot is taken now.
  warm.core.weLayerMount(warm.ctx)
  assert.ok(warm.root(), 'the layer host exists')
  assert.equal(
    html.style.getPropertyValue('background-color'),
    'transparent',
    'an opaque <html> background covers a z-index:-1 layer completely',
  )
  assert.equal(warm.root().style.zIndex, '-1', 'the layer keeps its design z-index')

  warm.core.weLayerDispose()
  assert.equal(
    html.style.getPropertyValue('background-color'),
    ORIGINAL,
    'teardown restores the ORIGINAL inline value, byte for byte',
  )
})

test('an already-transparent <html> baseline is preserved', () => {
  const warm = setup()
  const html = warm.doc.documentElement
  warm.core.weLayerDispose()

  html.style.setProperty('background-color', 'transparent')
  warm.core.weLayerMount(warm.ctx)
  assert.equal(html.style.getPropertyValue('background-color'), 'transparent', 'no needless write')

  warm.core.weLayerDispose()
  assert.equal(
    html.style.getPropertyValue('background-color'),
    'transparent',
    'an already-transparent baseline survives teardown unchanged',
  )
})

test('an unset <html> background is REMOVED on teardown, not set to empty', () => {
  const warm = setup()
  const html = warm.doc.documentElement
  warm.core.weLayerDispose()

  html.style.removeProperty('background-color')
  // `setup()` may leave other inline style behind, so the baseline is "the
  // background-color property is absent", not "the style attribute is empty".
  assert.equal(html.style.getPropertyValue('background-color'), '', 'baseline: background-color not set')

  warm.core.weLayerMount(warm.ctx)
  assert.equal(html.style.getPropertyValue('background-color'), 'transparent', 'cleared while mounted')

  warm.core.weLayerDispose()
  // removeProperty, NOT setProperty(''): an empty-string value would still be
  // reported by any consumer that reads the property back as "present".
  assert.equal(html.style.getPropertyValue('background-color'), '', 'the property is gone')
  assert.equal(/background-color/.test(html.getAttribute('style') || ''), false, 'no leftover declaration')
})

test('the layer also clears an opaque <body> background and restores it', () => {
  // The host paints `body { background: var(--ui-chat-surface-background) }`
  // (apps/desktop/src/styles.css:801-803). Our glass engine writes that very
  // token, so with the glass on it is translucent — but with the glass OFF it is
  // the theme's opaque colour, and an opaque body covers a z-index:-1 layer just
  // as completely as <html> did. Clearing only <html> left the wallpaper hidden.
  const env = setup()
  const html = env.doc.documentElement
  const body = env.doc.body
  env.core.weLayerDispose()

  // The host's real posture: <html> pre-painted, body inheriting an opaque token.
  html.style.setProperty('background-color', '#111111')
  body.style.setProperty('background', 'rgb(12, 12, 12)')
  const HTML_ORIGINAL = html.style.getPropertyValue('background-color')
  const BODY_ORIGINAL = body.style.getPropertyValue('background')

  env.core.weLayerMount(env.ctx)
  assert.ok(env.root(), 'the layer host exists')
  assert.equal(html.style.getPropertyValue('background-color'), 'transparent', '<html> cleared')
  assert.equal(body.style.getPropertyValue('background'), 'transparent', '<body> cleared too')

  env.core.weLayerDispose()
  assert.equal(html.style.getPropertyValue('background-color'), HTML_ORIGINAL, '<html> restored')
  assert.equal(body.style.getPropertyValue('background'), BODY_ORIGINAL, '<body> restored')
})

test('a <body> with no inline background is left unset on teardown', () => {
  const env = setup()
  const body = env.doc.body
  env.core.weLayerDispose()

  body.style.removeProperty('background')
  env.core.weLayerMount(env.ctx)
  assert.equal(body.style.getPropertyValue('background'), 'transparent', 'cleared while mounted')

  env.core.weLayerDispose()
  assert.equal(body.style.getPropertyValue('background'), '', 'the property is gone, not empty-string')
})

test('the layer clears BOTH app-shell painters and restores them', () => {
  // The host names them itself (app/contrib/controller.tsx): "this div and the
  // sidebar-wrapper above it are the app shell's two full-window opaque
  // painters". Clearing only the first is what left the wallpaper invisible on
  // 2026-10-21 even after <html> and <body> were fixed.
  //   1. #root > first element   (SidebarProvider, bg-background, h-screen)
  //   2. [data-contrib-shell]    (bg-(--ui-bg-chrome), h-screen w-screen)
  const env = setup()
  const root = env.doc.createElement('div')
  root.id = 'root'
  const outer = env.doc.createElement('div')
  outer.className = 'bg-background'
  const inner = env.doc.createElement('div')
  inner.setAttribute('data-contrib-shell', '')
  root.appendChild(outer)
  outer.appendChild(inner)
  env.doc.body.appendChild(root)
  env.core.weLayerDispose()

  outer.style.setProperty('background-color', 'rgb(30, 32, 38)')
  inner.style.setProperty('background-color', 'rgb(18, 20, 24)')
  const OUTER_ORIGINAL = outer.style.getPropertyValue('background-color')
  const INNER_ORIGINAL = inner.style.getPropertyValue('background-color')

  env.core.weLayerMount(env.ctx)
  assert.ok(env.root(), 'the layer host exists')
  assert.equal(outer.style.getPropertyValue('background-color'), 'transparent', 'outer painter cleared')
  assert.equal(inner.style.getPropertyValue('background-color'), 'transparent', 'inner painter cleared too')

  env.core.weLayerDispose()
  assert.equal(outer.style.getPropertyValue('background-color'), OUTER_ORIGINAL, 'outer restored')
  assert.equal(inner.style.getPropertyValue('background-color'), INNER_ORIGINAL, 'inner restored')
})

// --------------------------------------------------------------------------- //
// the look chain (§8.2 step 7): filter / opacity / scrim applied to the media
// --------------------------------------------------------------------------- //

function mediaOf(env) {
  const layer = env.layers()[0]
  return layer ? layer.querySelector('.we-layer__media') : null
}

test('the look chain lands on the MEDIA element, not the layer box', () => {
  const env = setup({
    config: makeConfig({
      settings: {
        brightness: 120,
        contrast: 90,
        saturate: 150,
        wallpaperBlur: 8,
        wallpaperOpacity: 60,
        scrim: 0.35,
      },
    }),
  })
  const layer = env.layers()[0]
  const media = mediaOf(env)
  assert.ok(media)

  // The box keeps its stacking guarantee — the look opacity must NOT ride on
  // it, or the switch-in animation would overwrite and then snap it.
  assert.equal(layer.style.opacity, '1', 'the layer box opacity is the fade, untouched')
  assert.ok(!layer.style.filter, 'no filter on the layer box')

  assert.equal(
    media.style.filter,
    'brightness(1.2) contrast(0.9) saturate(1.5) blur(8px)',
    'the full filter chain, mirroring 30-glass weGlassFilters',
  )
  assert.equal(media.style.opacity, '0.6', 'wallpaper opacity 60/100')
})

test('the defaults are visually neutral: unit-factor filter, opacity 1', () => {
  const env = setup()
  const media = mediaOf(env)
  assert.ok(media)
  assert.equal(media.style.filter, 'brightness(1) contrast(1) saturate(1)', 'unit factors, no blur')
  assert.equal(media.style.opacity, '1')
})

test('the scrim is a dark film under the root, above every stacked node', () => {
  const env = setup({ config: makeConfig({ settings: { scrim: 0.35 } }) })
  const root = env.root()
  const film = env.doc.querySelector('.we-layer__scrim')
  assert.ok(film, 'the scrim film exists')
  assert.equal(film.parentNode, root, 'one film per layer stack, child of the root')
  assert.equal(film.style.background, 'rgba(0, 0, 0, 0.35)')
  assert.equal(film.getAttribute('aria-hidden'), 'true')
  assert.equal(film.style.zIndex, '1', 'above the z-index:auto media nodes')
  assert.equal(film.style.pointerEvents, 'none')
})

test('scrim 0 removes the film; re-raising it recreates the film', () => {
  const env = setup({ config: makeConfig({ settings: { scrim: 0.35 } }) })
  assert.ok(env.doc.querySelector('.we-layer__scrim'), 'film at 0.35')

  env.core.weApplyConfig(makeConfig({ settings: { scrim: 0 } }))
  env.core.weLayerSync(env.ctx)
  assert.equal(env.doc.querySelector('.we-layer__scrim'), null, 'zero film is gone')

  env.core.weApplyConfig(makeConfig({ settings: { scrim: 0.5 } }))
  env.core.weLayerSync(env.ctx)
  const again = env.doc.querySelector('.we-layer__scrim')
  assert.ok(again, 'the film is back when the film is non-zero')
  assert.equal(again.style.background, 'rgba(0, 0, 0, 0.5)')
})

test('scrubbing the sliders live: sync re-applies the look without a switch', () => {
  const env = setup()
  const media = mediaOf(env)

  env.core.weApplyConfig(makeConfig({ settings: { brightness: 50, wallpaperOpacity: 80 } }))
  env.core.weLayerSync(env.ctx)
  assert.equal(media.style.filter, 'brightness(0.5) contrast(1) saturate(1)')
  assert.equal(media.style.opacity, '0.8')
  assert.equal(env.layers().length, 1, 'the same node is still current — no remount')
  assert.equal(mediaOf(env), media, 'same media element, no remount')
})

test('the layer CSS declares the scrim rules, and the surface fallback stands down when the glass engine runs', () => {
  const core = loadBundle()
  const css = core.WE_LAYER_CSS
  const text = Array.isArray(css) ? css.join('\n') : String(css)
  assert.match(text, /\.we-layer__scrim\{position:absolute;inset:0;z-index:1;pointer-events:none/)
  // The 2026-10-22 regression: this rule must key off :not([data-we-glass]) so
  // it can no longer beat the glass engine's inline rgba tints.
  assert.match(text, /:root:has\(\[data-wallpaper-layer\]\):not\(\[data-we-glass\]\)/)
})

// The CONNECTING boot mask paints with the very token the engine rewrites, so
// without a counter-rule the launch screen goes 15% opaque as soon as we mount
// (measured 2026-10-27: `rgba(24,26,30,0.15)` mid-boot) and the window's white
// backing shows through as a blank page. The host pins [data-glass-opaque] back
// to the chrome token in its own glass mode; we mirror it.
test('the boot mask is pinned back to the opaque chrome colour while the engine runs', () => {
  const core = loadBundle()
  const text = Array.isArray(core.WE_LAYER_CSS) ? core.WE_LAYER_CSS.join('\n') : String(core.WE_LAYER_CSS)
  assert.match(
    text,
    /:root\[data-we-glass\] \[data-glass-opaque\]\{background-color:var\(--ui-bg-chrome\) !important\}/,
  )
})

// Clearing <html>/<body> for the wallpaper also exposes the window's own white
// backing whenever no wallpaper pixel exists yet. Measured 2026-10-27: the mask
// left at t=6.9s, the scene's first frame landed at t=7.5s, and the screen in
// between was rgb(193,194,194). A themed floor at z-index:-2 fixes the gap
// without ever covering the wallpaper (which is z-index:-1).
test('a themed floor sits under the wallpaper so the window never flashes white', () => {
  const env = setup()
  const floor = env.doc.querySelector('.we-layer__backdrop')

  assert.ok(floor, 'the floor must exist while the layer is mounted')
  assert.equal(floor.style.zIndex, '-2', 'below the layer (-1), above the window paint')
  assert.equal(floor.style.position, 'fixed')
  assert.equal(floor.style.pointerEvents, 'none')
  assert.match(floor.style.background, /--ui-bg-chrome/)

  env.core.weLayerDispose()

  assert.equal(env.doc.querySelector('.we-layer__backdrop'), null, 'teardown removes the floor')
})

test('the chat-only card is scoped to the wallpaper and never touches the sidebars', () => {
  const core = loadBundle()
  const text = String(core.WE_LAYER_CSS)
  // chat surface becomes a card, only while the layer is mounted
  assert.match(
    text,
    /:root\[data-we-card\] \[data-chat-surface\]\{margin:12px !important;height:calc\(100% - 24px\) !important;border-radius:14px !important/,
  )
  // the material follows the 卡片玻璃 slider through the two variables
  assert.match(text, /background:color-mix\(in srgb, var\(--composer-fill, #0d1117\) var\(--we-card-pct, 55%\), transparent\) !important/)
  assert.match(text, /backdrop-filter:blur\(var\(--we-card-blur, 16px\)\) saturate\(1\.05\)/)
  // full-page views (技能与工具 / 消息平台 / …) wear the same card
  assert.match(text, /\[data-zone-body\] section\.flex\.h-full\.min-w-0\.flex-col\.overflow-hidden\{margin:12px !important;height:calc\(100% - 24px\) !important;border-radius:14px !important/)
  assert.ok(
    text.includes('[class~="bg-(--ui-chat-surface-background)"]{background:transparent !important}'),
    'the page body that paints the surface again must yield to the card',
  )
  assert.ok(
    text.includes('[data-overlay-surface] [data-glass-raised]{background:color-mix(in srgb, var(--composer-fill, #0d1117) var(--we-overlay-pct, 55%), transparent) !important;'),
    'overlay cards (定时任务/设置/命令中心) wear the same material',
  )
  // the inner composer-bounds paints the same surface colour again — it must
  // go transparent or it covers the card material
  assert.match(text, /\[data-slot="composer-bounds"\]\{background:transparent !important\}/)
  // no sidebar/editor surface is carded (user: 只卡对话区)
  assert.ok(!/\[data-slot="sidebar-wrapper"\][^{]*\{[^}]*border-radius/.test(text))
  assert.ok(!/\[data-slot="composer-bounds"\][^{]*\{[^}]*border-radius/.test(text))
})

test('界面卡片化 is the switch behind `data-we-card`, and teardown drops it', () => {
  const on = setup({ config: makeConfig({ settings: { uiCards: true } }) })
  const html = on.doc.documentElement
  assert.equal(html.getAttribute('data-we-card'), '1', 'cards on by default')

  on.core.weApplyConfig(makeConfig({ settings: { uiCards: false } }))
  on.core.weLayerSync(on.ctx)
  assert.equal(html.getAttribute('data-we-card'), null, 'off removes the hook the CSS keys on')

  on.core.weApplyConfig(makeConfig({ settings: { uiCards: true } }))
  on.core.weLayerSync(on.ctx)
  assert.equal(html.getAttribute('data-we-card'), '1', 'and back on without a reload')

  on.core.weLayerDispose()
  assert.equal(html.getAttribute('data-we-card'), null, 'teardown takes the attribute with it')
})

test('卡片玻璃 drives both card variables: 20 is a thin glass, 100 the full pane', () => {
  const thin = setup({ config: makeConfig({ settings: { cardBase: 20 } }) })
  const html = thin.doc.documentElement
  assert.equal(html.style.getPropertyValue('--we-card-pct'), '20%')
  assert.equal(html.style.getPropertyValue('--we-card-blur'), '3.2px')

  thin.core.weApplyConfig(makeConfig({ settings: { cardBase: 100 } }))
  thin.core.weLayerSync(thin.ctx)
  assert.equal(html.style.getPropertyValue('--we-card-pct'), '100%')
  assert.equal(html.style.getPropertyValue('--we-card-blur'), '16px')

  thin.core.weLayerDispose()
  assert.equal(html.style.getPropertyValue('--we-card-pct'), '', 'teardown drops our variables')
  assert.equal(html.style.getPropertyValue('--we-card-blur'), '')
})

// --------------------------------------------------------------------------- //
// scene wallpapers: the WebWallGL render page in an iframe (vendor CONTRACT §1)
// --------------------------------------------------------------------------- //

function sceneItem(overrides = {}) {
  return makeItem({
    id: 'id-scene',
    kind: 'scene',
    path: null,
    entry: 'scene.pkg',
    dir: 'C:/lib/3001',
    preview: 'C:/lib/3001/preview.jpg',
    play: { type: 'scene', url: '/s/tok-scene/scene.pkg' },
    ...overrides,
  })
}

test('a scene wallpaper mounts the WebWallGL render page as an iframe', () => {
  const env = setup({
    items: [sceneItem()],
    config: makeConfig({ currentId: 'id-scene', settings: { sceneLiveFps: 30 } }),
  })
  const layer = env.layers()[0]
  assert.ok(layer.classList.contains('we-layer--scene'), 'scene gets its own layer class')
  const frame = layer.querySelector('iframe.we-layer__media')
  assert.ok(frame, 'the media child is an iframe, not a video/img')

  const src = frame.getAttribute('src')
  assert.ok(src && src.startsWith(`${ORIGIN}/gl/host.html?`), src)
  const q = new URL(src).searchParams
  assert.equal(q.get('type'), 'scene', 'type=scene is mandatory — canvas lands on the DSH-only fallback')
  assert.equal(q.get('src'), '/s/tok-scene', 'src is the DIRECTORY base, never the entry file')
  assert.equal(q.get('mediaBase'), ORIGIN)
  assert.equal(q.get('sceneFps'), '30')
  assert.equal(q.get('muted'), 'true')
  assert.equal(q.get('opaque'), '1')
  assert.equal(env.storeLayer(), 'loading')
})

test('scene: iframe load activates the layer; error falls back to the preview', () => {
  const env = setup({ items: [sceneItem()], config: makeConfig({ currentId: 'id-scene' }) })
  fire(env.dom, env.layers()[0].querySelector('iframe'), 'load')
  assert.equal(env.storeLayer(), 'active')
  assert.equal(env.layers()[0].getAttribute('data-we-state'), 'active')

  const env2 = setup({ items: [sceneItem()], config: makeConfig({ currentId: 'id-scene' }) })
  fire(env2.dom, env2.layers()[0].querySelector('iframe'), 'error')
  const fallback = env2.layers().find((layer) => layer.classList.contains('we-layer--fallback'))
  assert.ok(fallback, 'a failed scene degrades to the preview image')
})

test('scene: fps is normalised to the legal tiers and fit follows objectFit', () => {
  const env = setup({
    items: [sceneItem()],
    config: makeConfig({ currentId: 'id-scene', settings: { sceneLiveFps: 45, objectFit: 'contain' } }),
  })
  const q = new URL(env.layers()[0].querySelector('iframe').getAttribute('src')).searchParams
  assert.equal(q.get('sceneFps'), '15', '45 is not a legal tier')
  assert.equal(q.get('fit'), 'contain')
})

test('scene: a play url that is not a token dir falls back to the preview', () => {
  const env = setup({
    // Non-/s/ URL: weLayerPlayUrl yields something, but no token can be
    // derived, so the iframe gets no src and the content gate times out.
    items: [sceneItem({ play: { type: 'scene', url: '/m/tok-scene' } })],
    config: makeConfig({ currentId: 'id-scene' }),
  })
  const frame = env.layers()[0].querySelector('iframe')
  assert.equal(frame.getAttribute('src'), null, 'no src without a token')
  assert.ok(env.state().notes.some((note) => note.indexOf('scene-url-missing') !== -1))

  fireContentGate(env.ctx, 15000)
  const fallback = env.layers().find((layer) => layer.classList.contains('we-layer--fallback'))
  assert.ok(fallback, 'the gate timeout degrades to the preview')
})

test('scene: a null play url degrades straight to the preview', () => {
  const env = setup({
    items: [sceneItem({ play: null })],
    config: makeConfig({ currentId: 'id-scene' }),
  })
  assert.equal(env.storeLayer(), 'fallback')
  assert.ok(env.layers().some((layer) => layer.classList.contains('we-layer--fallback')))
})

// A cold start mounts the shell while the host window is still hidden, so the
// window viewport is 0x0. The vendor render page measures its canvas ONCE from
// that viewport (clamped to 1), and a scene has no resize path — booting there
// froze a 1x1 canvas for the whole session (2026-10-26 21:42:
// `fit cover: view 2160x2160 scene 3840x2160 canvas 1x1`). The frame therefore
// waits for a real viewport, and the content gate starts with the navigation.
test('scene: a zero-viewport window defers the frame until the host has a box', () => {
  const env = setup({
    items: [sceneItem()],
    config: makeConfig({ currentId: 'id-scene' }),
    viewport: [0, 0],
  })
  const frame = env.layers()[0].querySelector('iframe')
  assert.equal(frame.getAttribute('src'), null, 'no navigation while the window has no viewport')
  assert.ok(
    env.state().notes.some((note) => note.indexOf('frame-wait:id-scene') === 0),
    `expected a frame-wait note, got ${JSON.stringify(env.state().notes)}`,
  )
  assert.equal(liveTimers(env.ctx, 15000).length, 0, 'the scene gate has not started yet')
  assert.equal(env.storeLayer(), 'loading')

  // The window is shown / laid out: the next poll sees a viewport and boots.
  Object.defineProperty(env.dom.window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(env.dom.window, 'innerHeight', { configurable: true, value: 800 })
  const poll = liveTimers(env.ctx, 100)[0]
  assert.ok(poll, 'a viewport poll must be armed')
  fireTimer(poll)

  const src = frame.getAttribute('src')
  assert.ok(src && src.startsWith(`${ORIGIN}/gl/host.html?`), src)
  assert.equal(liveTimers(env.ctx, 15000).length, 1, 'the 15s gate starts at the navigation, not before')
})

test('scene: a frame that booted at 0x0 is navigated once more when the box appears', () => {
  const env = setup({ items: [sceneItem()], config: makeConfig({ currentId: 'id-scene' }) })
  const frame = env.layers()[0].querySelector('iframe')
  // jsdom reports no layout: the boot box is 0x0, i.e. exactly what a hidden
  // window produced. The box appears later (the window was shown/laid out).
  assert.ok(env.state().notes.some((note) => note.indexOf('frame-boot:id-scene:0x0') === 0))
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 1280 })
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 800 })
  fire(env.dom, frame, 'load')

  assert.equal(env.storeLayer(), 'loading', 'the first load must not activate a blind render')
  assert.ok(
    env.state().notes.some((note) => note.indexOf('frame-reboot:id-scene:1280x800') === 0),
    `expected a frame-reboot note, got ${JSON.stringify(env.state().notes)}`,
  )

  fire(env.dom, frame, 'load')
  assert.equal(env.storeLayer(), 'active', 'the second load activates')
})

// Cold start mounts from the localStorage snapshot, which carries the PREVIOUS
// backend process's media-server origin. The media server binds an ephemeral
// port, so that origin is a dead port: the frame loads a chrome-error page, its
// `load` event still fires, and the layer sits at `active` over nothing while
// the same-id guard refuses to rebuild. Observed 2026-10-26: the mounted frame
// pointed at :29203 while the live media server was :22884.
test('a stale cached media origin is rebuilt once the live origin arrives', () => {
  const stale = 'http://127.0.0.1:7001'
  const live = 'http://127.0.0.1:7002'
  const env = setup({
    items: [sceneItem()],
    config: makeConfig({ currentId: 'id-scene' }),
    mediaOrigin: stale,
  })
  assert.ok(env.layers()[0].querySelector('iframe').getAttribute('src').startsWith(`${stale}/gl/host.html?`))

  // The bootstrap response: same selection, same library, new media origin.
  env.core.weApplyLibrary({ engineFound: true, mediaOrigin: live, errors: [], items: [sceneItem()] })

  const loading = env.layers().filter((layer) => layer.getAttribute('data-we-state') === 'loading')
  assert.equal(loading.length, 1, 'the stale layer is replaced by one fresh node')
  assert.ok(
    loading[0].querySelector('iframe').getAttribute('src').startsWith(`${live}/gl/host.html?`),
    'the fresh node is built against the live origin',
  )
  assert.ok(
    env.state().notes.some((note) => note.indexOf(`origin-changed:${stale}->${live}`) === 0),
    `expected an origin-changed note, got ${JSON.stringify(env.state().notes)}`,
  )
})

// Cold start means "nothing of ours is on screen yet", so the 1800ms switch
// fade has nothing to cross-fade from and only delays the first visible frame.
// The window opens at ~4.4s on this machine and the live layer is ready ~3s
// later; holding it near-transparent for another 1.8s is what read as "the
// wallpaper is still loading". A real switch (T16e) keeps the base duration.
test('cold start: the session\'s first layer fades in fast', () => {
  const env = setup({
    items: [makeItem({ id: 'id-v' })],
    config: makeConfig({ currentId: 'id-v', settings: { switchTransition: 'fade' } }),
  })

  const layer = layerOf('id-v')
  assert.ok(layer.classList.contains('we-layer--switch-in'))
  assert.equal(layer.style.animationDuration, '200ms', 'cold start uses the short fade')
  assert.ok(liveTimers(env.ctx, 280).length === 1, 'the reveal snap follows the short fade')
})

test('cold start: the stale-origin rebuild drops the dead node and fades in fast', () => {
  const stale = 'http://127.0.0.1:7001'
  const live = 'http://127.0.0.1:7002'
  const env = setup({
    items: [sceneItem()],
    config: makeConfig({ currentId: 'id-scene' }),
    mediaOrigin: stale,
  })
  const dead = env.layers()[0]

  env.core.weApplyLibrary({ engineFound: true, mediaOrigin: live, errors: [], items: [sceneItem()] })

  assert.equal(dead.parentNode, null, 'a dead-port node must not linger as the fade underlay')
  const layers = env.layers()
  assert.equal(layers.length, 1)
  assert.equal(layers[0].style.animationDuration, '200ms', 'the rebuild is a cold start, not a switch')
})
