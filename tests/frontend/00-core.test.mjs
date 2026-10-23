/**
 * T2.1 — behaviour tests for `desktop/src/00-core.js` (MOD-006).
 *
 * Run with:  node --test tests/frontend/00-core.test.mjs
 *
 * How it loads the module: `00-core.js` is an ESM fragment whose only import is
 * `react` (the one specifier the loader whitelist allows). Rather than pretend
 * the concatenated product is importable here, this harness
 *
 *   1. asserts the head-of-file import is exactly the whitelisted `react` line
 *      and that nothing but comments precedes it (build.py rule 1),
 *   2. strips that one line and evaluates the rest of the source in a function
 *      scope with an injected React — the same global-scope collaboration the
 *      concatenated product relies on,
 *   3. pulls the symbols it needs out by name (a typo fails loudly).
 *
 * React/react-dom/jsdom come from the Hermes desktop tree's node_modules and are
 * dev-only: nothing here is imported by the plugin at runtime.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')
const SOURCE_PATH = path.join(PLUGIN_ROOT, 'desktop', 'src', '00-core.js')
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

// --------------------------------------------------------------------------- //
// dev-only dependency resolution (react 19 / react-dom 19 / jsdom 29)
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

// --------------------------------------------------------------------------- //
// loading the module under test
// --------------------------------------------------------------------------- //

const IMPORT_RE = /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm

const SYMBOLS = [
  'WE_PLUGIN_ID',
  'WE_PLUGIN_VERSION',
  'WE_API_PREFIX',
  'WE_IMPORT_WHITELIST',
  'WE_BOOT',
  'WE_LAYER',
  'WE_TOAST',
  'WE_PLAYABLE_KINDS',
  'WE_CACHE_KEYS',
  'weInitialState',
  'weCreateStore',
  'weGetStore',
  'weGetState',
  'weSet',
  'weSubscribe',
  'weUseStore',
  'weResetStore',
  'weToast',
  'weDescribeError',
  'weStorageGet',
  'weStorageSet',
  'weIsConfigDoc',
  'weNormalizeLibrary',
  'weHydrateFromStorage',
  'weCacheConfig',
  'weCacheLibrary',
  'weApiPath',
  'weRestCall',
  'weConfigFromBody',
  'weRequestStatus',
  'weRequestLibrary',
  'weRequestConfig',
  'weRequestConfigPut',
  'weFindItem',
  'weDeriveCurrent',
  'weIsPlayable',
  'weMediaOrigin',
  'weApplyConfig',
  'weApplyLibrary',
  'weRefreshConfig',
  'weLoadLibrary',
  'weSaveConfig',
  'weSelectWallpaper',
  'weBootstrap',
]

function loadCore(reactImpl) {
  const matches = Array.from(SOURCE.matchAll(IMPORT_RE))
  assert.equal(matches.length, 1, '00-core.js must contain exactly one import statement')
  const [statement] = matches
  const body = SOURCE.replace(statement[0], '')
  // The stripped line is an ESM binding; re-create it as a scope binding so the
  // module body sees exactly the name it imports.
  const factory = new Function(
    '__react',
    '__names',
    `const { useSyncExternalStore } = __react;
${body}
return __names.reduce(function collect(acc, name) { acc[name] = eval(name); return acc }, {})`,
  )
  return factory(reactImpl, SYMBOLS)
}

/** React stub: records the hook arguments and returns the snapshot. */
function makeReactSpy() {
  const calls = []
  return {
    calls,
    useSyncExternalStore(subscribe, getSnapshot) {
      calls.push({ subscribe, getSnapshot })
      return getSnapshot()
    },
  }
}

function makeCore() {
  return loadCore(makeReactSpy())
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
    },
    ...overrides,
  }
}

function makeItem(id, kind = 'video') {
  return {
    id,
    weId: '2001',
    kind,
    title: `标题 ${id}`,
    source: 'workshop',
    path: kind === 'video' ? 'C:/lib/2001/a.mp4' : null,
    dir: 'C:/lib/2001',
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

/** Real backend payload shape: five keys, `scannedAt` included (CONTRACTS C2). */
function makeLibraryBody(items) {
  return {
    engineFound: true,
    mediaOrigin: 'http://127.0.0.1:51234',
    scannedAt: '2026-10-20T16:00:00+08:00',
    items,
    errors: [],
  }
}

function makeCtx(restImpl, seed = {}) {
  const calls = []
  const raw = new Map(Object.entries(seed))
  const ctx = {
    rest(pathArg, opts) {
      calls.push({ path: pathArg, opts })
      return restImpl(pathArg, opts)
    },
    storage: {
      get(key, fallback) {
        return raw.has(key) ? raw.get(key) : fallback
      },
      set(key, value) {
        raw.set(key, value)
      },
      remove(key) {
        raw.delete(key)
      },
    },
  }
  return { ctx, calls, raw }
}

const REJECTING = () => Promise.reject(new Error('bridge unavailable'))

// --------------------------------------------------------------------------- //
// 1. module shape (build.py rule 1 / F2 / no export default)
// --------------------------------------------------------------------------- //

test('module shape: one whitelisted import at the head, no export, no dynamic import', () => {
  const matches = Array.from(SOURCE.matchAll(IMPORT_RE))
  assert.equal(matches.length, 1, 'exactly one import statement')
  assert.equal(matches[0][2], 'react', 'the only specifier must be react')

  const head = SOURCE.slice(0, matches[0].index)
  const stripped = head
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim()
  assert.equal(stripped, '', 'only comments may precede the import (rule 1)')

  assert.equal(/^\s*export\b/m.test(SOURCE), false, '00-core.js must not export (99-register.js owns export default)')
  assert.equal(/\bimport\s*\(/.test(SOURCE), false, 'no dynamic import')
  assert.equal(/\bctx\s*\.\s*timer\b/.test(SOURCE), false, 'ctx.timer does not exist (F22)')
})

test('constants mirror the frozen contract', () => {
  const core = makeCore()
  assert.equal(core.WE_PLUGIN_ID, 'wallpaper-engine')
  assert.equal(core.WE_API_PREFIX, '/api/plugins/wallpaper-engine')
  assert.equal(core.WE_PLUGIN_VERSION, '1.0.0')
  assert.deepEqual([...core.WE_IMPORT_WHITELIST].sort(), [
    '@hermes/plugin-sdk',
    'react',
    'react/jsx-dev-runtime',
    'react/jsx-runtime',
  ])
  assert.deepEqual(Object.values(core.WE_BOOT).sort(), ['error', 'loading', 'ready'])
  assert.deepEqual(Object.values(core.WE_LAYER).sort(), ['active', 'error', 'fallback', 'idle', 'loading'])
  assert.deepEqual([...core.WE_PLAYABLE_KINDS], ['video', 'image', 'web', 'scene'])
})

// --------------------------------------------------------------------------- //
// 2. store — eight fields, shallow merge, subscription
// --------------------------------------------------------------------------- //

test('store starts with the eight §5.4 fields and their empty values', () => {
  const core = makeCore()
  const state = core.weGetState()
  assert.deepEqual(Object.keys(state).sort(), [
    'boot',
    'config',
    'current',
    'layer',
    'library',
    'panelOpen',
    'pickerOpen',
    'toast',
  ])
  assert.equal(state.boot, 'loading')
  assert.equal(state.config, null)
  assert.equal(state.library, null)
  assert.equal(state.current, null)
  assert.equal(state.layer, 'idle')
  assert.equal(state.panelOpen, false)
  assert.equal(state.pickerOpen, false)
  assert.equal(state.toast, null)
})

test('set(patch) shallow-merges, keeps untouched references, and notifies once', () => {
  const core = makeCore()
  const config = makeConfig()
  core.weSet({ config })

  const seen = []
  const dispose = core.weSubscribe((next) => seen.push(next))

  const library = { items: [], mediaOrigin: '', engineFound: false, errors: [] }
  core.weSet({ library, boot: 'ready' })

  assert.equal(seen.length, 1, 'one notification per set()')
  assert.equal(seen[0].config, config, 'untouched top-level field keeps identity')
  assert.equal(seen[0].library, library)
  assert.equal(seen[0].boot, 'ready')

  dispose()
  core.weSet({ boot: 'error' })
  assert.equal(seen.length, 1, 'disposed listener stops hearing')
})

test('set() is identity-stable on no-ops and ignores unknown keys', () => {
  const core = makeCore()
  const before = core.weGetState()
  let notifications = 0
  core.weSubscribe(() => {
    notifications += 1
  })

  core.weSet({ boot: 'loading' })
  core.weSet({ notAField: true })
  core.weSet(null)

  assert.equal(core.weGetState(), before, 'snapshot identity must not change on a no-op')
  assert.equal(notifications, 0, 'useSyncExternalStore must not see a phantom change')
  assert.equal('notAField' in core.weGetState(), false)
})

test('a throwing listener cannot break the others (React boundary guard)', () => {
  const core = makeCore()
  const heard = []
  core.weSubscribe(() => {
    throw new Error('consumer bug')
  })
  core.weSubscribe((state) => heard.push(state.boot))

  assert.doesNotThrow(() => core.weSet({ boot: 'ready' }))
  assert.deepEqual(heard, ['ready'])
})

test('weUseStore binds useSyncExternalStore to the singleton store', () => {
  const react = makeReactSpy()
  const core = loadCore(react)
  const snapshot = core.weUseStore()

  assert.equal(react.calls.length, 1)
  assert.equal(snapshot, core.weGetState())
  assert.equal(react.calls[0].getSnapshot(), core.weGetState())

  let heard = 0
  const dispose = react.calls[0].subscribe(() => {
    heard += 1
  })
  core.weSet({ boot: 'ready' })
  assert.equal(heard, 1)
  dispose()
  core.weSet({ boot: 'error' })
  assert.equal(heard, 1)
  assert.equal(core.weGetStore().listenerCount(), 0)
})

test('a real React render subscribes and re-renders on set', { skip: DEPS.error ? `react/react-dom/jsdom unavailable: ${DEPS.error}` : false }, () => {
  const { react, createRoot, JSDOM } = DEPS
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  // Node 26 defines `navigator` as a getter-only global, so plain assignment
  // throws; define (and later restore) own properties instead.
  const saved = {}
  for (const name of ['window', 'document', 'navigator']) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
      writable: true,
    })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const core = loadCore(react)
  const Probe = function Probe() {
    const state = core.weUseStore()
    return react.createElement('span', null, `${state.boot}/${state.layer}`)
  }

  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  try {
    react.act(() => {
      root.render(react.createElement(Probe))
    })
    assert.equal(container.textContent, 'loading/idle')

    react.act(() => {
      core.weSet({ boot: 'ready', layer: 'active' })
    })
    assert.equal(container.textContent, 'ready/active')
  } finally {
    react.act(() => root.unmount())
    for (const name of ['window', 'document', 'navigator']) {
      if (saved[name]) {
        Object.defineProperty(globalThis, name, saved[name])
      } else {
        delete globalThis[name]
      }
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

// --------------------------------------------------------------------------- //
// 3. ctx.rest client — path form, envelope, failure policy
// --------------------------------------------------------------------------- //

test('weApiPath passes a suffix and tolerates the absolute prefix', () => {
  const core = makeCore()
  assert.equal(core.weApiPath('/config'), '/config')
  assert.equal(core.weApiPath('config'), '/config')
  assert.equal(core.weApiPath('/api/plugins/wallpaper-engine/config'), '/config')
  assert.equal(core.weApiPath('/api/plugins/wallpaper-engine/library?refresh=1'), '/library?refresh=1')
})

test('GET /config reads body.config, not the envelope (CONTRACTS C1)', async () => {
  const core = makeCore()
  const config = makeConfig()
  const { ctx, calls } = makeCtx(() => Promise.resolve({ ok: true, config }))

  const result = await core.weRequestConfig(ctx)

  assert.equal(result.ok, true)
  assert.equal(result.config, config)
  assert.notEqual(result.config, { ok: true, config })
  assert.equal('ok' in result.config, false, 'the envelope must not leak into the store')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/config', 'no double prefix: ctx.rest owns /api/plugins/<id>')
  assert.equal(calls[0].opts, undefined)

  await core.weRefreshConfig(ctx)
  assert.deepEqual(core.weGetState().config, config)
  assert.equal(core.weGetState().boot, 'ready')
})

test('a config body without the envelope is a failure, not an empty config', async () => {
  const core = makeCore()
  const { ctx } = makeCtx(() => Promise.resolve({ ok: true }))
  const result = await core.weRequestConfig(ctx)
  assert.equal(result.ok, false)
  assert.match(String(result.error.message), /config/)
})

test('network rejection only sets toast + boot:error and never throws', async () => {
  const core = makeCore()
  const { ctx } = makeCtx(REJECTING)

  let result
  await assert.doesNotReject(async () => {
    result = await core.weRefreshConfig(ctx)
  })

  assert.equal(result.ok, false)
  const state = core.weGetState()
  assert.equal(state.boot, 'error')
  assert.notEqual(state.toast, null)
  assert.equal(state.toast.kind, 'error')
  assert.match(state.toast.text, /bridge unavailable/)
  assert.equal(state.config, null, 'a failed load must not invent a document')
})

test('non-2xx from the bridge surfaces its status in the toast', async () => {
  const core = makeCore()
  const failure = new Error('503: gateway starting')
  failure.statusCode = 503
  const { ctx } = makeCtx(() => Promise.reject(failure))

  const result = await core.weLoadLibrary(ctx)

  assert.equal(result.ok, false)
  const { toast, boot } = core.weGetState()
  assert.equal(toast.kind, 'error')
  assert.match(toast.text, /503/)
  assert.equal(boot, 'loading', 'a library outage must not decide boot')
})

test('/status and /library requests never reject', async () => {
  const core = makeCore()
  const { ctx } = makeCtx(REJECTING)
  const [status, library] = await Promise.all([
    core.weRequestStatus(ctx),
    core.weRequestLibrary(ctx, { refresh: true }),
  ])
  assert.equal(status.ok, false)
  assert.equal(library.ok, false)
})

test('GET /library?refresh=1 is passed through and the slice drops scannedAt', async () => {
  const core = makeCore()
  const body = makeLibraryBody([makeItem('id-a')])
  const { ctx, calls } = makeCtx(() => Promise.resolve(body))

  const result = await core.weRequestLibrary(ctx, { refresh: true })

  assert.equal(calls[0].path, '/library?refresh=1')
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.library).sort(), ['engineFound', 'errors', 'items', 'mediaOrigin'])
  assert.equal(result.library.mediaOrigin, 'http://127.0.0.1:51234')
  assert.equal('scannedAt' in result.library, false)
})

test('zero-arg rest call reaches the bridge with no options object', async () => {
  const core = makeCore()
  const seen = []
  const ctx = {
    rest(...args) {
      seen.push(args)
      return Promise.resolve({ ok: true, version: '1.0.0' })
    },
  }
  const result = await core.weRequestStatus(ctx)
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [['/status']])
})

test('a missing ctx.rest degrades to a toast instead of a TypeError', async () => {
  const core = makeCore()
  const result = await core.weRefreshConfig({})
  assert.equal(result.ok, false)
  assert.equal(core.weGetState().toast.kind, 'error')
  assert.match(core.weGetState().toast.text, /ctx\.rest/)
  assert.equal(await core.weBootstrap({}).then((r) => r.config.ok), false)
})

// --------------------------------------------------------------------------- //
// 4. cache — first paint from ctx.storage, write-back on success
// --------------------------------------------------------------------------- //

test('hydration fills config/library/current and marks boot ready before any request', () => {
  const core = makeCore()
  const config = makeConfig()
  const library = makeLibraryBody([makeItem('id-a')])
  const { ctx } = makeCtx(REJECTING, {
    [core.WE_CACHE_KEYS.CONFIG]: config,
    [core.WE_CACHE_KEYS.LIBRARY]: library,
  })

  const hydrated = core.weHydrateFromStorage(ctx)

  assert.equal(hydrated, true)
  const state = core.weGetState()
  assert.deepEqual(state.config, config)
  assert.equal(state.current.id, 'id-a', 'current is derived from the cached pair')
  assert.equal(state.boot, 'ready')
  assert.deepEqual(Object.keys(state.library).sort(), ['engineFound', 'errors', 'items', 'mediaOrigin'])
})

test('a corrupt or foreign cache value is ignored silently', () => {
  const core = makeCore()
  const { ctx } = makeCtx(REJECTING, {
    [core.WE_CACHE_KEYS.CONFIG]: { currentId: 'id-a' },
    [core.WE_CACHE_KEYS.LIBRARY]: 'not-a-library',
  })
  assert.equal(core.weHydrateFromStorage(ctx), false)
  assert.equal(core.weGetState().config, null)
  assert.equal(core.weGetState().boot, 'loading')
})

test('storage that throws (quota / missing capability) degrades to empty state', async () => {
  const core = makeCore()
  const ctx = {
    rest: () => Promise.resolve({ ok: true, config: makeConfig() }),
    storage: {
      get() {
        throw new Error('storage locked')
      },
      set() {
        throw new Error('quota exceeded')
      },
    },
  }

  assert.doesNotThrow(() => core.weHydrateFromStorage(ctx))
  const result = await core.weRefreshConfig(ctx)
  assert.equal(result.ok, true, 'a broken cache must not fail the load')
  assert.deepEqual(core.weGetState().config, makeConfig())
})

test('bootstrap hydrates, then corrects from the backend and rewrites the cache', async () => {
  const core = makeCore()
  const cached = makeConfig({ currentId: 'stale' })
  const fresh = makeConfig({ currentId: 'id-a' })
  const library = makeLibraryBody([makeItem('id-a')])
  const { ctx, raw } = makeCtx(
    (pathArg) => Promise.resolve(pathArg === '/config' ? { ok: true, config: fresh } : library),
    {
      [core.WE_CACHE_KEYS.CONFIG]: cached,
      [core.WE_CACHE_KEYS.LIBRARY]: makeLibraryBody([]),
    },
  )

  const out = await core.weBootstrap(ctx)

  assert.equal(out.hydrated, true)
  assert.equal(out.config.ok, true)
  assert.equal(out.library.ok, true)
  const state = core.weGetState()
  assert.deepEqual(state.config, fresh, 'GET /config wins over the cache')
  assert.equal(state.current.id, 'id-a')
  assert.equal(state.boot, 'ready')
  assert.deepEqual(raw.get(core.WE_CACHE_KEYS.CONFIG), fresh, 'cache rewritten after success')
  assert.deepEqual(raw.get(core.WE_CACHE_KEYS.LIBRARY), core.weNormalizeLibrary(library))
})

test('bootstrap resolves (never rejects) when the backend is down', async () => {
  const core = makeCore()
  const { ctx } = makeCtx(REJECTING)

  let out
  await assert.doesNotReject(async () => {
    out = await core.weBootstrap(ctx)
  })

  assert.equal(out.hydrated, false)
  assert.equal(out.config.ok, false)
  assert.equal(core.weGetState().boot, 'error')
  assert.equal(core.weGetState().toast.kind, 'error')
})

// --------------------------------------------------------------------------- //
// 5. selection, PUT, dangling currentId
// --------------------------------------------------------------------------- //

test('PUT /config replaces the whole document and toasts a clamp receipt', async () => {
  const core = makeCore()
  const before = makeConfig({ currentId: 'id-a' })
  const after = makeConfig({ currentId: 'id-a' })
  after.settings.cardBase = 20
  const { ctx, calls } = makeCtx(() => Promise.resolve({ ok: true, config: after, clamped: { cardBase: [10, 20] } }))

  core.weSet({ config: before, boot: 'ready' })
  const result = await core.weSaveConfig(ctx, { settings: { cardBase: 10 } })

  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].opts, { method: 'PUT', body: { settings: { cardBase: 10 } } })
  assert.deepEqual(core.weGetState().config, after, 'the response body wins over the optimistic value')
  assert.equal(core.weGetState().toast.kind, 'info')
  assert.match(core.weGetState().toast.text, /cardBase=20/)
})

test('a failed PUT keeps the local document and only toasts', async () => {
  const core = makeCore()
  const before = makeConfig()
  core.weSet({ config: before, boot: 'ready' })
  const { ctx } = makeCtx(REJECTING)

  const result = await core.weSaveConfig(ctx, { currentId: 'id-b' })

  assert.equal(result.ok, false)
  const state = core.weGetState()
  assert.equal(state.config, before, 'unchanged: a failed save must not blank the page')
  assert.equal(state.boot, 'ready')
  assert.equal(state.toast.kind, 'error')
})

test('weSelectWallpaper applies optimistically, then trusts the backend document', async () => {
  const core = makeCore()
  const library = makeLibraryBody([makeItem('id-a'), makeItem('id-b')])
  const config = makeConfig({ currentId: 'id-a' })
  core.weSet({ config, library: core.weNormalizeLibrary(library) })

  const persisted = makeConfig({ currentId: 'id-b' })
  let resolvePut
  const gate = new Promise((resolve) => {
    resolvePut = resolve
  })
  const { ctx, calls } = makeCtx(() => gate)

  const pending = core.weSelectWallpaper(ctx, 'id-b')
  assert.equal(core.weGetState().config.currentId, 'id-b', 'optimistic before the PUT resolves')
  assert.equal(core.weGetState().current.id, 'id-b')

  resolvePut({ ok: true, config: persisted, clamped: null })
  await pending

  assert.deepEqual(calls[0].opts.body, { currentId: 'id-b' })
  assert.deepEqual(core.weGetState().config, persisted)
  assert.equal(core.weGetState().current.id, 'id-b')
})

test('a vanished selection becomes null with a toast, never a silent fallback', () => {
  const core = makeCore()
  const config = makeConfig({ currentId: 'gone' })
  core.weSet({ config, library: core.weNormalizeLibrary(makeLibraryBody([makeItem('id-a')])) })

  const current = core.weApplyLibrary(core.weNormalizeLibrary(makeLibraryBody([makeItem('id-a')])))

  assert.equal(current, null)
  assert.equal(core.weGetState().current, null, 'no substitution of another wallpaper')
  assert.match(core.weGetState().toast.text, /不可用/)
})

test('an empty library (engine missing) does not accuse the selection', () => {
  const core = makeCore()
  core.weSet({ config: makeConfig({ currentId: 'id-a' }) })
  core.weApplyLibrary(core.weNormalizeLibrary({ engineFound: false, mediaOrigin: null, items: [], errors: [] }))
  assert.equal(core.weGetState().toast, null)
  assert.equal(core.weGetState().library.mediaOrigin, '')
  assert.equal(core.weGetState().library.engineFound, false)
})

test('weIsPlayable and weMediaOrigin', () => {
  const core = makeCore()
  assert.equal(core.weIsPlayable(makeItem('a', 'scene')), true)
  assert.equal(core.weIsPlayable(makeItem('a', 'application')), false)
  assert.equal(core.weIsPlayable(null), false)
  assert.equal(core.weMediaOrigin(), '')
  core.weSet({ library: core.weNormalizeLibrary(makeLibraryBody([])) })
  assert.equal(core.weMediaOrigin(), 'http://127.0.0.1:51234')
})

test('weDescribeError is defensive and bounded', () => {
  const core = makeCore()
  assert.equal(core.weDescribeError(null), '未知错误')
  assert.equal(core.weDescribeError('boom'), 'boom')
  assert.equal(core.weDescribeError({ statusCode: 400, message: 'INVALID_BODY' }), '400 INVALID_BODY')
  assert.equal(core.weDescribeError({ statusCode: 400, message: '400: INVALID_BODY' }), '400: INVALID_BODY')
  assert.equal(core.weDescribeError({ error: 'INVALID_BODY' }), 'INVALID_BODY')
  assert.ok(core.weDescribeError('x'.repeat(1000)).length <= 240)
})

test('weHaveNoTimerSurface: the module never reaches for a timer', () => {
  assert.equal(/\bsetInterval\s*\(/.test(SOURCE), false)
  assert.equal(/\bsetTimeout\s*\(/.test(SOURCE), false)
})
