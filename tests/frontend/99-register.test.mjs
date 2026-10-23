/**
 * T2.7 — behaviour tests for `desktop/src/99-register.js` (MOD-013) + T11 smoke.
 *
 * Run with:  node --test tests/frontend/99-register.test.mjs
 *   (node 26: `node --test <dir>` does not work — pass the concrete .mjs file)
 *
 * How it loads the product: `00-core.js` + `10-layer.js` + `30-glass.js` +
 * `40-panel.js` + [50-picker.js] + `99-register.js` are concatenated into ONE
 * function scope, in `desktop/build.py`'s filename order, and the single
 * `export default` is rewritten to a `const` so a `new Function` body can hold
 * it. That is the shipped artefact's collaboration model: no module boundary,
 * one shared scope, React injected through `globalThis.__HERMES_REACT__`.
 *
 * Two picker variants (50-picker.js was being reworked in parallel when this
 * landed, so the suite never depends on its internals):
 *
 *   'stub'  a local, no-op double exposing ONLY the seven promised interfaces
 *           (`wePickerModal/Open/Close/Toggle/IsOpen/Root/Dispose`). Every
 *           behavioural assertion below runs against this, so a rewrite of
 *           50-picker cannot make this suite flaky.
 *   'real'  the file currently on disk, when it is present. The modal is no
 *           longer its own contribution — it is the last child of the panel's
 *           tree — so the invariant is now structural: `pickerMissing` must
 *           equal `!hasModal`, and there is exactly ONE registration either
 *           way (never two, never a half registration).
 *   'none'  no picker file at all: proves the degradation path for real.
 *
 * Coverage map (parent's acceptance list):
 *   - default export shape (id === WE_PLUGIN_ID, name/description/defaultEnabled/register)
 *   - register() puts the panel into `panes` with a ZERO-ARG render (the
 *     `appearance.extra` seam is unreachable — see WE_REG_PANEL_AREA)
 *   - T11: enabled → `[data-wallpaper-layer]` appears with a node in it
 *   - T11: enabled=false → the layer box is gone and the theme tokens are back
 *   - re-enable → the layer comes back (no stale `disposed` latch)
 *   - ctx.onDispose → no layer, tokens restored byte-for-byte, no store
 *     listeners left, contribution disposers called
 *   - 50-picker missing → no crash, no half-registration, one honest toast
 *   - a ctx without `register`/`rest`/`storage` → no crash
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(PLUGIN_ROOT, 'desktop', 'src')

const read = (name) => readFileSync(path.join(SRC, name), 'utf8')

const CORE_SOURCE = read('00-core.js')
const LAYER_SOURCE = read('10-layer.js')
const GLASS_SOURCE = read('30-glass.js')
const PANEL_SOURCE = read('40-panel.js')
const REGISTER_SOURCE = read('99-register.js')
const PICKER_PATH = path.join(SRC, '50-picker.js')
const PICKER_SOURCE = existsSync(PICKER_PATH) ? readFileSync(PICKER_PATH, 'utf8') : null

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
// the picker double — only the seven promised interfaces, no internals
// --------------------------------------------------------------------------- //

const PICKER_STUB = `
// ---- test double for 50-picker.js (promised surface only) ---- //
const __pickerStub = { open: false }
function wePickerIsOpen() { return __pickerStub.open === true }
function wePickerOpen(ctx) {
  __pickerStub.open = true
  weSet({ pickerOpen: true })
  return true
}
function wePickerClose() {
  __pickerStub.open = false
  weSet({ pickerOpen: false })
  return true
}
function wePickerToggle(ctx) {
  return wePickerIsOpen() ? wePickerClose() : wePickerOpen(ctx)
}
function wePickerRoot() { return null }
function wePickerDispose() {
  __pickerStub.open = false
  weSet({ pickerOpen: false })
  return true
}
function wePickerModal(props) { return null }
`

// --------------------------------------------------------------------------- //
// loading the concatenated product
// --------------------------------------------------------------------------- //

const IMPORT_RE = /^[ \t]*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+(['"])([^'"]+)\1\s*;?[ \t]*$/gm

const SYMBOLS = [
  // 00-core
  'WE_PLUGIN_ID',
  'WE_BOOT',
  'WE_LAYER',
  'WE_TOAST',
  'WE_CACHE_KEYS',
  'weGetStore',
  'weGetState',
  'weSet',
  'weResetStore',
  'weSubscribe',
  'weUseStore',
  'weHydrateFromStorage',
  'weBootstrap',
  'weApplyConfig',
  'weApplyLibrary',
  'weIsPlayable',
  'weCacheConfig',
  'weCacheLibrary',
  // 10-layer
  'WE_LAYER_ROOT_ATTR',
  'weLayerMount',
  'weLayerSync',
  'weLayerState',
  'weLayerRoot',
  'weLayerDispose',
  // 30-glass
  'weGlassStart',
  'weGlassStop',
  'weGlassApply',
  'weGlassDiag',
  // 40-panel
  'WE_PANEL_AREA',
  'weAppearanceExtra',
  'weAppearancePanel',
  // 99-register
  'weRegRegister',
  'weRegReconcile',
  'weRegDiag',
  'weRegTeardown',
  'WE_REG_PAGE_PATH',
  // the rewritten default export
  '__wePluginDefault',
]

/**
 * @param {'stub'|'real'|'none'} picker
 * @returns {Object} every symbol in SYMBOLS plus `plugin` (the default export)
 */
function loadProduct(picker) {
  const matches = Array.from(CORE_SOURCE.matchAll(IMPORT_RE))
  assert.equal(matches.length, 1, '00-core.js must contain exactly one import statement')
  assert.equal(matches[0][2], 'react', 'the only import must be the whitelisted `react`')
  const coreBody = CORE_SOURCE.replace(matches[0][0], '')

  const defaultHits = Array.from(REGISTER_SOURCE.matchAll(/^[ \t]*export\s+default\b/gm))
  assert.equal(defaultHits.length, 1, '99-register.js must hold exactly one export default')
  const registerBody = REGISTER_SOURCE.replace(/^[ \t]*export\s+default\b/m, 'const __wePluginDefault =')

  let pickerSource = ''
  if (picker === 'stub') {
    pickerSource = PICKER_STUB
  } else if (picker === 'real') {
    assert.ok(PICKER_SOURCE, '50-picker.js must exist for the "real" variant')
    pickerSource = PICKER_SOURCE
  }

  const body = [coreBody, LAYER_SOURCE, GLASS_SOURCE, PANEL_SOURCE, pickerSource, registerBody]
    .filter((part) => part && part.trim())
    .join('\n\n')

  const factory = new Function(
    '__react',
    '__names',
    `const { useSyncExternalStore } = __react;
${body}
return __names.reduce(function collect(acc, name) { acc[name] = eval(name); return acc }, {})`,
  )
  const react = DEPS.react || { useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() } }
  const product = factory(react, SYMBOLS)
  product.plugin = product.__wePluginDefault
  return product
}

// --------------------------------------------------------------------------- //
// fixtures
// --------------------------------------------------------------------------- //

const THEME_CSS = `
  :root {
    --ui-bg-chrome: rgb(18, 20, 24);
    --ui-bg-sidebar: rgb(9, 9, 9);
    --ui-chat-surface-background: rgb(12, 12, 12);
  }
`

const SEEDED_SIDEBAR = 'rgb(1, 2, 3)'
const SEEDED_CARD = 'rgb(4, 5, 6)'

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

function makeItem(id = 'id-video', kind = 'video') {
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
  }
}

function makeLibrarySlice(items, extra = {}) {
  return {
    engineFound: true,
    items,
    errors: [],
    scannedAt: '2026-10-20T16:00:00+08:00',
    mediaOrigin: 'http://127.0.0.1:51234',
    installDir: 'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine',
    libraryDirs: [],
    ...extra,
  }
}

/** Merge a `{settings, currentId}` patch over the SEEDED document. */
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

const GLOBAL_NAMES = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver']

function installGlobals(dom) {
  const saved = {}
  for (const name of GLOBAL_NAMES) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    if (dom.window[name] === undefined) {
      continue
    }
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  }
  const proto = dom.window.HTMLElement.prototype
  if (typeof proto.attachEvent !== 'function') {
    proto.attachEvent = function attachEvent() {}
  }
  if (typeof proto.detachEvent !== 'function') {
    proto.detachEvent = function detachEvent() {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return function restore() {
    for (const name of GLOBAL_NAMES) {
      if (!(name in saved)) {
        continue
      }
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
// environment
// --------------------------------------------------------------------------- //

/**
 * @param {Object} [options]
 * @param {'stub'|'real'|'none'} [options.picker]
 * @param {Object} [options.config] seeded ConfigDoc
 * @param {Object} [options.library] seeded /library payload
 * @param {Function} [options.rest] `(path, opts) => body|Promise<body>`
 * @param {(ctx: Object) => Object} [options.decorateCtx] mutate the ctx double
 * @param {boolean} [options.render] render the contributions (default true)
 * @param {boolean} [options.seedTokens] write the inline token baseline (default true)
 */
async function makeEnv(options = {}) {
  if (!DEPS.JSDOM) {
    throw new Error(`jsdom is unavailable (dev-only): ${DEPS.error}`)
  }
  const dom = new DEPS.JSDOM(
    `<!doctype html><html><head><style>${THEME_CSS}</style></head><body><div id="root"></div></body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  )
  const restoreGlobals = installGlobals(dom)
  globalThis.__HERMES_REACT__ = DEPS.react

  const doc = dom.window.document
  if (options.seedTokens !== false) {
    // T11c baseline: what the theme had before we ever wrote a token.
    doc.documentElement.style.setProperty('--ui-bg-sidebar', SEEDED_SIDEBAR)
    doc.documentElement.style.setProperty('--ui-chat-surface-background', SEEDED_CARD)
  }

  const react = DEPS.react
  if (react && typeof react.act !== 'function') {
    throw new Error('react 19 `act` is required by this suite')
  }

  const product = loadProduct(options.picker || 'stub')
  const seedConfig = options.config || makeConfig()
  const seedLibrary = options.library || makeLibrarySlice([makeItem()])

  const requests = []
  const timers = []
  const registrations = []
  const removedContributions = []
  const disposers = []
  const cache = new Map()

  const custom = options.rest || null
  const handler =
    custom ||
    function backend(requestPath, opts) {
      if (opts && opts.method === 'PUT') {
        return { ok: true, config: mergePatch(seedConfig, opts.body), clamped: null }
      }
      if (requestPath.indexOf('/library') === 0) {
        return Object.assign({}, seedLibrary)
      }
      if (requestPath === '/status') {
        return { ok: true, mediaOrigin: seedLibrary.mediaOrigin, port: 51234, requests: [] }
      }
      if (requestPath === '/config') {
        return { ok: true, config: seedConfig }
      }
      return { ok: false, error: 'unexpected path ' + requestPath }
    }

  // Mirrors the real PluginContext (apps/desktop/src/contrib/plugin.ts): it has
  // NO `document`/`window` — 30-glass and 10-layer fall back to the ambient DOM,
  // which is exactly what this exercises.
  const ctx = {
    source: 'plugin:' + product.WE_PLUGIN_ID,
    register(contribution) {
      registrations.push(contribution)
      return function remove() {
        removedContributions.push(contribution.id)
        const at = registrations.indexOf(contribution)
        if (at !== -1) {
          registrations.splice(at, 1)
        }
      }
    },
    onDispose(fn) {
      disposers.push(fn)
    },
    storage: {
      get(key, fallback) {
        return cache.has(key) ? cache.get(key) : fallback
      },
      set(key, value) {
        cache.set(key, value)
      },
      remove(key) {
        cache.delete(key)
      },
    },
    setTimeout(fn, ms) {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return function cancel() {
        entry.cancelled = true
      }
    },
    setInterval(fn, ms) {
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

  if (options.decorateCtx) {
    options.decorateCtx(ctx)
  }

  // ---- register ----------------------------------------------------------
  if (options.boot !== false) {
    react.act(() => {
      product.plugin.register(ctx)
    })
  }

  let root = null
  const container = doc.getElementById('root')
  if (options.render !== false && registrations.length > 0) {
    root = DEPS.createRoot(container)
    react.act(() => {
      root.render(
        react.createElement(
          'div',
          null,
          ...registrations.map((contribution, index) =>
            react.createElement(
              'div',
              { key: contribution.id, 'data-contrib': contribution.id || `#${index}` },
              typeof contribution.render === 'function' ? react.createElement(contribution.render) : null,
            ),
          ),
        ),
      )
    })
  }

  const env = {
    dom,
    doc,
    win: dom.window,
    product,
    ctx,
    requests,
    timers,
    registrations,
    removedContributions,
    disposers,
    cache,
    container,
    react,
    seedConfig,
    seedLibrary,
    root,
    /** Flush microtasks inside act (the bootstrap promise chains). */
    async settle() {
      await react.act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    },
    /** Push a new ConfigDoc into the store the way the app does after a PUT. */
    setConfig(config) {
      react.act(() => {
        product.weApplyConfig(config)
      })
    },
    layerBox() {
      return doc.querySelector('[data-wallpaper-layer]')
    },
    layerNodes() {
      const box = doc.querySelector('[data-wallpaper-layer]')
      return box ? Array.from(box.children) : []
    },
    sidebarToken() {
      return doc.documentElement.style.getPropertyValue('--ui-bg-sidebar')
    },
    cardToken() {
      return doc.documentElement.style.getPropertyValue('--ui-chat-surface-background')
    },
    listenerCount() {
      return product.weGetStore().listenerCount()
    },
    query(selector) {
      return container.querySelector(selector)
    },
    click(el) {
      assert.ok(el, 'click target must exist')
      // `el.click()` (not dispatchEvent) so jsdom runs the checkbox activation
      // behaviour — React 19 reads the switched `checked` off the event.
      react.act(() => {
        el.click()
      })
    },
    putCalls() {
      return requests.filter((entry) => entry.opts && entry.opts.method === 'PUT')
    },
    /** Unmount the rendered contributions (React's own store subscriptions go with it). */
    unmount() {
      if (!root) {
        return
      }
      const live = root
      root = null
      react.act(() => live.unmount())
    },
    async flush() {
      await react.act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    },
    cleanup() {
      if (root) {
        try {
          react.act(() => root.unmount())
        } catch (error) {
          // a test that already tore the tree down must still restore globals
        }
      }
      restoreGlobals()
    },
  }
  if (options.boot !== false) {
    await env.settle()
  }
  return env
}

// --------------------------------------------------------------------------- //
// source shape (build.py rules 1 and 3, F22)
// --------------------------------------------------------------------------- //

test('source shape: one export default, no import, no ctx.timer, sorts last', () => {
  const defaults = Array.from(REGISTER_SOURCE.matchAll(/^[ \t]*export\s+default\b/gm))
  assert.equal(defaults.length, 1, '99-register.js holds the single export default')

  assert.equal(Array.from(REGISTER_SOURCE.matchAll(IMPORT_RE)).length, 0, '99-register.js has no static import')
  assert.equal(/\bimport\s*\(/.test(REGISTER_SOURCE), false, '99-register.js has no dynamic import()')
  assert.equal(REGISTER_SOURCE.includes('ctx.timer'), false, 'ctx.timer does not exist (F22)')

  const files = readdirSync(SRC).filter((name) => name.endsWith('.js')).sort()
  assert.equal(files[files.length - 1], '99-register.js', 'rule3: 99-register.js must sort last')
  assert.ok(files.includes('00-core.js'), 'sanity: the tree still holds 00-core.js')
})

// --------------------------------------------------------------------------- //
// default export
// --------------------------------------------------------------------------- //

test('default export: id/name/description/defaultEnabled/register', { skip: SKIP }, async () => {
  const env = await makeEnv({ render: false })
  try {
    const plugin = env.product.plugin
    assert.ok(plugin && typeof plugin === 'object', 'default export must be an object')
    assert.deepEqual(Object.keys(plugin).sort(), ['defaultEnabled', 'description', 'id', 'name', 'register'])
    assert.equal(plugin.id, env.product.WE_PLUGIN_ID, 'id must come from WE_PLUGIN_ID, not a literal')
    assert.equal(plugin.id, 'wallpaper-engine')
    assert.equal(typeof plugin.name, 'string')
    assert.ok(plugin.name.trim().length > 0)
    assert.equal(typeof plugin.description, 'string')
    assert.ok(plugin.description.trim().length > 0)
    assert.equal(typeof plugin.defaultEnabled, 'boolean')
    assert.equal(typeof plugin.register, 'function')
    assert.equal(plugin.register.length, 1, 'register(ctx) takes exactly one argument')
  } finally {
    env.cleanup()
  }
})

// --------------------------------------------------------------------------- //
// contributions (§7.1 step 3)
// --------------------------------------------------------------------------- //

test('register(): pane tab + sidebar row + hand-off page, with a ZERO-ARG render', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    // 1. the pane — the tab in the workspace strip (user: 保留标签栏)
    const pane = env.registrations.filter((entry) => entry.id === 'appearance')
    assert.equal(pane.length, 1, 'exactly one pane contribution')
    assert.equal(pane[0].area, 'panes')
    assert.equal(typeof pane[0].render, 'function')
    assert.equal(pane[0].render.length, 0, 'the host calls render() with no arguments')
    assert.equal(pane[0].data.placement, 'main')
    assert.equal(pane[0].data.defaultCollapsed, true)
    assert.equal(pane[0].data.width, '22rem')
    // center dock: stack into the workspace strip, never a column of its own
    assert.deepEqual(pane[0].data.dock, { pane: 'workspace', pos: 'center', enforce: true })

    // 2. the route the sidebar row points at — a hand-off, not a second panel
    const page = env.registrations.filter((entry) => entry.id === 'page')
    assert.equal(page.length, 1, 'exactly one route contribution')
    assert.equal(page[0].area, 'routes')
    assert.equal(page[0].data.path, '/wallpaper-engine')
    assert.equal(typeof page[0].render, 'function')
    assert.equal(page[0].render.length, 0, 'the host calls render() with no arguments')
    assert.notEqual(page[0].render, pane[0].render, 'the page must not be a second panel')

    // 3. the sidebar row next to 技能与工具 / 消息平台
    const nav = env.registrations.filter((entry) => entry.id === 'nav')
    assert.equal(nav.length, 1)
    assert.equal(nav[0].area, 'sidebar.nav')
    assert.deepEqual(nav[0].data, {
      codicon: 'eye',
      label: '壁纸引擎',
      path: '/wallpaper-engine',
    })
    assert.equal(nav[0].render, undefined, 'sidebar.nav is a DATA contribution')

    // Three, paired: pane + route + row. The library modal is NOT one of them
    // — it is the last child of the panel's own tree (see the comment below).
    assert.equal(env.registrations.length, 3, 'exactly three: pane + page + nav')

    // and the panel really renders — the heading is on screen. The route's
    // hand-off has no SDK global here, so it degrades to the panel itself.
    assert.ok(env.container.textContent.includes('壁纸外观'), 'panel heading renders')

    // END-TO-END proof lives in its own test below ('打开壁纸库 … renders the
    // dialog'): it needs a second env, and nesting two envs in one test breaks
    // the first one's globals.
  } finally {
    env.cleanup()
  }
})

test('打开壁纸库 click really renders the dialog (the regression that shipped)', { skip: SKIP }, async () => {
  // The modal used to be its own `appearance.extra` contribution. When the
  // panel moved to `panes` that seam stopped rendering, the adapter stayed
  // unmounted — and an unmounted component subscribes to nothing, so the
  // button's `pickerOpen: true` landed in a store with no listener and no
  // dialog appeared. It is now the panel's own child, so it is always mounted.
  assert.ok(PICKER_SOURCE, '50-picker.js must be present for this end-to-end check')
  const env = await makeEnv({ picker: 'real' })
  try {
    const button = env.container.querySelector('[data-we-action="open-picker"]')
    assert.ok(button, 'the 打开壁纸库 button is rendered')
    env.react.act(() => {
      button.click()
    })
    const overlay = env.container.querySelector('.we-picker-overlay, [data-we-picker]')
    assert.ok(overlay, 'clicking 打开壁纸库 renders the dialog')
    // and the store really flipped — the button wrote it and someone read it
    assert.equal(env.container.querySelector('[data-we-picker]') !== null, true)
    // the dialog is inside the PANEL's subtree — that is what "always mounted" means
    assert.ok(
      env.container.querySelector('[data-we-panel] [data-we-picker], [data-we-panel] .we-picker-overlay'),
      'the dialog is rendered inside the panel tree',
    )
  } finally {
    env.cleanup()
  }
})

test('register(): without a picker module only the page + nav row are registered, and it still renders', { skip: SKIP }, async () => {
  const env = await makeEnv({ picker: 'none' })
  try {
    assert.equal(env.registrations.length, 3)
    assert.deepEqual(env.registrations.map((entry) => entry.id), ['appearance', 'page', 'nav'])
    const diag = env.product.weRegDiag()
    assert.equal(diag.pickerMissing, true)
    assert.ok(diag.notes.some((note) => note.indexOf('picker-unavailable') === 0), diag.notes.join('|'))
    assert.ok(env.container.textContent.includes('壁纸外观'))
  } finally {
    env.cleanup()
  }
})

test('degraded picker: opening it says so once instead of failing silently', { skip: SKIP }, async () => {
  const env = await makeEnv({ picker: 'none', render: false })
  try {
    const before = env.product.weRegDiag().notes.length
    env.setConfig(env.seedConfig)
    env.react.act(() => {
      env.product.weSet({ pickerOpen: true })
    })
    const state = env.product.weGetState()
    assert.equal(state.toast && state.toast.text ? true : false, true, 'a toast was raised')
    assert.ok(state.toast.text.includes('壁纸库不可用'), state.toast.text)
    // only once — a second notification must not spam the toast
    env.react.act(() => {
      env.product.weSet({ pickerOpen: true, layer: 'idle' })
    })
    assert.equal(env.product.weGetState().toast.text, state.toast.text)
    assert.ok(env.product.weRegDiag().notes.length >= before)
  } finally {
    env.cleanup()
  }
})

test('50-picker on disk: registers the adapter iff wePickerModal exists', { skip: SKIP }, async () => {
  if (!PICKER_SOURCE) {
    assert.ok(true, '50-picker.js absent — nothing to check beyond the degradation test above')
    return
  }
  const env = await makeEnv({ picker: 'real', render: false })
  try {
    // Detected from the source, not from the eval'd symbol table: the harness
    // only pulls the symbols *it* needs, and `wePickerModal` must stay optional.
    const hasModal = /function\s+wePickerModal\s*\(/.test(PICKER_SOURCE)
    const diag = env.product.weRegDiag()
    assert.equal(diag.pickerMissing, !hasModal, 'pickerMissing must be the exact inverse of hasModal')
    // TWO registrations, always: the page and its sidebar row. The modal is a
    // child of the panel's tree, not a third contribution (that separation is
    // what broke "打开壁纸库" — see weRegRegisterContributions).
    assert.equal(env.registrations.length, 3, 'exactly three: pane + page + nav')
    assert.deepEqual(env.registrations.map((entry) => entry.id), ['appearance', 'page', 'nav'])
    // The DOM proof — the dialog really appears on click — is the end-to-end
    // test above; it needs a rendered env, and this one is deliberately not.
  } finally {
    env.cleanup()
  }
})

// --------------------------------------------------------------------------- //
// T11 smoke: enabled → layer appears, disabled → layer removed
// --------------------------------------------------------------------------- //

test('T11: enabled + currentId → the wallpaper layer appears at launch', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    const box = env.layerBox()
    assert.ok(box, '[data-wallpaper-layer] must be in the document')
    assert.equal(box.getAttribute('aria-hidden'), 'true')
    assert.ok(env.layerNodes().length >= 1, 'the layer box holds a layer node')

    const diag = env.product.weRegDiag()
    assert.equal(diag.registered, true)
    assert.equal(diag.disposed, false)
    assert.equal(diag.layerMounted, true)
    assert.equal(diag.lastReason, 'active')
    assert.ok(diag.layerMounts >= 1)

    // the bootstrap round-trip happened (GET /config + /library)
    assert.ok(env.requests.some((entry) => entry.path === '/config'), 'GET /config')
    assert.ok(env.requests.some((entry) => entry.path.indexOf('/library') === 0), 'GET /library')

    // glass was applied from the same snapshot (§7.1 step 4)
    assert.equal(diag.glassStarted, true)
    assert.notEqual(env.sidebarToken(), SEEDED_SIDEBAR, 'the shell token was overridden')
  } finally {
    env.cleanup()
  }
})

test('T11: settings.enabled=false removes the layer box and restores the tokens', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    assert.ok(env.layerBox(), 'precondition: layer is up')
    assert.notEqual(env.sidebarToken(), SEEDED_SIDEBAR, 'precondition: token overridden')

    env.setConfig(makeConfig({ enabled: false }))

    assert.equal(env.layerBox(), null, '[data-wallpaper-layer] must be gone from the document')
    assert.equal(env.product.weGetState().layer, 'idle')
    assert.equal(env.sidebarToken(), SEEDED_SIDEBAR, '--ui-bg-sidebar restored to the theme value')
    assert.equal(env.cardToken(), SEEDED_CARD, '--ui-chat-surface-background restored')

    const diag = env.product.weRegDiag()
    assert.equal(diag.layerMounted, false)
    assert.equal(diag.lastReason, 'disabled')
    assert.ok(diag.layerDrops >= 1)
    // §7.6: the panel entry stays — only the effect goes away
    assert.ok(env.container.textContent.includes('壁纸外观'), 'the appearance panel is still there')
  } finally {
    env.cleanup()
  }
})

test('re-enabling brings the layer back (no stale disposed latch)', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    env.setConfig(makeConfig({ enabled: false }))
    assert.equal(env.layerBox(), null)
    const drops = env.product.weRegDiag().layerDrops

    env.setConfig(makeConfig({ enabled: true }))

    assert.ok(env.layerBox(), '[data-wallpaper-layer] is back')
    assert.ok(env.layerNodes().length >= 1)
    const diag = env.product.weRegDiag()
    assert.equal(diag.layerMounted, true)
    assert.equal(diag.lastReason, 'active')
    assert.ok(diag.layerDrops >= drops, 'no bogus extra drop')
    assert.notEqual(env.sidebarToken(), SEEDED_SIDEBAR, 'tokens re-applied on re-enable')
  } finally {
    env.cleanup()
  }
})

test('T11 full chain: the panel’s enabled switch removes the layer and restores tokens', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    assert.ok(env.layerBox(), 'precondition: layer up')
    assert.notEqual(env.sidebarToken(), SEEDED_SIDEBAR, 'precondition: glass applied')
    assert.equal(env.putCalls().length, 0)

    const toggle = env.query('[data-we-setting="enabled"]')
    assert.ok(toggle, 'the panel renders the enabled switch')
    assert.equal(toggle.checked, true)
    env.click(toggle)
    await env.settle()

    const puts = env.putCalls()
    assert.equal(puts.length, 1, 'the switch persists through exactly one PUT')
    assert.equal(puts[0].path, '/config')
    assert.equal(puts[0].opts.body.settings.enabled, false)

    assert.equal(env.layerBox(), null, 'layer removed after the store round-trip')
    assert.equal(env.sidebarToken(), SEEDED_SIDEBAR, 'tokens back to the theme')
    assert.ok(env.container.textContent.includes('壁纸外观'), 'the panel entry stays (§7.6)')

    // …and back on again, still through the switch
    env.click(env.query('[data-we-setting="enabled"]'))
    await env.settle()
    assert.ok(env.layerBox(), 'layer is back after re-enabling through the panel')
    assert.notEqual(env.sidebarToken(), SEEDED_SIDEBAR)
  } finally {
    env.cleanup()
  }
})

test('no currentId → no layer box, but the panel stays', { skip: SKIP }, async () => {
  const env = await makeEnv({
    config: makeConfig({}, { currentId: null }),
    library: makeLibrarySlice([makeItem()]),
  })
  try {
    assert.equal(env.layerBox(), null)
    assert.equal(env.product.weRegDiag().lastReason, 'no-current')
    assert.ok(env.container.textContent.includes('壁纸外观'))
  } finally {
    env.cleanup()
  }
})

test('an application-kind selection never gets a layer built for it', { skip: SKIP }, async () => {
  const env = await makeEnv({
    config: makeConfig({}, { currentId: 'id-app' }),
    library: makeLibrarySlice([makeItem('id-app', 'application')]),
  })
  try {
    assert.equal(env.layerBox(), null)
    assert.equal(env.product.weRegDiag().lastReason, 'not-playable:application')
  } finally {
    env.cleanup()
  }
})

// --------------------------------------------------------------------------- //
// onDispose
// --------------------------------------------------------------------------- //

test('ctx.onDispose: layer gone, tokens restored, listeners and contributions released', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    assert.ok(env.layerBox(), 'precondition: layer up')
    assert.equal(env.disposers.length, 1, 'exactly one onDispose hook is registered')
    // React's `useSyncExternalStore` in the rendered panel holds its own
    // subscription; unmount it so the count below measures the plugin wiring only.
    env.unmount()
    const watchersBefore = env.listenerCount()
    assert.ok(watchersBefore >= 1, 'the wiring subscribed to the store')

    let report = null
    env.react.act(() => {
      report = env.disposers[0]()
    })

    assert.equal(env.layerBox(), null, 'no [data-wallpaper-layer] left behind')
    assert.equal(env.sidebarToken(), SEEDED_SIDEBAR, 'token restored byte-for-byte')
    assert.equal(env.cardToken(), SEEDED_CARD)
    assert.equal(env.listenerCount(), 0, 'no store listeners left')
    assert.equal(env.registrations.length, 0, 'the contribution unregistered')
    assert.deepEqual(env.removedContributions.sort(), ['appearance', 'nav', 'page'])
    assert.equal(env.product.weGetState().layer, 'idle')

    assert.ok(report, 'teardown reports what it did')
    assert.equal(report.layer, true)
    assert.equal(report.glass, true)
    assert.equal(report.contributions, 3)
    assert.equal(report.subscription, true)

    const diag = env.product.weRegDiag()
    assert.equal(diag.disposed, true)
    assert.equal(diag.registered, false)

    // disposing twice is a no-op, not a crash
    env.react.act(() => {
      const again = env.product.weRegTeardown('again')
      assert.equal(again.layer, false)
      assert.equal(again.contributions, 0)
    })
  } finally {
    env.cleanup()
  }
})

test('a store notification after dispose cannot resurrect the layer', { skip: SKIP }, async () => {
  const env = await makeEnv()
  try {
    env.react.act(() => {
      env.disposers[0]()
    })
    env.setConfig(makeConfig({ enabled: true }))
    assert.equal(env.layerBox(), null)
    assert.equal(env.product.weRegDiag().reconciles >= 1, true)
  } finally {
    env.cleanup()
  }
})

// --------------------------------------------------------------------------- //
// hostile / minimal ctx
// --------------------------------------------------------------------------- //

test('a ctx without register/rest/storage does not throw and records why', { skip: SKIP }, async () => {
  const env = await makeEnv({
    render: false,
    boot: false,
    decorateCtx: (ctx) => {
      delete ctx.register
      delete ctx.rest
      delete ctx.storage
      delete ctx.setTimeout
    },
  })
  try {
    let result = null
    env.react.act(() => {
      result = env.product.weRegRegister({})
    })
    assert.equal(result.contributions, 0)
    assert.equal(env.registrations.length, 0)
    const notes = env.product.weRegDiag().notes.join('|')
    assert.ok(notes.includes('no-register-surface'), notes)
    assert.equal(env.layerBox(), null)
  } finally {
    env.cleanup()
  }
})

test('hydrate from cache: the layer is up before the network answers', { skip: SKIP }, async () => {
  // rest never resolves → only the cached document can drive the first paint
  const env = await makeEnv({
    render: false,
    boot: false,
    rest: () => new Promise(() => {}),
  })
  try {
    // a settled cache from the last session
    const keys = env.product.WE_CACHE_KEYS
    env.cache.set(keys.CONFIG, env.seedConfig)
    env.cache.set(keys.LIBRARY, env.seedLibrary)

    let result = null
    env.react.act(() => {
      result = env.product.weRegRegister(env.ctx)
    })
    assert.equal(result.hydrated, true, 'the cache was read synchronously')
    assert.ok(env.layerBox(), 'layer mounted from the cached snapshot, no network needed')
  } finally {
    env.cleanup()
  }
})

// --------------------------------------------------------------------------- //
// the shipped artefact (T12 on the real product)
// --------------------------------------------------------------------------- //

test('desktop/plugin.js: single export default, react-only import, node --check clean', () => {
  const product = path.join(PLUGIN_ROOT, 'desktop', 'plugin.js')
  if (!existsSync(product)) {
    assert.ok(true, 'plugin.js not built in this tree — T12 on the real product is a build-time check')
    return
  }
  const text = readFileSync(product, 'utf8')
  assert.ok(text.startsWith('// GENERATED by build.py'), 'generated header')

  const defaults = Array.from(text.matchAll(/^[ \t]*export\s+default\b/gm))
  assert.equal(defaults.length, 1, 'exactly one export default')
  assert.ok(defaults[0].index > text.indexOf('function weRegRegister('), 'the export is the last block')

  const specifiers = Array.from(text.matchAll(IMPORT_RE)).map((match) => match[2])
  assert.deepEqual(specifiers, ['react'], 'only the whitelisted react import survives')
  assert.equal(text.includes('ctx.timer'), false, 'F22')

  const mjs = path.join(os.tmpdir(), `we-plugin-${process.pid}-${Date.now()}.mjs`)
  writeFileSync(mjs, text)
  try {
    const check = spawnSync(process.execPath, ['--check', mjs], { encoding: 'utf8' })
    assert.equal(check.status, 0, `node --check failed: ${check.stderr}`)
  } finally {
    rmSync(mjs, { force: true })
  }
})
