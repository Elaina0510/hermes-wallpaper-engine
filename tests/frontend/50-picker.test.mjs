/**
 * T2.6 / T2.6-R — behaviour tests for `desktop/src/50-picker.js` (MOD-011).
 *
 * Run with:  node --test tests/frontend/50-picker.test.mjs
 *
 * How it loads the module: exactly the shape build.py produces — `00-core.js`
 * with its single whitelisted `react` import stripped and re-bound as a scope
 * binding, immediately followed by `50-picker.js`, evaluated in **one** function
 * scope. That is the only honest way to test a file that is not importable on
 * its own: 50-picker.js borrows `weSet` / `weUseStore` / `weSelectWallpaper` /
 * `weLoadLibrary` from the concatenated scope by name.
 *
 * How it renders: the modal is an ordinary React subtree. Every test mounts
 * `wePickerModal` with a real `createRoot` (dev-only react-dom, resolved from the
 * Hermes desktop tree) and flips `store.pickerOpen` — exactly what the host's
 * contribution slot does. React 19 commits asynchronously, so every interaction
 * is followed by `flush()` before the DOM is asserted.
 *
 * Interactions are dispatched as real DOM events (`MouseEvent` / `input` /
 * `keydown`) so they travel through React's synthetic system: that is the point
 * of the rework — no native listeners are installed by the module (only the
 * document-level Esc effect), and a click on a cell only works if React's
 * `onClick` prop is wired.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')
const SRC_DIR = path.join(PLUGIN_ROOT, 'desktop', 'src')
const CORE_PATH = path.join(SRC_DIR, '00-core.js')
const PICKER_PATH = path.join(SRC_DIR, '50-picker.js')

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
      return {
        react: req('react'),
        createRoot: req('react-dom/client').createRoot,
        JSDOM: req('jsdom').JSDOM,
        base,
      }
    } catch (error) {
      tried.push(`${base}: ${error.message.split('\n')[0]}`)
    }
  }
  throw new Error(`react/react-dom/jsdom not resolvable: ${tried.join(' | ')}`)
}

const DEPS = resolveDeps()

// --------------------------------------------------------------------------- //
// loading the module under test (build.py product shape)
// --------------------------------------------------------------------------- //

const IMPORT_RE = /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm

const CORE_SOURCE = readFileSync(CORE_PATH, 'utf8')
const PICKER_SOURCE = readFileSync(PICKER_PATH, 'utf8')

/** Source with comments removed — assertions about code must not match prose. */
const PICKER_CODE = PICKER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every symbol this suite reaches for, by name — a typo fails loudly. */
const SYMBOLS = [
  // 00-core.js
  'WE_PLAYABLE_KINDS',
  'weGetState',
  'weSet',
  'weSubscribe',
  'weResetStore',
  'weUseStore',
  'weIsPlayable',
  'weFindItem',
  'weSelectWallpaper',
  'weLoadLibrary',
  'weSaveConfig',
  'weStore',
  // 50-picker.js — contract surface (T2.7 depends on it)
  'wePickerModal',
  'wePickerOpen',
  'wePickerClose',
  'wePickerToggle',
  'wePickerDispose',
  'wePickerIsOpen',
  'wePickerRoot',
  // 50-picker.js — helpers
  'WE_PICKER_SKELETON_COUNT',
  'WE_PICKER_TYPE_CHOICES',
  'WE_PICKER_RATING_CHOICES',
  'WE_PICKER_Z_INDEX',
  'WE_PICKER_OVERLAY_STYLE',
  'WE_PICKER_INITIAL_UI',
  'wePickerReact',
  'wePickerH',
  'wePickerDialog',
  'wePickerFilterItems',
  'wePickerRatingMatch',
  'wePickerEmptyModel',
  'wePickerPreviewUrl',
  'wePickerPreviewUrlLocal',
  'wePickerRoots',
  'wePickerSelect',
  'wePickerRefresh',
  'wePickerAddRoot',
  'wePickerKindLabel',
  'wePickerSelectedId',
]

/**
 * Evaluate `00-core.js` + `50-picker.js` in one function scope, the way the
 * built `plugin.js` runs them.
 *
 * @param {*} reactImpl the namespace 00-core's `react` import resolves to
 * @returns {Object} the requested symbols
 */
function loadModule(reactImpl) {
  const matches = Array.from(CORE_SOURCE.matchAll(IMPORT_RE))
  assert.equal(matches.length, 1, '00-core.js must contain exactly one import statement')
  const coreBody = CORE_SOURCE.replace(matches[0][0], '')

  const factory = new Function(
    '__react',
    '__names',
    `const { useSyncExternalStore } = __react;
${coreBody}
${PICKER_SOURCE}
return __names.reduce(function collect(acc, name) { acc[name] = eval(name); return acc }, {})`,
  )
  return factory(reactImpl, SYMBOLS)
}

// --------------------------------------------------------------------------- //
// fixtures + ctx doubles
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
    ...(overrides.currentId !== undefined ? { currentId: overrides.currentId } : {}),
  }
}

let nextId = 0

/** A `WallpaperItem` in the 15-field shape scan.py emits (rating/kind enums). */
function makeItem(overrides = {}) {
  nextId += 1
  const id = overrides.id || `id-${nextId}`
  return {
    id,
    weId: '2001',
    kind: 'video',
    title: `标题 ${id}`,
    source: 'workshop',
    path: 'C:/lib/2001/a.mp4',
    dir: 'C:/lib/2001',
    entry: null,
    preview: null,
    rating: 'everyone',
    sizeBytes: 1024,
    mtimeMs: 1700000000000,
    props: {},
    schemeColor: 'rgb(216, 185, 182)',
    play: { type: 'video', url: `/m/${id}` },
    ...overrides,
  }
}

/** Real backend payload shape: five keys (CONTRACTS C2). */
function makeLibrary(items, overrides = {}) {
  return {
    engineFound: true,
    mediaOrigin: 'http://127.0.0.1:51234',
    scannedAt: '2026-10-20T16:00:00+08:00',
    items,
    errors: [],
    ...overrides,
  }
}

/**
 * `ctx.rest` double: routes `METHOD path` to a handler, records every call.
 * A handler may return a value (wrapped in a resolved promise) or a promise.
 */
function makeCtx(handlers = {}) {
  const calls = []
  const ctx = {
    rest(restPath, opts) {
      calls.push({ path: restPath, opts: opts || null })
      const key = `${opts && opts.method ? opts.method : 'GET'} ${restPath}`
      const handler = handlers[key] || handlers[restPath]
      if (typeof handler !== 'function') {
        return Promise.reject(new Error(`unrouted request: ${key}`))
      }
      try {
        return Promise.resolve(handler(restPath, opts))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    storage: {
      get(key, fallback) {
        return fallback
      },
      set() {},
      remove() {},
    },
  }
  return { ctx, calls }
}

function findCall(calls, method, restPath) {
  return calls.filter((call) => {
    const callMethod = call.opts && call.opts.method ? call.opts.method : 'GET'
    return callMethod === method && call.path === restPath
  })
}

// --------------------------------------------------------------------------- //
// environment helpers
// --------------------------------------------------------------------------- //

let rootSeq = 0

/** Let React's scheduled work and the promise chains settle. */
async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Fresh jsdom + fresh module (fresh store) per test.
 *
 * `globalThis.__HERMES_REACT__` is installed before anything renders — that is
 * the host's order (`installPluginSdk()` runs before any plugin source).
 */
async function setup(options = {}) {
  const dom = new DEPS.JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Node = dom.window.Node
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent

  // The host's React singleton: the *same* namespace 00-core's import resolves to.
  globalThis.__HERMES_REACT__ = options.react || DEPS.react

  const mod = loadModule(DEPS.react)

  const config = options.config === undefined ? makeConfig() : options.config
  const snapshot = { boot: 'ready' }
  if (config !== null) {
    snapshot.config = config
  }
  if (options.library !== undefined) {
    snapshot.library = options.library
  } else {
    snapshot.library = makeLibrary(options.items || [])
  }
  mod.weSet(snapshot)

  return { mod, dom, doc: dom.window.document, win: dom.window, config }
}

/** Mount the contribution the way the `appearance.extra` slot will. */
async function mountComponent(mod, ctx) {
  const container = document.createElement('div')
  container.id = `root-${(rootSeq += 1)}`
  document.body.appendChild(container)
  const root = DEPS.createRoot(container)
  root.render(DEPS.react.createElement(mod.wePickerModal, { ctx }))
  await flush()
  return { root, container }
}

function q(selector) {
  return document.querySelector(selector)
}

function qa(selector) {
  return Array.from(document.querySelectorAll(selector))
}

/** A real bubbling click — React handles it through its root listener. */
function click(el) {
  assert.ok(el, 'click target must exist')
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

/**
 * Type into a controlled input. React tracks an input's value through an
 * instance-level property override, so `el.value = x` would make React believe
 * nothing changed; the native prototype setter bypasses that tracker, which is
 * exactly what a real keystroke does.
 */
function typeInto(el, value) {
  assert.ok(el, 'input must exist')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function pressEscape() {
  document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
}

/** React stamps every node it creates; hand-built DOM has none of these. */
function reactNodeKeys(node) {
  return Object.keys(node).filter(
    (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$'),
  )
}

function reactProps(node) {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))
  return key ? node[key] : null
}

/** Default REST handlers that keep the core helpers happy. */
function defaultHandlers(state) {
  return {
    'GET /config': () => ({ ok: true, config: state.config }),
    'PUT /config': (restPath, opts) => {
      const patch = (opts && opts.body) || {}
      const next = {
        ...state.config,
        ...patch,
        settings: { ...state.config.settings, ...(patch.settings || {}) },
      }
      state.config = next
      return { ok: true, config: next }
    },
    'GET /library': () => {
      const library = state.library || makeLibrary([])
      return library
    },
    'GET /library?refresh=1': () => {
      const library = state.library || makeLibrary([])
      return library
    },
  }
}

/** Fresh jsdom + module + mounted contribution + a routed `ctx`. */
async function setupWithRest(options = {}) {
  const env = await setup(options)
  const state = { config: env.config, library: env.mod.weGetState().library }
  const { ctx, calls } = makeCtx({ ...defaultHandlers(state), ...(options.handlers || {}) })
  const mounted = options.mount === false ? { root: null, container: null } : await mountComponent(env.mod, ctx)
  return { ...env, state, ctx, calls, ...mounted }
}

/** Open the picker and let React commit the dialog. */
async function openPicker(env) {
  env.mod.wePickerOpen(env.ctx)
  await flush()
}

// --------------------------------------------------------------------------- //
// 1. module shape (build.py rule 2 / T10b / T10c / T12)
// --------------------------------------------------------------------------- //

test('module shape: no import, no export, no dynamic import, no ctx.timer, no JSX, no DOM building', () => {
  assert.equal(Array.from(PICKER_SOURCE.matchAll(IMPORT_RE)).length, 0, 'no static import allowed')
  assert.equal(/^\s*export\b/m.test(PICKER_SOURCE), false, 'no export allowed (99-register owns it)')
  assert.equal(/\bimport\s*\(/.test(PICKER_SOURCE), false, 'no dynamic import')
  assert.equal(/\bctx\s*\.\s*timer\b/.test(PICKER_SOURCE), false, 'ctx.timer does not exist (F22)')

  // T10b: sibling file names must never be referenced (the product has no siblings)
  for (const sibling of ['./00-core.js', './10-layer.js', './99-register.js', '../desktop']) {
    assert.equal(PICKER_SOURCE.includes(sibling), false, `must not reference ${sibling}`)
  }

  // The rework: React comes from the host global, never from react-dom.
  assert.equal(/createPortal\s*\(/.test(PICKER_CODE), false, 'createPortal cannot be called (no react-dom)')
  assert.equal(/\breact-dom\b/.test(PICKER_CODE), false, 'react-dom must never be referenced in code')
  assert.match(PICKER_CODE, /__HERMES_REACT__/, 'React must be read from the host global')
  assert.match(PICKER_CODE, /createElement/, 'elements must come from React.createElement')
  assert.equal(/\.createElement\s*\(/.test(PICKER_CODE), false, 'no direct DOM element construction')
  assert.equal(/addEventListener\(\s*['"]click/.test(PICKER_CODE), false, 'no native click delegation')
  assert.equal(/addEventListener\(\s*['"]input/.test(PICKER_CODE), false, 'no native input delegation')
  assert.match(PICKER_CODE, /addEventListener\(\s*['"]keydown/, 'Esc is a document-level effect')

  // Transient UI state moved into React; the module-level mutable object is gone.
  assert.equal(/wePickerUi\b/.test(PICKER_CODE), false, 'no module-level UI state object')
  assert.match(PICKER_CODE, /useState/, 'transient UI state lives in React state')
  assert.match(PICKER_CODE, /useEffect/, 'the Esc listener is an effect')

  // T12 in miniature: plain JS parses (untransformed JSX would throw here).
  assert.doesNotThrow(() => new Function(PICKER_SOURCE), 'the file is plain JS, not JSX')
})

test('loader collaboration: the concatenated scope resolves 00-core symbols by name', async () => {
  const { mod } = await setup({ items: [], mount: false })
  assert.deepEqual([...mod.WE_PLAYABLE_KINDS], ['video', 'image', 'web', 'scene'])
  assert.equal(typeof mod.wePickerModal, 'function')
  assert.equal(typeof mod.wePickerReact, 'function')
  assert.equal(typeof mod.wePickerH, 'function')
  assert.equal(typeof mod.wePickerDialog, 'function')
  assert.equal(mod.WE_PICKER_SKELETON_COUNT, 12)
  assert.deepEqual(
    mod.WE_PICKER_TYPE_CHOICES.map((c) => c.value),
    ['all', 'video', 'image', 'web', 'scene'],
    'type tabs must match config.py typeFilter enum',
  )
  assert.deepEqual(
    mod.WE_PICKER_RATING_CHOICES.map((c) => c.value),
    ['all', 'everyone'],
    'rating tabs must match config.py contentRating enum',
  )
  assert.equal(mod.WE_PICKER_OVERLAY_STYLE.position, 'fixed', 'the overlay floats without a portal')
  assert.equal(mod.WE_PICKER_OVERLAY_STYLE.zIndex, mod.WE_PICKER_Z_INDEX)
  assert.ok(Number(mod.WE_PICKER_Z_INDEX) > 1000)
})

// --------------------------------------------------------------------------- //
// 2. React is really the renderer
// --------------------------------------------------------------------------- //

test('the modal is built through globalThis.__HERMES_REACT__.createElement (React, not hand-built DOM)', async () => {
  const created = []
  const spyReact = Object.create(DEPS.react)
  spyReact.createElement = function createElementSpy(type) {
    created.push(typeof type === 'string' ? type : (type && type.name) || '?')
    return DEPS.react.createElement.apply(DEPS.react, arguments)
  }

  const env = await setupWithRest({
    items: [makeItem({ id: 'id-a', title: '海边' })],
    react: spyReact,
  })
  assert.equal(created.length, 0, 'nothing is created while the picker is closed')
  await openPicker(env)

  assert.ok(created.length > 10, `the tree is created element by element (${created.length})`)
  for (const tag of ['div', 'style', 'section', 'header', 'button', 'span', 'input']) {
    assert.ok(created.includes(tag), `createElement was called for <${tag}>`)
  }
  assert.ok(created.includes('wePickerDialog'), 'the dialog is a React component')
  assert.ok(created.includes('wePickerGrid'), 'the grid is a React component')
  assert.ok(created.includes('wePickerCell'), 'each cell is a React component')

  // Every node in the rendered tree was produced by React (fibre/props stamps).
  const overlay = env.mod.wePickerRoot()
  assert.ok(overlay, 'overlay exists')
  assert.ok(reactNodeKeys(overlay).length >= 2, 'the overlay carries React fibre + props stamps')
  const props = reactProps(overlay)
  assert.equal(typeof props.onClick, 'function', 'the backdrop handler is a React prop')

  const cell = q('[data-we-picker-id="id-a"]')
  assert.equal(typeof reactProps(cell).onClick, 'function', 'cell clicks go through React onClick')
  assert.equal(
    typeof reactProps(q('[data-we-picker-search]')).onInput,
    'function',
    'search is a controlled input driven by a React prop',
  )

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('a host without the React global fails at the accessor and stays quiet while closed', async () => {
  const env = await setupWithRest({ items: [makeItem()] })
  const react = globalThis.__HERMES_REACT__
  delete globalThis.__HERMES_REACT__

  assert.throws(() => env.mod.wePickerReact(), /__HERMES_REACT__/)
  assert.throws(() => env.mod.wePickerH('div', null), /__HERMES_REACT__/)
  // Closed: the contribution renders null and never touches React's namespace.
  assert.equal(q('[data-we-picker]'), null)
  assert.equal(env.mod.weGetState().pickerOpen, false)

  globalThis.__HERMES_REACT__ = react
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 3. open/close state machine writes the real store field
// --------------------------------------------------------------------------- //

test('wePickerOpen/wePickerClose drive store.pickerOpen (the eighth §5.4 field)', async () => {
  const { mod } = await setup({ items: [], mount: false })
  assert.equal(mod.weGetState().pickerOpen, false)

  assert.equal(mod.wePickerOpen(), true)
  assert.equal(mod.weGetState().pickerOpen, true, 'the real store field must change')

  assert.equal(mod.wePickerClose(), true)
  assert.equal(mod.weGetState().pickerOpen, false)

  assert.equal(mod.wePickerToggle(), true)
  assert.equal(mod.weGetState().pickerOpen, true)
  assert.equal(mod.wePickerToggle(), false)
  assert.equal(mod.weGetState().pickerOpen, false)

  // unknown keys are silently dropped by weSet; this file must not rely on one
  assert.deepEqual(Object.keys(mod.weGetState()).sort(), [
    'boot',
    'config',
    'current',
    'layer',
    'library',
    'panelOpen',
    'pickerOpen',
    'toast',
  ])
})

test('transient UI state lives in React state, never in the store', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a', title: 'Ocean' })] })
  await openPicker(env)

  typeInto(q('[data-we-picker-search]'), 'zzz')
  await flush()

  // the filter took effect (React state), and the store is still exactly eight keys
  assert.equal(qa('[data-we-picker-id]').length, 0)
  assert.equal(q('[data-we-picker-empty]').getAttribute('data-we-picker-empty-kind'), 'no-match')
  assert.equal(q('[data-we-picker-search]').value, 'zzz', 'the controlled input shows the query')
  assert.equal(env.mod.weGetState().query, undefined, 'query must never become a store field')
  assert.equal(Object.keys(env.mod.weGetState()).length, 8)
  assert.equal(env.mod.weGetState().pickerOpen, true)

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 4. the overlay renders in the React tree and floats without a portal
// --------------------------------------------------------------------------- //

test('the modal renders inside the contributed React tree, fixed above the app (no portal, no body host)', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a', title: '海边' })] })
  await openPicker(env)

  const host = env.mod.wePickerRoot()
  assert.ok(host, 'overlay element exists')
  assert.equal(env.container.contains(host), true, 'React rendered it into the contribution subtree')
  assert.notEqual(host.parentNode, document.body, 'there is no body-level host any more')
  assert.equal(q('[data-we-picker-host]'), null, 'the old imperative host is gone')
  assert.equal(env.container.querySelector('[data-we-picker]'), host, 'exactly one overlay, in place')

  assert.equal(host.style.position, 'fixed', 'inline position:fixed is the portal substitute')
  assert.equal(host.style.zIndex, String(env.mod.WE_PICKER_Z_INDEX), 'z-index is above the app')
  assert.ok(Number(host.style.zIndex) > 1000)

  assert.ok(document.getElementById('we-picker-style'), 'the stylesheet is mounted as a <style> element')

  const card = q('[role="dialog"]')
  assert.ok(card)
  assert.equal(card.getAttribute('aria-modal'), 'true')
  assert.equal(card.getAttribute('aria-label'), '壁纸库')
  assert.equal(reactNodeKeys(card).length >= 2, true, 'React owns the dialog node as well')

  env.mod.wePickerDispose()
  await flush()
  assert.equal(env.mod.wePickerRoot(), null, 'closing removes it from the tree')
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 5. grid, counts, selection highlight
// --------------------------------------------------------------------------- //

test('grid renders one cell per item with title, badge and count', async () => {
  const items = [
    makeItem({ id: 'id-a', kind: 'video', title: '海边' }),
    makeItem({ id: 'id-b', kind: 'image', title: '山谷' }),
  ]
  const env = await setupWithRest({ items, config: makeConfig({ currentId: 'id-a' }) })
  await openPicker(env)

  const cells = qa('[data-we-picker-id]')
  assert.equal(cells.length, 2)
  assert.deepEqual(
    qa('.we-picker-title').map((el) => el.textContent),
    ['海边', '山谷'],
  )
  assert.deepEqual(
    qa('.we-picker-badge').map((el) => el.textContent),
    ['视频', '图片'],
  )
  assert.equal(q('[data-we-picker-count]').textContent, '共 2 张 · 显示 2 张')

  const selected = q('[data-we-picker-selected="1"]')
  assert.ok(selected, 'current wallpaper is highlighted')
  assert.equal(selected.getAttribute('data-we-picker-id'), 'id-a')
  assert.equal(selected.classList.contains('is-selected'), true)

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 6. selection: apply immediately, then close
// --------------------------------------------------------------------------- //

test('clicking a playable cell applies it through weSelectWallpaper and closes the modal', async () => {
  const items = [
    makeItem({ id: 'id-a', title: '旧的' }),
    makeItem({ id: 'id-b', title: '新的' }),
  ]
  const env = await setupWithRest({ items, config: makeConfig({ currentId: 'id-a' }) })
  await openPicker(env)
  assert.equal(env.mod.weGetState().pickerOpen, true)

  click(q('[data-we-picker-id="id-b"]'))

  // optimistic apply happens synchronously inside weSelectWallpaper
  assert.equal(env.mod.weGetState().config.currentId, 'id-b', 'optimistic selection applied immediately')
  assert.equal(env.mod.weGetState().pickerOpen, false, 'modal closes on selection')

  await flush()

  assert.equal(env.mod.wePickerRoot(), null, 'the tree is gone on close')
  assert.equal(q('[data-we-picker]'), null)

  const puts = findCall(env.calls, 'PUT', '/config')
  assert.equal(puts.length, 1, 'exactly one PUT (the picker must not replay the write)')
  assert.deepEqual(puts[0].opts.body, { currentId: 'id-b' })
  assert.equal(env.mod.weGetState().config.currentId, 'id-b', 'PUT response config wins')

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('application items are greyed out and cannot be selected', async () => {
  const items = [
    makeItem({ id: 'id-a' }),
    makeItem({ id: 'id-app', kind: 'application', title: '应用壁纸', preview: null, play: null }),
  ]
  const env = await setupWithRest({ items, config: makeConfig({ currentId: 'id-a' }) })
  await openPicker(env)

  const cell = q('[data-we-picker-id="id-app"]')
  assert.ok(cell, 'application item is still listed')
  assert.equal(cell.getAttribute('data-we-picker-playable'), '0')
  assert.equal(cell.getAttribute('aria-disabled'), 'true')
  assert.equal(cell.disabled, true, 'native disabled too')
  assert.equal(cell.classList.contains('is-disabled'), true)

  click(cell)
  await flush()

  assert.equal(findCall(env.calls, 'PUT', '/config').length, 0, 'no PUT for an unplayable kind')
  assert.equal(env.mod.weGetState().config.currentId, 'id-a', 'selection unchanged')
  assert.equal(env.mod.weGetState().pickerOpen, true, 'modal stays open')

  // the guard also covers clicks on inner nodes (thumb/title/badge)
  click(cell.querySelector('.we-picker-title'))
  await flush()
  assert.equal(findCall(env.calls, 'PUT', '/config').length, 0)

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('wePickerSelect rejects unknown ids and non-playable kinds before any network call', async () => {
  const items = [makeItem({ id: 'id-a' }), makeItem({ id: 'id-app', kind: 'application' })]
  const env = await setupWithRest({ items })
  await openPicker(env)

  assert.equal(env.mod.wePickerSelect(env.ctx, 'nope'), false)
  assert.equal(env.mod.wePickerSelect(env.ctx, 'id-app'), false)
  await flush()
  assert.equal(env.calls.length, 0, 'no request at all')
  assert.equal(env.mod.weGetState().pickerOpen, true)

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 7. thumbnails: preview img, schemeColor fallback
// --------------------------------------------------------------------------- //

test('missing preview falls back to the schemeColor block plus a kind icon', async () => {
  const items = [
    makeItem({ id: 'id-a', preview: null, schemeColor: 'rgb(216, 185, 182)', kind: 'video' }),
    makeItem({ id: 'id-b', preview: null, schemeColor: null, kind: 'scene' }),
  ]
  const env = await setupWithRest({ items })
  await openPicker(env)

  const thumbA = q('[data-we-picker-id="id-a"] .we-picker-thumb')
  assert.ok(thumbA)
  assert.equal(thumbA.getAttribute('data-we-picker-thumb'), 'scheme')
  assert.equal(thumbA.style.backgroundColor, 'rgb(216, 185, 182)', 'schemeColor is the tile colour')
  assert.equal(thumbA.querySelector('.we-picker-icon').textContent, '▶', 'kind glyph inside the block')
  assert.equal(thumbA.querySelector('img'), null, 'no img without a preview')

  const thumbB = q('[data-we-picker-id="id-b"] .we-picker-thumb')
  assert.equal(thumbB.getAttribute('data-we-picker-thumb'), 'scheme')
  assert.ok(thumbB.style.backgroundColor, 'a neutral fallback colour is still painted')
  assert.equal(thumbB.querySelector('.we-picker-icon').textContent, '✦')

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('preview paths become file:/// URLs, matching the layer fallback', async () => {
  const items = [
    makeItem({ id: 'id-a', preview: 'C:/lib/2001/preview.jpg' }),
    makeItem({ id: 'id-b', preview: 'C:/lib/2002/预览 图.jpg' }),
  ]
  const env = await setupWithRest({ items })
  await openPicker(env)

  const img = q('[data-we-picker-id="id-a"] img')
  assert.ok(img, 'preview rendered as an img')
  assert.equal(img.getAttribute('data-we-picker-preview'), '1')
  assert.equal(img.src, 'file:///C:/lib/2001/preview.jpg')
  assert.equal(
    q('[data-we-picker-id="id-a"] .we-picker-thumb').getAttribute('data-we-picker-thumb'),
    'preview',
  )

  const encoded = q('[data-we-picker-id="id-b"] img').src
  assert.ok(encoded.startsWith('file:///C:/lib/2002/'), encoded)
  assert.equal(encoded.includes(' '), false, 'path segments are percent-encoded')
  assert.notEqual(encoded, 'file:///C:/lib/2002/预览 图.jpg')

  // the mirror must agree with itself for the same three input classes
  const state = env.mod.weGetState()
  assert.equal(env.mod.wePickerPreviewUrl(state, { preview: null }), '')
  assert.equal(env.mod.wePickerPreviewUrl(state, { preview: 'http://x/y.png' }), 'http://x/y.png')
  assert.equal(env.mod.wePickerPreviewUrl(state, { preview: '/m/abc' }), 'http://127.0.0.1:51234/m/abc')
  assert.equal(
    env.mod.wePickerPreviewUrlLocal(state, { preview: 'C:/a/b c.png' }),
    'file:///C:/a/b%20c.png',
  )

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('a preview that fails to load degrades to the colour block', async () => {
  const items = [makeItem({ id: 'id-a', preview: 'C:/lib/2001/preview.jpg', schemeColor: 'rgb(1, 2, 3)' })]
  const env = await setupWithRest({ items })
  await openPicker(env)

  const thumb = q('[data-we-picker-id="id-a"] .we-picker-thumb')
  const img = thumb.querySelector('img')
  assert.ok(img)
  img.dispatchEvent(new window.Event('error'))

  await flush()

  assert.equal(thumb.querySelector('img'), null, 'broken image is replaced')
  assert.equal(thumb.style.backgroundColor, 'rgb(1, 2, 3)', 'schemeColor block underneath')
  assert.ok(thumb.querySelector('.we-picker-icon'), 'kind glyph takes the image slot')

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 8. Esc closes, and the effect's cleanup removes the listener
// --------------------------------------------------------------------------- //

test('Escape closes the modal, and the listener is removed by the effect cleanup', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a' })] })
  await openPicker(env)
  assert.equal(env.mod.weGetState().pickerOpen, true)

  pressEscape()
  await flush()
  assert.equal(env.mod.weGetState().pickerOpen, false, 'Esc closes')
  assert.equal(env.mod.wePickerRoot(), null, 'the tree is torn down')
  assert.equal(q('[data-we-picker]'), null)

  // Re-opening remounts the dialog, so the effect attaches the listener again.
  await openPicker(env)
  pressEscape()
  await flush()
  assert.equal(env.mod.weGetState().pickerOpen, false, 'Esc works on a second open too')

  // Unmounting the contribution runs the cleanup: no stale listener survives.
  env.root.unmount()
  await flush()
  env.mod.weSet({ pickerOpen: true })
  pressEscape()
  assert.equal(env.mod.weGetState().pickerOpen, true, 'the unmounted picker no longer hears Esc')
  env.mod.weSet({ pickerOpen: false })

  env.mod.wePickerDispose()
})

test('backdrop click and the × button also close', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a' })] })

  await openPicker(env)
  click(q('[data-we-picker-close]'))
  await flush()
  assert.equal(env.mod.weGetState().pickerOpen, false)

  await openPicker(env)
  click(q('[data-we-picker]')) // the overlay itself, not the card
  await flush()
  assert.equal(env.mod.weGetState().pickerOpen, false)

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 9. empty states (§9)
// --------------------------------------------------------------------------- //

test('engineFound:false shows the guide plus the manual library root button', async () => {
  const env = await setupWithRest({
    library: makeLibrary([], { engineFound: false, mediaOrigin: '' }),
  })
  await openPicker(env)

  const empty = q('[data-we-picker-empty]')
  assert.ok(empty)
  assert.equal(empty.hidden, false)
  assert.equal(empty.getAttribute('data-we-picker-empty-kind'), 'no-engine')
  assert.match(empty.textContent, /未检测到 Wallpaper Engine/)
  assert.ok(q('[data-we-picker-add-root]'), 'manual root affordance present')
  assert.equal(
    env.mod.wePickerEmptyModel({ engineFound: false, items: [], shown: [], errors: [] }).guide,
    true,
  )

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('scan errors are listed, and an error-only library says the scan failed', async () => {
  const errors = ['C:/lib/2001: project.json 无法解析', 'D:/lib/2002: 目录不可读']
  const env = await setupWithRest({ library: makeLibrary([], { errors }) })
  await openPicker(env)

  const errorsEl = q('[data-we-picker-errors]')
  assert.equal(errorsEl.hidden, false)
  assert.equal(errorsEl.querySelectorAll('li').length, 2)
  assert.match(errorsEl.textContent, /project\.json 无法解析/)
  assert.match(errorsEl.textContent, /目录不可读/)

  const empty = q('[data-we-picker-empty]')
  assert.equal(empty.getAttribute('data-we-picker-empty-kind'), 'error')
  assert.match(empty.textContent, /扫描出错/)

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('items + errors: the grid still renders and the error list is visible', async () => {
  const env = await setupWithRest({
    library: makeLibrary([makeItem({ id: 'id-a' })], { errors: ['C:/lib/9: 损坏'] }),
  })
  await openPicker(env)

  assert.equal(qa('[data-we-picker-id]').length, 1)
  assert.equal(q('[data-we-picker-errors]').hidden, false)
  assert.equal(q('[data-we-picker-empty]').hidden, true, 'no empty state when there are items')

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('an empty but detected library and a filtered-out library get different empty states', async () => {
  const emptyLib = await setupWithRest({ library: makeLibrary([]) })
  await openPicker(emptyLib)
  assert.equal(q('[data-we-picker-empty]').getAttribute('data-we-picker-empty-kind'), 'no-items')
  assert.match(q('[data-we-picker-empty]').textContent, /库里还没有壁纸/)
  emptyLib.mod.wePickerDispose()
  emptyLib.root.unmount()

  const filtered = await setupWithRest({ items: [makeItem({ id: 'id-a', kind: 'video', title: '海边' })] })
  await openPicker(filtered)
  typeInto(q('[data-we-picker-search]'), 'zzz')
  await flush()
  const model = q('[data-we-picker-empty]')
  assert.equal(model.getAttribute('data-we-picker-empty-kind'), 'no-match')
  assert.match(model.textContent, /没有符合筛选条件/)
  assert.equal(q('[data-we-picker-add-root]'), null, 'a filter miss is not an install problem')
  filtered.mod.wePickerDispose()
  filtered.root.unmount()
})

// --------------------------------------------------------------------------- //
// 10. loading state: twelve skeletons
// --------------------------------------------------------------------------- //

test('an unknown library renders twelve skeleton cells and a scanning count', async () => {
  const env = await setupWithRest({
    library: null,
    handlers: { 'GET /library': () => new Promise(() => {}) },
  })
  await openPicker(env)

  const skeletons = qa('[data-we-picker-skeleton]')
  assert.equal(skeletons.length, 12)
  assert.equal(skeletons.length, env.mod.WE_PICKER_SKELETON_COUNT)
  assert.equal(q('[data-we-picker-count]').textContent, '扫描中…')
  assert.equal(q('[data-we-picker-refresh]').disabled, true, 'no refresh storm while loading')
  assert.equal(q('[data-we-picker-empty]').hidden, true, 'skeletons replace the empty state')

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('the refresh button rescans with refresh=1 and shows a busy label', async () => {
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const items = [makeItem({ id: 'id-a' })]
  const env = await setupWithRest({
    items,
    handlers: { 'GET /library?refresh=1': () => pending },
  })
  await openPicker(env)
  assert.equal(qa('[data-we-picker-id]').length, 1)

  click(q('[data-we-picker-refresh]'))
  await flush()
  assert.equal(q('[data-we-picker-refresh]').textContent, '刷新中…')
  assert.equal(q('[data-we-picker-refresh]').disabled, true)
  assert.equal(qa('[data-we-picker-skeleton]').length, 12, 'busy state shows skeletons')

  release(makeLibrary(items, { scannedAt: '2026-10-20T17:00:00+08:00' }))
  await flush()

  assert.equal(q('[data-we-picker-refresh]').textContent, '刷新')
  assert.equal(q('[data-we-picker-refresh]').disabled, false)
  assert.equal(findCall(env.calls, 'GET', '/library?refresh=1').length, 1, 'exactly one forced rescan')
  assert.equal(qa('[data-we-picker-id]').length, 1, 'grid is back')

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 11. filters (§8.4 top bar)
// --------------------------------------------------------------------------- //

test('wePickerFilterItems: search is case-insensitive over title and weId, type and rating compose', async () => {
  const { mod } = await setup({ items: [], mount: false })
  const items = [
    makeItem({ id: 'a', kind: 'video', title: 'Ocean Waves', weId: '2001', rating: 'everyone' }),
    makeItem({ id: 'b', kind: 'image', title: '山谷', weId: '2002', rating: 'everyone' }),
    makeItem({ id: 'c', kind: 'video', title: 'Night', weId: '3003', rating: 'mature' }),
    makeItem({ id: 'd', kind: 'web', title: 'Clock', weId: '3004', rating: null }),
  ]
  const ids = (list) => list.map((item) => item.id)

  assert.deepEqual(ids(mod.wePickerFilterItems(items, {})), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { query: 'ocean' })), ['a'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { query: 'OCEAN' })), ['a'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { query: '2002' })), ['b'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { query: '300' })), ['c', 'd'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { type: 'video' })), ['a', 'c'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { type: 'video', rating: 'everyone' })), ['a'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { rating: 'everyone' })), ['a', 'b', 'd'])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { type: 'scene' })), [])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, { query: 'zzz' })), [])
  assert.deepEqual(ids(mod.wePickerFilterItems(null, {})), [])
  assert.deepEqual(ids(mod.wePickerFilterItems(items, undefined)), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(mod.wePickerFilterItems([null, undefined, 5, 'x'], {})), [], 'junk is dropped')
})

test('the rating tab hides pg13/mature but keeps unknown (null) items', async () => {
  const { mod } = await setup({ items: [], mount: false })
  assert.equal(mod.wePickerRatingMatch('everyone', 'everyone'), true)
  assert.equal(mod.wePickerRatingMatch(null, 'everyone'), true, 'null = unknown = all-ages')
  assert.equal(mod.wePickerRatingMatch(undefined, 'everyone'), true)
  assert.equal(mod.wePickerRatingMatch('pg13', 'everyone'), false)
  assert.equal(mod.wePickerRatingMatch('mature', 'everyone'), false)
  assert.equal(mod.wePickerRatingMatch('mature', 'all'), true)
  assert.equal(mod.wePickerRatingMatch(null, 'all'), true)
})

test('type / rating tabs and the search box filter the grid', async () => {
  const items = [
    makeItem({ id: 'a', kind: 'video', title: 'Ocean', rating: 'everyone' }),
    makeItem({ id: 'b', kind: 'image', title: '山谷', rating: 'everyone' }),
    makeItem({ id: 'c', kind: 'video', title: 'Night', rating: 'mature' }),
    makeItem({ id: 'd', kind: 'scene', title: 'Clock', rating: null }),
  ]
  const env = await setupWithRest({ items })
  await openPicker(env)

  const visibleIds = () => qa('[data-we-picker-id]').map((el) => el.getAttribute('data-we-picker-id'))
  assert.deepEqual(visibleIds(), ['a', 'b', 'c', 'd'])

  // type: video
  click(q('[data-we-picker-choice="type"][data-we-picker-value="video"]'))
  await flush()
  assert.deepEqual(visibleIds(), ['a', 'c'])
  assert.equal(q('[data-we-picker-count]').textContent, '共 4 张 · 显示 2 张')
  assert.equal(
    q('[data-we-picker-choice="type"][data-we-picker-value="video"]').getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    q('[data-we-picker-choice="type"][data-we-picker-value="video"]').classList.contains('is-active'),
    true,
  )

  // rating: everyone (on top of type)
  click(q('[data-we-picker-choice="rating"][data-we-picker-value="everyone"]'))
  await flush()
  assert.deepEqual(visibleIds(), ['a'], 'mature hidden by the family-safe tab')

  // back to all types, then search
  click(q('[data-we-picker-choice="type"][data-we-picker-value="all"]'))
  await flush()
  assert.deepEqual(visibleIds(), ['a', 'b', 'd'])
  typeInto(q('[data-we-picker-search]'), 'cl')
  await flush()
  assert.deepEqual(visibleIds(), ['d'], 'null rating stays visible under 全年龄')

  // filters survive a re-render driven by the store
  env.mod.weSet({ boot: 'ready' })
  await flush()
  assert.deepEqual(visibleIds(), ['d'])
  assert.equal(q('[data-we-picker-search]').value, 'cl', 'the search box keeps its text')

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 12. manual library root (§8.4 / §9)
// --------------------------------------------------------------------------- //

test('manual root: append to settings.extraLibraryRoots, then force a rescan', async () => {
  const env = await setupWithRest({
    library: makeLibrary([], { engineFound: false, mediaOrigin: '' }),
    config: makeConfig({ settings: { extraLibraryRoots: ['D:/already'] } }),
  })
  await openPicker(env)

  click(q('[data-we-picker-add-root]'))
  await flush()

  const input = q('[data-we-picker-root-input]')
  assert.ok(input, 'the form opened')
  assert.match(q('[data-we-picker-empty]').textContent, /已有手动库根：D:\/already/)

  typeInto(input, '  D:/SteamLibrary/steamapps/common/wallpaper_engine  ')
  await flush()
  click(q('[data-we-picker-root-submit]'))
  await flush()

  const puts = findCall(env.calls, 'PUT', '/config')
  assert.equal(puts.length, 1)
  assert.deepEqual(
    puts[0].opts.body,
    {
      settings: { extraLibraryRoots: ['D:/already', 'D:/SteamLibrary/steamapps/common/wallpaper_engine'] },
    },
    'the whole array is sent, trimmed, previous roots preserved',
  )
  assert.equal(findCall(env.calls, 'GET', '/library?refresh=1').length, 1, 'a rescan is triggered')

  assert.equal(q('[data-we-picker-root-input]'), null, 'the form closes after a successful save')
  assert.equal(env.mod.weGetState().config.settings.extraLibraryRoots.length, 2, 'store follows the response')

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('manual root: empty input and duplicates are rejected without a request', async () => {
  const env = await setupWithRest({
    library: makeLibrary([], { engineFound: false }),
    config: makeConfig({ settings: { extraLibraryRoots: ['D:/already'] } }),
  })
  await openPicker(env)
  click(q('[data-we-picker-add-root]'))
  await flush()

  click(q('[data-we-picker-root-submit]'))
  await flush()
  assert.equal(env.calls.length, 0)
  assert.match(q('.we-picker-note.is-error').textContent, /请输入绝对路径/)

  typeInto(q('[data-we-picker-root-input]'), 'D:/already')
  await flush()
  click(q('[data-we-picker-root-submit]'))
  await flush()
  assert.equal(env.calls.length, 0)
  assert.match(q('.we-picker-note.is-error').textContent, /已在库根列表/)

  // cancel closes the form without touching the config
  click(q('[data-we-picker-root-cancel]'))
  await flush()
  assert.equal(q('[data-we-picker-root-input]'), null)
  assert.ok(q('[data-we-picker-add-root]'))

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('manual root: a failed save surfaces the error and keeps the form open', async () => {
  const env = await setupWithRest({
    library: makeLibrary([], { engineFound: false }),
    handlers: {
      'PUT /config': () => Promise.reject(new Error('500: config 写入失败')),
    },
  })
  await openPicker(env)
  click(q('[data-we-picker-add-root]'))
  await flush()
  typeInto(q('[data-we-picker-root-input]'), 'D:/new')
  await flush()
  click(q('[data-we-picker-root-submit]'))
  await flush()

  assert.ok(q('[data-we-picker-root-input]'), 'form stays open')
  assert.match(q('.we-picker-note.is-error').textContent, /config 写入失败/)

  env.mod.wePickerDispose()
  env.root.unmount()
})

// --------------------------------------------------------------------------- //
// 13. lifecycle: dispose / remount / idempotence
// --------------------------------------------------------------------------- //

test('wePickerDispose closes the modal, tears the tree down and drops transient state', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a' })] })
  await openPicker(env)

  typeInto(q('[data-we-picker-search]'), 'abc')
  await flush()
  click(q('[data-we-picker-choice="type"][data-we-picker-value="image"]'))
  await flush()
  assert.equal(q('[data-we-picker-search]').value, 'abc')

  env.mod.wePickerDispose()
  await flush()

  assert.equal(env.mod.wePickerRoot(), null)
  assert.equal(q('[data-we-picker]'), null)
  assert.equal(env.mod.weGetState().pickerOpen, false)

  // Esc must be inert after dispose as well (the effect cleaned up)
  pressEscape()
  assert.equal(env.mod.weGetState().pickerOpen, false)
  assert.equal(env.mod.wePickerDispose(), true, 'dispose is idempotent')

  // The next presentation starts from the initial UI state (the dialog remounted).
  await openPicker(env)
  assert.equal(q('[data-we-picker-search]').value, '', 'search text does not survive a close')
  assert.equal(
    q('[data-we-picker-choice="type"][data-we-picker-value="all"]').getAttribute('aria-pressed'),
    'true',
    'the type filter is back to 全部',
  )

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('the contribution renders on open and unmounts on close (twice is safe)', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a' })] })

  await openPicker(env)
  assert.ok(env.mod.wePickerRoot())
  await openPicker(env)
  assert.equal(qa('[data-we-picker]').length, 1, 'no duplicate overlay on a second open')

  env.mod.wePickerClose()
  await flush()
  assert.equal(env.mod.wePickerRoot(), null)
  env.mod.wePickerClose()
  await flush()
  assert.equal(env.mod.wePickerRoot(), null)

  // re-open through the store alone: the mounted contribution re-renders
  env.mod.weSet({ pickerOpen: true })
  await flush()
  assert.ok(env.mod.wePickerRoot(), 'the store is the only switch')
  assert.equal(qa('[data-we-picker-id]').length, 1)

  env.mod.wePickerDispose()
  env.root.unmount()
})

test('store changes while open re-render the tree through useSyncExternalStore', async () => {
  const env = await setupWithRest({ items: [makeItem({ id: 'id-a', title: '旧的' })] })
  await openPicker(env)
  assert.equal(qa('[data-we-picker-id]').length, 1)

  env.state.library = makeLibrary([
    makeItem({ id: 'id-a', title: '旧的' }),
    makeItem({ id: 'id-b', title: '新的' }),
  ])
  env.mod.weSet({ library: env.state.library })
  await flush()

  assert.equal(qa('[data-we-picker-id]').length, 2, 'the subscription drives the grid')
  assert.equal(q('[data-we-picker-count]').textContent, '共 2 张 · 显示 2 张')

  env.mod.weSet({ pickerOpen: false })
  await flush()
  assert.equal(env.mod.wePickerRoot(), null, 'closing through the store also tears the tree down')

  env.mod.wePickerDispose()
  env.root.unmount()
})
