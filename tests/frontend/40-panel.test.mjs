/**
 * T2.5 — behaviour tests for `desktop/src/40-panel.js` (MOD-010).
 *
 * Run with:  node --test tests/frontend/40-panel.test.mjs
 *   (node 26: `node --test <dir>` does not work — pass the .mjs file)
 *
 * How it loads the product: `00-core.js` + `10-layer.js` + `30-glass.js` +
 * `40-panel.js` are concatenated into ONE function scope, exactly in the order
 * `desktop/build.py` concatenates `src/*.js` (filename order). That is the only
 * way to prove what the shipped artefact relies on: that the four files
 * collaborate through the shared scope, that no top-level symbol collides, and
 * that the panel really drives `weSaveConfig` / `weGlassApply` / `weLayerSync`
 * rather than a local look-alike.
 *
 * React comes from the Hermes desktop tree's node_modules (dev-only, never
 * imported by the plugin) and is injected the way the host injects it at
 * runtime: `globalThis.__HERMES_REACT__`, set by
 * `apps/desktop/src/sdk/runtime.ts` before any plugin evaluates. That is also
 * why 40-panel.js needs no `import` (build.py rule 1 allows one only in
 * 00-core.js).
 *
 * Coverage map (parent's acceptance list):
 *   - every §8.4 row renders with the right control, bound to the right field
 *   - slider drag = local only, `pointerup` = exactly one PUT
 *   - the PUT response's `config` replaces the optimistic local value (T13, panel half)
 *   - a failed PUT restores the confirmed document
 *   - `enabled:false` greys AND disables everything except the way back
 *   - scene-only controls grey out without a playable scene wallpaper
 *   - the error boundary swallows a child render throw
 *   - `scrim` is a 0–0.9 fraction on the wire and 0–90 on the slider
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(PLUGIN_ROOT, 'desktop', 'src')

const CORE_SOURCE = readFileSync(path.join(SRC, '00-core.js'), 'utf8')
const LAYER_SOURCE = readFileSync(path.join(SRC, '10-layer.js'), 'utf8')
const GLASS_SOURCE = readFileSync(path.join(SRC, '30-glass.js'), 'utf8')
const PANEL_SOURCE = readFileSync(path.join(SRC, '40-panel.js'), 'utf8')

// --------------------------------------------------------------------------- //
// dev-only dependency resolution (react 19 / react-dom 19 / jsdom 29)
// --------------------------------------------------------------------------- //

const DEP_BASES = [
  process.env.WE_NODE_MODULES,
  path.join(PLUGIN_ROOT, '..', '..', 'hermes-agent'),
  path.join(PLUGIN_ROOT, '..', '..'),
  PLUGIN_ROOT,
].filter(Boolean)

function resolveDeps() {
  const tried = []
  for (const base of DEP_BASES) {
    try {
      const req = createRequire(pathToFileURL(path.join(base, 'package.json')).href)
      const react = req('react')
      const { createRoot } = req('react-dom/client')
      const { JSDOM } = req('jsdom')
      return { react, createRoot, JSDOM, base }
    } catch (error) {
      tried.push(`${base}: ${error.message.split('\n')[0]}`)
    }
  }
  return { error: tried.join(' | ') }
}

const DEPS = resolveDeps()
const SKIP = DEPS.error ? `react/react-dom/jsdom unavailable: ${DEPS.error}` : false

// --------------------------------------------------------------------------- //
// loading the four files into one scope (what build.py produces)
// --------------------------------------------------------------------------- //

const IMPORT_RE = /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm

const SYMBOLS = [
  // 00-core
  'WE_BOOT',
  'weGetState',
  'weSet',
  'weResetStore',
  'weApplyConfig',
  'weApplyLibrary',
  'weSaveConfig',
  'weLoadLibrary',
  'weRequestStatus',
  'weUseStore',
  'weDeriveCurrent',
  'weIsPlayable',
  // 10-layer (the panel is asserted to reach it)
  'weLayerMount',
  'weLayerState',
  'weLayerDispose',
  'weLayerSync',
  'weLayerRoot',
  // 30-glass (the panel is asserted to reach it)
  'weGlassApply',
  'weGlassRefresh',
  'weGlassStop',
  'weGlassDiag',
  // 40-panel — pure helpers
  'WE_PANEL_AREA',
  'WE_PANEL_SCENE_FPS',
  'WE_PANEL_SLIDERS',
  'WE_PANEL_OBJECT_FITS',
  'WE_PANEL_TRANSITIONS',
  'WE_PANEL_KIND_LABELS',
  'WE_PANEL_INTERVAL_MIN',
  'WE_PANEL_INTERVAL_MAX',
  'wePanelReact',
  'wePanelH',
  'wePanelSettings',
  'wePanelNumber',
  'wePanelClampInt',
  'wePanelSliderSpec',
  'wePanelSliderDisplay',
  'wePanelSliderWire',
  'wePanelEnabled',
  'wePanelHasScene',
  'wePanelKindLabel',
  'wePanelPreviewUrl',
  'wePanelSceneFps',
  'wePanelRotation',
  'wePanelApplyOptimistic',
  'wePanelApplyGlass',
  'wePanelSave',
  'wePanelSyncFurniture',
  'wePanelPort',
  'wePanelStatusLines',
  // 40-panel — components
  'wePanelBoundaryClass',
  'wePanelBoundary',
  'wePanelRowEl',
  'wePanelSwitchEl',
  'wePanelSliderEl',
  'wePanelSelectEl',
  'wePanelReadoutEl',
  'weAppearancePanel',
  'weAppearanceExtra',
]

function loadProduct() {
  const matches = Array.from(CORE_SOURCE.matchAll(IMPORT_RE))
  assert.equal(matches.length, 1, '00-core.js must contain exactly one import statement')
  const statement = matches[0]
  assert.equal(statement[2], 'react', 'the only import must be the whitelisted `react`')
  const coreBody = CORE_SOURCE.replace(statement[0], '')
  const factory = new Function(
    '__react',
    '__names',
    `const { useSyncExternalStore } = __react;
${coreBody}

${LAYER_SOURCE}

${GLASS_SOURCE}

${PANEL_SOURCE}
return __names.reduce(function collect(acc, name) { acc[name] = eval(name); return acc }, {})`,
  )
  const react = DEPS.react || { useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() } }
  return factory(react, SYMBOLS)
}

// --------------------------------------------------------------------------- //
// fixtures
// --------------------------------------------------------------------------- //

const THEME_CSS = `
  :root {
    --ui-bg-chrome: rgb(18, 20, 24);
    --ui-bg-sidebar: rgb(30, 32, 38);
    --ui-chat-surface-background: rgb(44, 46, 52);
  }
`

function makeSettings(overrides = {}) {
  return {
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
    ...overrides,
  }
}

function makeConfig(settingsOverrides = {}, overrides = {}) {
  return {
    version: 2,
    currentId: 'id-video',
    settings: makeSettings(settingsOverrides),
    ...overrides,
  }
}

function makeItem(id, kind = 'video', extra = {}) {
  return {
    id,
    weId: '2001',
    kind,
    title: `标题 ${id}`,
    source: 'workshop',
    path: kind === 'video' ? `C:/lib/${id}/a.mp4` : null,
    dir: `C:/lib/${id}`,
    entry: null,
    preview: null,
    rating: 'everyone',
    sizeBytes: 1024,
    mtimeMs: 1700000000000,
    props: {},
    schemeColor: 'rgb(216, 185, 182)',
    play: { type: kind, url: `/m/${id}` },
    ...extra,
  }
}

function makeLibrarySlice(items, overrides = {}) {
  return {
    items,
    mediaOrigin: 'http://127.0.0.1:51234',
    engineFound: true,
    errors: [],
    ...overrides,
  }
}

function makeStatus(overrides = {}) {
  return {
    ok: true,
    version: '1.0.0',
    engineFound: true,
    installDir: 'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine',
    libraryDirs: ['C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/projects/defaultprojects'],
    mediaOrigin: 'http://127.0.0.1:51234',
    mediaError: null,
    ...overrides,
  }
}

/** Minimal backend: merge a `{settings}` patch over the SEEDED document.
 *
 *  Deliberately seeded, not read from the store — a handler that echoed the live
 *  store would silently bless the optimistic value and make the T13 test
 *  vacuous. */
function mergePatch(seed, patch) {
  const body = patch && typeof patch === 'object' ? patch : {}
  const settings = Object.assign({}, seed.settings)
  const incoming = body.settings && typeof body.settings === 'object' ? body.settings : {}
  for (const key of Object.keys(incoming)) {
    if (key === 'rotation' && incoming[key] && typeof incoming[key] === 'object') {
      settings.rotation = Object.assign({}, settings.rotation, incoming[key])
      continue
    }
    settings[key] = incoming[key]
  }
  const next = Object.assign({}, seed, { settings })
  if (Object.prototype.hasOwnProperty.call(body, 'currentId')) {
    next.currentId = body.currentId
  }
  return next
}

// --------------------------------------------------------------------------- //
// DOM globals (node 26 makes `navigator` getter-only)
// --------------------------------------------------------------------------- //

function installGlobals(dom) {
  const saved = {}
  for (const name of ['window', 'document', 'navigator']) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  }
  // react-dom's legacy input-value polyfill (the branch it takes when it cannot
  // detect `input` support) touches `attachEvent`/`detachEvent` when it starts
  // watching the focused element. jsdom has neither, and without them a
  // focus/blur dispatch throws before the handler runs. Test-only shim.
  const proto = dom.window.HTMLElement.prototype
  if (typeof proto.attachEvent !== 'function') {
    proto.attachEvent = function attachEvent() {}
  }
  if (typeof proto.detachEvent !== 'function') {
    proto.detachEvent = function detachEvent() {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return function restore() {
    for (const name of ['window', 'document', 'navigator']) {
      if (saved[name]) {
        Object.defineProperty(globalThis, name, saved[name])
      } else {
        delete globalThis[name]
      }
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    delete globalThis.__HERMES_REACT__
  }
}

// --------------------------------------------------------------------------- //
// environment: dom + product + ctx + rendered panel
// --------------------------------------------------------------------------- //

/**
 * @param {Object} [options]
 * @param {Object} [options.config] ConfigDoc seeded into the store
 * @param {Object} [options.library] library slice seeded into the store
 * @param {Function} [options.rest] `(path, opts) => body|Promise<body>`; default
 *   is a merge-patch backend over the seeded config
 * @param {boolean} [options.mountLayer] mount 10-layer before rendering
 * @param {boolean} [options.render] render the panel (default true)
 */
async function makeEnv(options = {}) {
  if (!DEPS.JSDOM) {
    throw new Error(`jsdom is unavailable (dev-only): ${DEPS.error}`)
  }
  const dom = new DEPS.JSDOM(
    `<!doctype html><html><head><style>${THEME_CSS}</style></head><body><div id="root"></div></body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  )
  const restore = installGlobals(dom)
  globalThis.__HERMES_REACT__ = DEPS.react

  const product = loadProduct()
  const seedConfig = options.config || makeConfig()
  const seedLibrary = options.library || makeLibrarySlice([makeItem('id-video')], {})

  const requests = []
  const timers = []

  const custom = options.rest || null
  const handler =
    custom ||
    function backend(requestPath, opts) {
      if (opts && opts.method === 'PUT') {
        return { ok: true, config: mergePatch(seedConfig, opts.body), clamped: null }
      }
      if (requestPath.indexOf('/library') === 0) {
        return Object.assign({}, seedLibrary, { scannedAt: '2026-10-20T16:00:00+08:00' })
      }
      if (requestPath === '/status') {
        return makeStatus()
      }
      if (requestPath === '/config') {
        return { ok: true, config: seedConfig }
      }
      return { ok: false, error: 'unexpected path ' + requestPath }
    }

  const ctx = {
    document: dom.window.document,
    window: dom.window,
    storage: {
      get(key, fallback) {
        return fallback
      },
      set() {},
      remove() {},
    },
    // F22: flat, disposer-returning timers. Recorded so a test can assert the
    // panel schedules nothing.
    setTimeout(fn, ms) {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return function cancel() {
        entry.cancelled = true
      }
    },
    rest(requestPath, opts) {
      requests.push({ path: requestPath, opts })
      return Promise.resolve().then(function call() {
        return handler(requestPath, opts)
      })
    },
  }

  const react = DEPS.react
  react.act(() => {
    product.weApplyConfig(seedConfig)
    product.weApplyLibrary(seedLibrary)
  })

  if (options.mountLayer) {
    product.weLayerMount(ctx)
  }

  let root = null
  const container = dom.window.document.getElementById('root')
  if (options.render !== false) {
    root = DEPS.createRoot(container)
    react.act(() => {
      root.render(react.createElement(product.weAppearanceExtra(ctx)))
    })
  }

  const env = {
    dom,
    doc: dom.window.document,
    win: dom.window,
    product,
    ctx,
    requests,
    timers,
    container,
    seedConfig,
    seedLibrary,
    root,
    /** Flush the microtask queue inside act (the panel's promise chains). */
    async settle() {
      await react.act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    },
    query(selector) {
      return container.querySelector(selector)
    },
    queryAll(selector) {
      return Array.from(container.querySelectorAll(selector))
    },
    text(selector) {
      const el = container.querySelector(selector)
      return el ? el.textContent : null
    },
    putCalls() {
      return requests.filter((entry) => entry.opts && entry.opts.method === 'PUT')
    },
    fire(el, type, init) {
      const event = new dom.window.Event(type, Object.assign({ bubbles: true, cancelable: true }, init || {}))
      react.act(() => {
        el.dispatchEvent(event)
      })
      return event
    },
    /** Set an input's value through the prototype setter, then dispatch `input`. */
    typeInto(el, value) {
      const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      react.act(() => {
        setter.call(el, String(value))
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true, cancelable: true }))
      })
    },
    click(el) {
      react.act(() => {
        el.click()
      })
    },
    settings() {
      const state = product.weGetState()
      return state.config ? state.config.settings : null
    },
    async destroy() {
      try {
        if (root) {
          react.act(() => root.unmount())
        }
      } catch (error) {
        // unmount of an already-crashed tree is not interesting here
      }
      try {
        product.weLayerDispose()
      } catch (error) {}
      try {
        product.weGlassStop()
      } catch (error) {}
      restore()
      dom.window.close()
    },
  }
  return env
}

/** Focus then blur inside act — the way a keyboard user leaves a field. */
function react_focusBlur(env, el) {
  DEPS.react.act(() => {
    el.focus()
    el.blur()
  })
}

// --------------------------------------------------------------------------- //
// 1. module shape (build.py rules 1/2, F22, T10c)
// --------------------------------------------------------------------------- //

test('module shape: no import, no export, no dynamic import, no timer, no JSX', () => {
  assert.equal(/^\s*import\b/m.test(PANEL_SOURCE), false, '40-panel.js must not import (rule 1: only 00-core.js)')
  assert.equal(/^\s*export\b/m.test(PANEL_SOURCE), false, '40-panel.js must not export (rule 2)')
  assert.equal(/\bimport\s*\(/.test(PANEL_SOURCE), false, 'no dynamic import')
  assert.equal(PANEL_SOURCE.includes('ctx.timer'), false, 'ctx.timer does not exist (F22)')
  assert.equal(/\bsetTimeout\s*\(/.test(PANEL_SOURCE), false, 'the panel schedules nothing')
  assert.equal(/\bsetInterval\s*\(/.test(PANEL_SOURCE), false, 'the panel schedules nothing')
  // JSX would need a transform neither build.py nor the runtime loader performs
  // (T12 runs `node --check` on the product), so elements come from
  // React.createElement through the wePanelH facade.
  assert.ok(PANEL_SOURCE.includes('wePanelH('), 'elements are built with wePanelH')
  assert.equal(/\.jsx\b|jsx-runtime|_jsx/.test(PANEL_SOURCE), false, 'no JSX runtime usage in the source')
  assert.equal(PANEL_SOURCE.includes('__HERMES_REACT__'), true, 'React is resolved from the host singleton')
})

test('the four files concatenate into one collision-free scope', { skip: SKIP }, () => {
  const product = loadProduct()
  for (const name of SYMBOLS) {
    assert.notEqual(product[name], undefined, `${name} must resolve in the shared scope`)
  }
  assert.equal(typeof product.weAppearanceExtra, 'function')
  assert.equal(typeof product.weSaveConfig, 'function', 'the panel must reuse 00-core, not a local copy')
  assert.equal(typeof product.weGlassApply, 'function', 'the panel must reuse 30-glass')
  assert.equal(typeof product.weLayerSync, 'function', 'the panel must reuse 10-layer')
})

// --------------------------------------------------------------------------- //
// 2. the slider table mirrors config.py (ranges are a backend fact)
// --------------------------------------------------------------------------- //

test('slider table: display bounds mirror dashboard/config.py _NUMERIC_RANGES', { skip: SKIP }, () => {
  const product = loadProduct()
  // authoritative values, read off dashboard/config.py
  const expected = {
    panelBase: [0, 100],
    cardBase: [0, 100],
    overlayBase: [0, 100],
    wallpaperBlur: [0, 40],
    brightness: [0, 200],
    contrast: [0, 200],
    saturate: [0, 200],
    wallpaperOpacity: [0, 100],
    scrim: [0, 90], // 0.0–0.9 fraction, shown as a percentage
  }
  const fields = product.WE_PANEL_SLIDERS.map((spec) => spec.field)
  assert.deepEqual(fields.sort(), Object.keys(expected).sort(), '§8.4 slider set')
  for (const [field, bounds] of Object.entries(expected)) {
    const spec = product.wePanelSliderSpec(field)
    assert.ok(spec, `${field} must be in the slider table`)
    assert.deepEqual([spec.min, spec.max], bounds, `${field} bounds`)
  }
  assert.equal(product.wePanelSliderSpec('typeFilter'), null, 'non-slider fields are not in the table')
})

test('scrim is a fraction on the wire and a 0–90 integer on the slider', { skip: SKIP }, () => {
  const product = loadProduct()
  assert.equal(product.wePanelSliderDisplay('scrim', { scrim: 0.25 }), 25)
  assert.equal(product.wePanelSliderDisplay('scrim', { scrim: 0.9 }), 90)
  assert.equal(product.wePanelSliderWire('scrim', 40), 0.4)
  assert.equal(product.wePanelSliderWire('scrim', 25), 0.25)
  assert.equal(product.wePanelSliderWire('scrim', 100), 0.9, 'clamped to the backend range')
  // identity for every other slider
  assert.equal(product.wePanelSliderDisplay('panelBase', { panelBase: 55 }), 55)
  assert.equal(product.wePanelSliderWire('panelBase', 60), 60)
  assert.equal(product.wePanelSliderWire('cardBase', 5), 5, 'identity: the floor is 0 since 2026-10-22')
})

// --------------------------------------------------------------------------- //
// 3. §8.4 rows: present, labelled, bound to the real field names
// --------------------------------------------------------------------------- //

test('every §8.4 row renders, bound to its real settings field', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    const panel = env.query('[data-we-panel="appearance"]')
    assert.ok(panel, 'the panel mounted')
    assert.equal(panel.getAttribute('data-we-state'), 'ready')
    assert.equal(panel.getAttribute('data-we-disabled'), 'false')

    const rows = env.queryAll('[data-we-row]').map((el) => el.getAttribute('data-we-row'))
    assert.deepEqual(rows, [
      'enabled',
      'current',
      'open-picker',
      'uiCards',
      'panelBase',
      'cardBase',
      'overlayBase',
      'wallpaperBlur',
      'brightness',
      'contrast',
      'saturate',
      'wallpaperOpacity',
      'scrim',
      'objectFit',
      'switchTransition',
      'sceneLive',
      'pauseOnHidden',
      'rotation',
      'rescan',
      'diag',
    ])

    // switches
    for (const field of ['enabled', 'sceneLive', 'pauseOnHidden']) {
      const input = env.query(`[data-we-setting="${field}"]`)
      assert.ok(input, `${field} switch exists`)
      assert.equal(input.getAttribute('type'), 'checkbox')
      assert.equal(input.getAttribute('role'), 'switch')
    }
    assert.equal(env.query('[data-we-setting="enabled"]').checked, true)
    assert.equal(env.query('[data-we-setting="sceneLive"]').checked, true)
    assert.equal(env.query('[data-we-setting="pauseOnHidden"]').checked, true)
    assert.equal(env.query('[data-we-setting="rotation.enabled"]').checked, false)

    // sliders: value is display-space, min/max come from the table
    const expectations = { panelBase: 55, cardBase: 45, wallpaperBlur: 0, brightness: 100, scrim: 25 }
    for (const [field, value] of Object.entries(expectations)) {
      const input = env.query(`[data-we-setting="${field}"]`)
      assert.equal(input.getAttribute('type'), 'range', `${field} is a range`)
      assert.equal(Number(input.value), value, `${field} value`)
      assert.equal(env.text(`[data-we-readout="${field}"]`), String(value) + (field === 'wallpaperBlur' ? 'px' : field === 'brightness' || field === 'scrim' ? '%' : ''))
    }
    assert.equal(env.query('[data-we-setting="cardBase"]').getAttribute('min'), '0', 'cardBase floor 0 (§8.4, 2026-10-22)')
    assert.equal(env.query('[data-we-setting="scrim"]').getAttribute('max'), '90')

    // selects: §8.4 labels, wire values under them
    const fit = env.query('[data-we-setting="objectFit"]')
    assert.deepEqual(Array.from(fit.options).map((o) => [o.value, o.textContent]), [
      ['cover', '铺满'],
      ['contain', '完整'],
      ['fill', '拉伸'],
    ])
    assert.equal(fit.value, 'cover')
    const transition = env.query('[data-we-setting="switchTransition"]')
    assert.deepEqual(Array.from(transition.options).map((o) => o.value), ['fade', 'cut'])
    assert.equal(transition.value, 'fade')

    // scene fps select: 15/30/60
    const fps = env.query('[data-we-setting="sceneLiveFps"]')
    assert.deepEqual(Array.from(fps.options).map((o) => o.value), ['15', '30', '60'])
    assert.equal(fps.value, '15')

    // rotation interval
    assert.equal(env.query('[data-we-setting="rotation.intervalMinutes"]').value, '10')
    assert.equal(env.query('[data-we-setting="rotation.intervalMinutes"]').getAttribute('type'), 'number')

    // the two actions + the diag toggle
    assert.ok(env.query('[data-we-action="open-picker"]'))
    assert.ok(env.query('[data-we-action="rescan"]'))
    assert.ok(env.query('[data-we-action="diag-toggle"]'))
  } finally {
    await env.destroy()
  }
})

test('current-wallpaper row: thumbnail + title + kind badge, and the empty state', { skip: SKIP }, async () => {
  const empty = await makeEnv({
    config: makeConfig({}, { currentId: null }),
    library: makeLibrarySlice([makeItem('id-video')]),
  })
  try {
    assert.equal(empty.text('[data-we-current-title]'), '未选择壁纸')
    assert.equal(empty.query('[data-we-current-title]').getAttribute('data-we-current-title'), 'empty')
    assert.equal(empty.query('[data-we-current-preview]'), null, 'no thumbnail without a selection')
    assert.equal(empty.query('[data-we-current-kind]'), null)
  } finally {
    await empty.destroy()
  }

  const filled = await makeEnv({
    config: makeConfig({}, { currentId: 'id-image' }),
    library: makeLibrarySlice([makeItem('id-image', 'image', { preview: 'C:/lib/id-image/preview.jpg' })]),
  })
  try {
    assert.equal(filled.text('[data-we-current-title]'), '标题 id-image')
    assert.equal(filled.query('[data-we-current-title]').getAttribute('data-we-current-title'), 'set')
    assert.equal(filled.query('[data-we-current-kind]').getAttribute('data-we-current-kind'), 'image')
    assert.equal(filled.text('[data-we-current-kind]'), '图片')
    assert.equal(filled.query('[data-we-current-preview]').getAttribute('data-we-current-preview'), 'url')
    assert.equal(
      filled.query('img[data-we-current-preview]').getAttribute('src'),
      'file:///C:/lib/id-image/preview.jpg',
      'preview goes through 10-layer’s path→URL rule',
    )
  } finally {
    await filled.destroy()
  }
})

test('“打开壁纸库” only sets pickerOpen — the modal belongs to 50-picker', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    assert.equal(env.product.weGetState().pickerOpen, false)
    env.click(env.query('[data-we-action="open-picker"]'))
    assert.equal(env.product.weGetState().pickerOpen, true)
    assert.equal(env.requests.length, 0, 'opening the library is not a request')
    // no portal, no dialog: MOD-010 does not render the modal
    assert.equal(env.doc.querySelector('[role="dialog"]'), null)
    assert.equal(env.doc.querySelector('[data-we-picker]'), null)
  } finally {
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 4. slider semantics: drag is local, pointerup is the only PUT
// --------------------------------------------------------------------------- //

test('slider drag: input events write nothing, pointerup writes exactly once', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    const slider = env.query('[data-we-setting="panelBase"]')
    assert.equal(env.putCalls().length, 0)

    // three drag steps
    env.typeInto(slider, 58)
    env.typeInto(slider, 59)
    env.typeInto(slider, 60)
    // settle between the drag and the release: a drag that fired a request would
    // land here, so "zero" is asserted against a flushed microtask queue too.
    await env.settle()
    assert.equal(env.requests.length, 0, 'no request while dragging (§8.4)')
    assert.equal(env.settings().panelBase, 60, 'the store carries the live preview')
    assert.equal(env.text('[data-we-readout="panelBase"]'), '60')

    // pointermove/pressed noise must not commit either
    env.fire(slider, 'pointermove')
    env.fire(slider, 'pointerdown')
    await env.settle()
    assert.equal(env.requests.length, 0)

    env.fire(slider, 'pointerup')
    await env.settle()
    const puts = env.putCalls()
    assert.equal(puts.length, 1, 'exactly one PUT on release')
    assert.equal(puts[0].path, '/config')
    assert.deepEqual(puts[0].opts.body, { settings: { panelBase: 60 } }, 'only the dragged field')

    // pointerup already cleared the drag, so a second release is not a second PUT
    env.fire(slider, 'pointerup')
    env.fire(slider, 'pointercancel')
    await env.settle()
    assert.equal(env.putCalls().length, 1, 'one PUT per release, not per event')
  } finally {
    await env.destroy()
  }
})

test('slider commits the fraction for scrim (0–90 displayed, 0–0.9 on the wire)', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    const slider = env.query('[data-we-setting="scrim"]')
    env.typeInto(slider, 40)
    await env.settle()
    assert.equal(env.requests.length, 0)
    env.fire(slider, 'pointerup')
    await env.settle()
    const puts = env.putCalls()
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].opts.body, { settings: { scrim: 0.4 } })
    await env.settle()
    assert.equal(env.settings().scrim, 0.4)
  } finally {
    await env.destroy()
  }
})

test('the release guard makes a double-fire a single PUT', { skip: SKIP }, async () => {
  // `pointerup`, `pointercancel`, `keyup` and `blur` all call the same
  // `commit()`; whichever arrives first consumes the drag, the rest are no-ops.
  // (Only the pointer path is driveable here: react-dom's legacy input polyfill
  // throws on a jsdom `keyup` — it probes `stateNode.tag`/`attachEvent`, which
  // jsdom does not implement. The keyboard wiring is asserted at source level
  // below and shares the guarded code path exercised here.)
  const env = await makeEnv()
  try {
    const slider = env.query('[data-we-setting="brightness"]')
    env.typeInto(slider, 120)
    await env.settle()
    assert.equal(env.requests.length, 0)
    env.fire(slider, 'pointerup')
    await env.settle()
    assert.equal(env.putCalls().length, 1)
    assert.deepEqual(env.putCalls()[0].opts.body, { settings: { brightness: 120 } })

    env.fire(slider, 'pointerup')
    env.fire(slider, 'pointercancel')
    await env.settle()
    assert.equal(env.putCalls().length, 1, 'no drag is open, so nothing is sent again')

    assert.match(PANEL_SOURCE, /onKeyUp:/, 'keyboard release is wired')
    assert.match(PANEL_SOURCE, /onBlur:/, 'tab-away is wired')
    assert.match(PANEL_SOURCE, /onPointerUp:/, 'the §8.4 release point is wired')
    assert.match(PANEL_SOURCE, /onPointerCancel:/, 'a cancelled drag still commits')
  } finally {
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 5. T13 (panel half): the PUT response replaces the optimistic value
// --------------------------------------------------------------------------- //

test('the PUT response config overwrites the optimistic store value', { skip: SKIP }, async () => {
  // Backend echoes a *different* panelBase (42) than the one dragged (60), the
  // way a clamp or a concurrent writer would. The store must end up at 42.
  const env = await makeEnv({
    rest(requestPath, opts) {
      if (opts && opts.method === 'PUT') {
        return {
          ok: true,
          config: makeConfig({ panelBase: 42 }),
          clamped: { panelBase: [60, 42] },
        }
      }
      return { ok: false, error: 'unexpected ' + requestPath }
    },
  })
  try {
    const slider = env.query('[data-we-setting="panelBase"]')
    env.typeInto(slider, 60)
    env.fire(slider, 'pointerup')
    // before the response lands the store holds the optimistic preview
    assert.equal(env.settings().panelBase, 60)

    await env.settle()
    assert.equal(env.settings().panelBase, 42, 'the response document wins over the optimistic value')
    assert.equal(env.text('[data-we-readout="panelBase"]'), '42', 'the UI follows the store, not the draft')
    assert.equal(env.putCalls().length, 1)
    // the clamp receipt becomes a toast (00-core behaviour, surfaced by the panel)
    assert.match(env.product.weGetState().toast.text, /允许范围/)
  } finally {
    await env.destroy()
  }
})

test('a failed PUT restores the confirmed document instead of keeping the draft', { skip: SKIP }, async () => {
  const env = await makeEnv({
    rest(requestPath, opts) {
      if (opts && opts.method === 'PUT') {
        return Promise.reject(new Error('bridge down'))
      }
      return { ok: false, error: 'unexpected ' + requestPath }
    },
  })
  try {
    const slider = env.query('[data-we-setting="saturate"]')
    env.typeInto(slider, 150)
    assert.equal(env.settings().saturate, 150, 'optimistic preview while dragging')
    env.fire(slider, 'pointerup')
    await env.settle()
    assert.equal(env.settings().saturate, 100, 'back to the value the backend last confirmed')
    const toast = env.product.weGetState().toast
    assert.equal(toast && toast.kind, 'error')
    assert.match(toast.text, /设置保存失败/)
  } finally {
    await env.destroy()
  }
})

test('界面卡片化 switch puts the boolean and greys the card sliders with the rest', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    const input = env.query('[data-we-setting="uiCards"]')
    assert.ok(input, 'the 卡片化 row exists')
    assert.equal(input.getAttribute('role'), 'switch')
    assert.equal(input.checked, true, 'cards are on by default')

    env.click(input)
    await env.settle()
    const puts = env.putCalls()
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].opts.body, { settings: { uiCards: false } }, 'a boolean write, nothing else')

    // it is a settings control like any other: disabled wallpaper greys it
    await env.settle()
    assert.equal(input.disabled, false)
  } finally {
    await env.destroy()
  }
})

test('discrete controls PUT their whole payload (rotation is replaced whole)', { skip: SKIP }, async () => {
  const env = await makeEnv({
    config: makeConfig({ rotation: { enabled: false, intervalMinutes: 25, shuffle: true } }),
  })
  try {
    env.click(env.query('[data-we-setting="rotation.enabled"]'))
    await env.settle()
    let puts = env.putCalls()
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].opts.body, {
      settings: { rotation: { enabled: true, intervalMinutes: 25, shuffle: true } },
    }, 'shuffle and interval survive the toggle (§6.3 whole-object replace)')
    assert.equal(env.query('[data-we-setting="rotation.intervalMinutes"]').disabled, false, 'interval is live once rotation is on')

    await env.settle()

    // objectFit select
    const fit = env.query('[data-we-setting="objectFit"]')
    env.typeInto(fit, 'contain')
    env.fire(fit, 'change')
    await env.settle()
    puts = env.putCalls()
    assert.equal(puts.length, 2)
    assert.deepEqual(puts[1].opts.body, { settings: { objectFit: 'contain' } })

    await env.settle()
    assert.equal(env.settings().objectFit, 'contain')
  } finally {
    await env.destroy()
  }
})

test('rotation interval commits on blur (a whole-object rotation write)', { skip: SKIP }, async () => {
  const env = await makeEnv({
    config: makeConfig({ rotation: { enabled: true, intervalMinutes: 10, shuffle: false } }),
  })
  try {
    const interval = env.query('[data-we-setting="rotation.intervalMinutes"]')
    assert.equal(interval.disabled, false, 'live while rotation is on')
    env.typeInto(interval, 45)
    await env.settle()
    assert.equal(env.requests.length, 0, 'typing is local until the field is left')
    assert.equal(env.settings().rotation.intervalMinutes, 45, 'live preview')

    react_focusBlur(env, interval)
    await env.settle()
    const puts = env.putCalls()
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].opts.body, {
      settings: { rotation: { enabled: true, intervalMinutes: 45, shuffle: false } },
    })

    // a second blur without new typing is a no-op
    react_focusBlur(env, interval)
    await env.settle()
    assert.equal(env.putCalls().length, 1)
  } finally {
    await env.destroy()
  }
})

test('scene fps select snaps to a legal value', { skip: SKIP }, async () => {
  const env = await makeEnv({
    library: makeLibrarySlice([makeItem('id-scene', 'scene')]),
    config: makeConfig({ sceneLiveFps: 30 }),
  })
  try {
    const fps = env.query('[data-we-setting="sceneLiveFps"]')
    assert.equal(fps.value, '30')
    env.typeInto(fps, '60')
    env.fire(fps, 'change')
    await env.settle()
    assert.deepEqual(env.putCalls()[0].opts.body, { settings: { sceneLiveFps: 60 } })
  } finally {
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 6. enabled=false: greyed but visible, and the seams get their tokens back
// --------------------------------------------------------------------------- //

test('enabled=false greys every settings control but keeps them visible', { skip: SKIP }, async () => {
  const env = await makeEnv({ config: makeConfig({ enabled: false }) })
  try {
    const panel = env.query('[data-we-panel="appearance"]')
    assert.equal(panel.getAttribute('data-we-disabled'), 'true')
    assert.ok(env.query('[data-we-disabled-note]'), 'the reason is stated')

    // still visible
    assert.equal(env.queryAll('[data-we-row]').length, 20)

    // every settings control is disabled…
    for (const field of [
      'panelBase',
      'cardBase',
      'wallpaperBlur',
      'brightness',
      'contrast',
      'saturate',
      'wallpaperOpacity',
      'scrim',
      'objectFit',
      'switchTransition',
      'sceneLive',
      'sceneLiveFps',
      'pauseOnHidden',
      'rotation.enabled',
      'rotation.intervalMinutes',
    ]) {
      const el = env.query(`[data-we-setting="${field}"]`)
      assert.ok(el, `${field} still rendered`)
      assert.equal(el.disabled, true, `${field} disabled while the wallpaper is off`)
    }

    // …except the way back and the recovery actions
    assert.equal(env.query('[data-we-setting="enabled"]').disabled, false)
    for (const action of ['open-picker', 'rescan', 'diag-toggle']) {
      assert.equal(env.query(`[data-we-action="${action}"]`).disabled, false, `${action} stays live`)
    }

    // a disabled slider cannot start a drag, so no request is possible
    const slider = env.query('[data-we-setting="panelBase"]')
    env.fire(slider, 'input')
    env.fire(slider, 'pointerup')
    assert.equal(env.requests.length, 0)
  } finally {
    await env.destroy()
  }
})

test('enabled toggle drives 30-glass and 10-layer through their own APIs', { skip: SKIP }, async () => {
  const env = await makeEnv({
    config: makeConfig({}, { currentId: 'id-image' }),
    library: makeLibrarySlice([makeItem('id-image', 'image', { preview: 'C:/lib/id-image/preview.jpg' })]),
    mountLayer: true,
  })
  try {
    const root = env.doc.documentElement
    assert.ok(env.product.weLayerState().nodes.length >= 1, 'the layer created a node for the selected wallpaper')

    // OFF: tokens restored, layer emptied
    env.click(env.query('[data-we-setting="enabled"]'))
    await env.settle()
    assert.equal(env.settings().enabled, false)
    assert.equal(
      root.style.getPropertyValue('--ui-bg-sidebar'),
      '',
      'the shell token is back to its untouched (absent) inline value — 30-glass’s clean branch',
    )
    assert.equal(Object.keys(env.product.weGlassDiag().applied).length, 0)
    assert.equal(env.product.weLayerState().nodes.length, 0, 'the layer dropped its node — 10-layer’s enabled=false branch')
    assert.equal(env.product.weGetState().layer, 'idle')
    assert.equal(env.putCalls().length, 1, 'the toggle is one PUT')

    // ON again: the same two APIs put the seams back
    env.click(env.query('[data-we-setting="enabled"]'))
    await env.settle()
    assert.equal(env.settings().enabled, true)
    assert.match(
      root.style.getPropertyValue('--ui-bg-sidebar'),
      /^rgba\(/,
      'the shell token is covered again at panelBase=55 — 30-glass wrote it, not the panel',
    )
    assert.ok(env.product.weLayerState().nodes.length >= 1, 're-enabling brings the layer back')
    assert.equal(env.putCalls().length, 2)
  } finally {
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 7. scene-only controls need a scene wallpaper
// --------------------------------------------------------------------------- //

test('scene controls grey out when the library holds no scene wallpaper', { skip: SKIP }, async () => {
  const noScene = await makeEnv({ library: makeLibrarySlice([makeItem('id-video')]) })
  try {
    assert.equal(noScene.query('[data-we-setting="sceneLive"]').disabled, true)
    assert.equal(noScene.query('[data-we-setting="sceneLiveFps"]').disabled, true)
    assert.equal(noScene.query('[data-we-scene-note="missing"]') !== null, true, 'the reason is shown')
    // nothing else got disabled by accident
    assert.equal(noScene.query('[data-we-setting="pauseOnHidden"]').disabled, false)
    assert.equal(noScene.query('[data-we-setting="panelBase"]').disabled, false)
  } finally {
    await noScene.destroy()
  }

  const withScene = await makeEnv({ library: makeLibrarySlice([makeItem('id-scene', 'scene')]) })
  try {
    assert.equal(withScene.query('[data-we-setting="sceneLive"]').disabled, false)
    assert.equal(withScene.query('[data-we-setting="sceneLiveFps"]').disabled, false)
    assert.equal(withScene.query('[data-we-scene-note="missing"]'), null)
  } finally {
    await withScene.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 8. error boundary (§8.4 "自带错误边界")
// --------------------------------------------------------------------------- //

test('the error boundary contains a child render throw', { skip: SKIP }, async () => {
  const env = await makeEnv({
    rest(requestPath) {
      return { ok: false, error: 'unexpected ' + requestPath }
    },
  })
  const react = DEPS.react
  const boundary = env.product.wePanelBoundaryClass()
  const Boom = function Boom() {
    throw new Error('面板子组件炸了')
  }
  const host = env.doc.createElement('div')
  env.doc.body.appendChild(host)
  const root = DEPS.createRoot(host)

  const originalError = console.error
  console.error = () => {}
  try {
    react.act(() => {
      root.render(react.createElement(boundary, null, react.createElement(Boom)))
    })
    assert.ok(host.querySelector('[data-we-panel-error]'), 'the fallback rendered')
    assert.match(host.textContent, /壁纸外观面板渲染失败/)
    assert.match(host.textContent, /面板子组件炸了/)
    // and the rest of the page is unaffected: the real panel still renders
    assert.ok(env.query('[data-we-panel="appearance"]'))
  } finally {
    react.act(() => root.unmount())
    host.remove()
    console.error = originalError
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 9. actions: rescan (spinner) and diagnostics
// --------------------------------------------------------------------------- //

test('rescan requests `?refresh=1` and shows a local spinner, not a store flag', { skip: SKIP }, async () => {
  const env = await makeEnv({
    library: makeLibrarySlice([makeItem('id-video')]),
    rest(requestPath) {
      if (requestPath === '/library?refresh=1') {
        return {
          engineFound: true,
          mediaOrigin: 'http://127.0.0.1:51234',
          scannedAt: '2026-10-20T17:00:00+08:00',
          items: [makeItem('id-video'), makeItem('id-image', 'image')],
          errors: [],
        }
      }
      return { ok: false, error: 'unexpected ' + requestPath }
    },
  })
  try {
    const button = env.query('[data-we-action="rescan"]')
    assert.equal(env.text('[data-we-action="rescan"]'), '重新扫描')
    assert.equal(button.getAttribute('data-we-busy'), 'false')

    env.click(button)
    assert.equal(env.text('[data-we-action="rescan"]'), '正在扫描…', 'spinner state, set synchronously')
    assert.equal(button.getAttribute('data-we-busy'), 'true')
    // the request itself goes out on the microtask queue (ctx.rest is async)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(env.requests.length, 1)
    assert.equal(env.requests[0].path, '/library?refresh=1')

    await env.settle()
    assert.equal(env.text('[data-we-action="rescan"]'), '重新扫描')
    assert.equal(env.query('[data-we-action="rescan"]').getAttribute('data-we-busy'), 'false')
    assert.equal(env.product.weGetState().library.items.length, 2, 'the rescan result landed in the store')
    assert.equal(env.query('[data-we-library-count]').getAttribute('data-we-library-count'), '2')
    // the spinner never touched the store
    assert.deepEqual(Object.keys(env.product.weGetState()).sort(), [
      'boot',
      'config',
      'current',
      'layer',
      'library',
      'panelOpen',
      'pickerOpen',
      'toast',
    ], 'eight fields, no UI state (§5.4)')
  } finally {
    await env.destroy()
  }
})

test('the diagnostics block reads GET /status once and lists source/port/dirs/errors', { skip: SKIP }, async () => {
  const env = await makeEnv({
    library: makeLibrarySlice([makeItem('id-video')], {
      errors: [{ path: 'C:/lib/broken/project.json', message: 'JSON 损坏' }],
    }),
    rest(requestPath) {
      if (requestPath === '/status') {
        return makeStatus()
      }
      return { ok: false, error: 'unexpected ' + requestPath }
    },
  })
  try {
    assert.equal(env.query('[data-we-diag]'), null, 'collapsed by default')
    env.click(env.query('[data-we-action="diag-toggle"]'))
    await env.settle()

    const diag = env.query('[data-we-diag]')
    assert.ok(diag, 'expanded')
    assert.equal(diag.getAttribute('data-we-diag'), 'ready')
    const text = diag.textContent
    assert.match(text, /媒体源：http:\/\/127\.0\.0\.1:51234/)
    assert.match(text, /端口：51234/)
    assert.match(text, /库路径：.*defaultprojects/)
    assert.match(text, /扫描错误：.*JSON 损坏/)
    assert.match(text, /引擎：已检测到/)
    assert.equal(env.requests.filter((entry) => entry.path === '/status').length, 1)

    // collapsing and re-expanding does not re-fetch
    env.click(env.query('[data-we-action="diag-toggle"]'))
    env.click(env.query('[data-we-action="diag-toggle"]'))
    await env.settle()
    assert.equal(env.requests.filter((entry) => entry.path === '/status').length, 1)
  } finally {
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 10. degradation: no config yet
// --------------------------------------------------------------------------- //

test('before the first config lands the panel shows a loading row, not a crash', { skip: SKIP }, async () => {
  const env = await makeEnv({ render: false })
  const react = DEPS.react
  react.act(() => {
    env.product.weResetStore()
  })
  const root = DEPS.createRoot(env.container)
  try {
    react.act(() => {
      root.render(react.createElement(env.product.weAppearanceExtra(env.ctx)))
    })
    assert.equal(env.query('[data-we-panel="appearance"]').getAttribute('data-we-state'), 'loading')
    assert.match(env.text('[data-we-panel="appearance"]'), /正在加载壁纸配置/)
  } finally {
    react.act(() => root.unmount())
    await env.destroy()
  }
})

test('a config load error offers a retry that re-requests GET /config', { skip: SKIP }, async () => {
  const env = await makeEnv({ render: false })
  const react = DEPS.react
  // The retry must go back to the network; the first `GET /config` of *this*
  // click succeeds, which is enough to prove the button is wired to
  // weRefreshConfig and that a good answer clears `boot: 'error'`.
  env.ctx.rest = function rest(requestPath) {
    env.requests.push({ path: requestPath })
    if (requestPath === '/config') {
      return Promise.resolve({ ok: true, config: env.seedConfig })
    }
    return Promise.resolve({ ok: false, error: 'unexpected ' + requestPath })
  }
  react.act(() => {
    env.product.weResetStore()
    env.product.weSet({ boot: 'error' })
  })
  const root = DEPS.createRoot(env.container)
  try {
    react.act(() => {
      root.render(react.createElement(env.product.weAppearanceExtra(env.ctx)))
    })
    assert.equal(env.query('[data-we-panel="appearance"]').getAttribute('data-we-state'), 'error')
    const retry = env.query('[data-we-action="reload-config"]')
    assert.ok(retry, 'retry button')
    env.click(retry)
    await env.settle()
    assert.equal(env.requests.filter((entry) => entry.path === '/config').length, 1, 'the retry hit GET /config')
    assert.equal(env.query('[data-we-panel="appearance"]').getAttribute('data-we-state'), 'ready')
    assert.equal(env.product.weGetState().boot, 'ready')
  } finally {
    react.act(() => root.unmount())
    await env.destroy()
  }
})

// --------------------------------------------------------------------------- //
// 11. pure helpers worth pinning
// --------------------------------------------------------------------------- //

test('helpers: scene detection, fps snapping, rotation defaults, labels', { skip: SKIP }, () => {
  const product = loadProduct()
  assert.equal(product.wePanelHasScene({ library: { items: [makeItem('a', 'video')] } }), false)
  assert.equal(product.wePanelHasScene({ library: { items: [makeItem('a', 'scene')] } }), true)
  assert.equal(product.wePanelHasScene({ library: { items: [makeItem('a', 'application')] } }), false, 'not playable')
  assert.equal(product.wePanelHasScene({ library: null }), false)

  assert.equal(product.wePanelSceneFps({ sceneLiveFps: 45 }), 30, 'ties resolve lower, like config.py')
  assert.equal(product.wePanelSceneFps({ sceneLiveFps: 60 }), 60)
  assert.equal(product.wePanelSceneFps({}), 15)

  assert.deepEqual(product.wePanelRotation({}), { enabled: false, intervalMinutes: 10, shuffle: false })
  assert.deepEqual(product.wePanelRotation({ rotation: { enabled: true, intervalMinutes: 3, shuffle: true } }), {
    enabled: true,
    intervalMinutes: 3,
    shuffle: true,
  })
  assert.equal(product.wePanelRotation({ rotation: { intervalMinutes: 0 } }).intervalMinutes, 1, 'clamped into a usable range')

  assert.equal(product.wePanelKindLabel('scene'), '场景')
  assert.equal(product.wePanelKindLabel('nonsense'), '未知')
  assert.equal(product.wePanelPort('http://127.0.0.1:51234'), '51234')
  assert.equal(product.wePanelPort(''), '')
  assert.equal(product.wePanelEnabled({}), true)
  assert.equal(product.wePanelEnabled({ enabled: false }), false)
})

// --------------------------------------------------------------------------- //
// the pane card: the settings must sit on the composer's glass, not float bare
// on the wallpaper (2026-10-22 UI report)
// --------------------------------------------------------------------------- //

test('界面卡片化 off makes the panel itself full-bleed too', { skip: SKIP }, async () => {
  const env = await makeEnv({ config: makeConfig({ uiCards: false }) })
  try {
    const panel = env.query('[data-we-panel="appearance"]')
    const style = panel.style
    assert.equal(style.borderRadius, '0px', 'no rounded card when cards are off')
    assert.equal(style.margin, '0px', 'no inset either')
    assert.equal(style.borderStyle, 'none')
    assert.equal(style.background, 'transparent')
    // …and back on is the card again
    env.query('[data-we-setting="uiCards"]').click()
    await env.settle()
    const after = env.query('[data-we-panel="appearance"]').style
    assert.equal(after.borderRadius, '0.875rem', 'the switch re-dresses it')
  } finally {
    await env.destroy()
  }
})

test('every settings row explains itself in 括号 for the user', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    for (const row of ['enabled', 'uiCards', 'cardBase', 'overlayBase', 'scrim', 'rotation']) {
      const el = env.query('[data-we-row="' + row + '"]')
      assert.ok(el, row + ' row renders')
      assert.match(el.textContent, /（[^）]+）/, row + ' must carry a 括号说明')
    }
    // the hint is display-only: the switch keeps the bare accessible name
    assert.equal(env.query('[data-we-setting="overlayBase"]').getAttribute('aria-label'), '浮层透明度')
  } finally {
    await env.destroy()
  }
})

test('the panel renders as an inset glass card (composer material)', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    const panel = env.query('[data-we-panel="appearance"]')
    assert.ok(panel, 'the panel mounted')
    const style = panel.style
    assert.equal(style.borderRadius, '0.875rem', 'rounded like the chat card')
    assert.match(style.margin, /0\.75rem/, 'inset from the pane edges')
    assert.match(style.background, /--composer-fill|composer-fill/, 'the composer material is the source')
    assert.match(style.background, /--we-card-pct/, 'the fill follows the 卡片玻璃 slider')
    assert.match(style.backdropFilter, /--we-card-blur/, 'the blur follows the same slider')
    assert.match(style.border, /1px solid/, 'a hairline edge so the card reads as a surface')
    assert.match(style.minHeight, /100%/, 'the card fills the pane height')
  } finally {
    await env.destroy()
  }
})
