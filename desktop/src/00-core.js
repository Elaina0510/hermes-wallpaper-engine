/**
 * MOD-006 — renderer core for the wallpaper-engine plugin (T2.1).
 *
 * This is the ONLY part of `desktop/src/` allowed to `import` (design §3.1 rule
 * 1). `desktop/build.py` concatenates every `src/*.js` — this file first — into a
 * single ESM module, so every top-level declaration here is visible to
 * 10-layer.js, 30-glass.js, 40-panel.js, 50-picker.js, 60-rotation.js and
 * 99-register.js. There is no module boundary between them and never a second
 * copy: the store below is created exactly once, at module evaluation, because
 * this file appears exactly once in the product.
 *
 * What lives here:
 *   - constants (plugin id/version, API prefix, enums, cache keys)
 *   - JSDoc mirrors of the backend payloads (review/IDE aid, no runtime cost)
 *   - the single renderer store (§5.4, eight fields) and its React binding
 *   - the `ctx.rest` client for /status, /library, GET|PUT /config
 *   - the `ctx.storage` first-paint cache (§4.2 / §7.1 step 3)
 *
 * Deliberately absent: `export default` (99-register.js owns it), any timer
 * (core needs none — rotation is 60-rotation.js), and any import outside the
 * loader whitelist.
 *
 * Failure policy (§5.4): a network error only ever changes the store. Every
 * request helper resolves to `{ ok: false, error }` instead of rejecting, and
 * every store write sits inside a try/catch, so an outage cannot reach a React
 * error boundary.
 */

import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const WE_PLUGIN_ID = 'wallpaper-engine'

/** Version this renderer was written against — mirrors GET /status.version. */
const WE_PLUGIN_VERSION = '1.0.0'

/** Prefix the gateway mounts this plugin's router on (design §6).
 *
 *  `ctx.rest` already namespaces every call to `/api/plugins/<id>` (the bridge
 *  builds `/api/plugins/${pluginId}${path}` itself), so callers pass a suffix
 *  like `/config`. This constant is the documented form, and `weApiPath` strips
 *  it defensively if a caller ever passes the absolute path — passing it through
 *  untouched would produce `/api/plugins/wallpaper-engine/api/plugins/...`. */
const WE_API_PREFIX = '/api/plugins/wallpaper-engine'

/** Loader import whitelist (F2), kept as data for review. The loader is the
 *  authority; this list exists so the single import at the top of this file can
 *  be diffed against the contract without opening the design doc. */
const WE_IMPORT_WHITELIST = Object.freeze([
  '@hermes/plugin-sdk',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
])

/** Store.boot values (§5.4). */
const WE_BOOT = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
})

/** Store.layer values (§5.4). */
const WE_LAYER = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  ACTIVE: 'active',
  FALLBACK: 'fallback',
  ERROR: 'error',
})

/** Store.toast.kind values (§5.4). */
const WE_TOAST = Object.freeze({
  INFO: 'info',
  ERROR: 'error',
})

/** `WallpaperItem.kind` values that can actually be put on screen. Everything
 *  else (`application`, `unknown`) is listed in the picker but not selectable —
 *  the picker greys it out, the layer refuses it. */
const WE_PLAYABLE_KINDS = Object.freeze(['video', 'image', 'web', 'scene'])

/** `ctx.storage` keys. The schema version lives in the key, so a future shape
 *  change can never read yesterday's document back as today's. */
const WE_CACHE_KEYS = Object.freeze({
  CONFIG: 'we.cache.config.v1',
  LIBRARY: 'we.cache.library.v1',
})

/** Toasts are read by a human; a 4 KB stack trace is not a toast. */
const WE_ERROR_TEXT_LIMIT = 240

// ---------------------------------------------------------------------------
// JSDoc type mirrors
//
// Authoritative source is the backend, not the design prose: the fields below
// were read off `dashboard/scan.py` (WallpaperItem assembly, `_props_defaults`,
// `_normalise_rating`, `_scheme_to_css`) and `dashboard/config.py`
// (SETTINGS_DEFAULTS). CONTRACTS C1/C2 also apply: GET /config is an envelope
// and `/library` carries exactly five keys.
//
// These are comments only — no runtime object is created for them.
// ---------------------------------------------------------------------------

/**
 * One wallpaper as `GET /library` returns it (scan.py:854-870).
 *
 * @typedef {Object} WeWallpaperItem
 * @property {string} id            stable sha256-derived primary key
 * @property {string|null} weId     Workshop id (project directory name)
 * @property {'video'|'image'|'web'|'scene'|'application'|'unknown'} kind
 * @property {string} title
 * @property {'workshop'|'local'} source
 * @property {string|null} path     entry file for file-shaped wallpapers; null for web/scene
 * @property {string} dir           absolute project directory
 * @property {string|null} entry    declared/scene entry, relative to `dir`
 * @property {string|null} preview  absolute preview image path (null → schemeColor placeholder)
 * @property {'everyone'|'pg13'|'mature'|null} rating
 * @property {number} sizeBytes
 * @property {number} mtimeMs
 * @property {Object<string, *>} props  project-declared user property defaults
 * @property {string|null} schemeColor CSS rgb() string derived from WE schemecolor
 * @property {{type: string, url: string}|null} play  media-relative URL (`/m/<token>` or `/s/<token>/<entry>`)
 */

/**
 * The five keys of the `/library` payload (CONTRACTS C2 — do not add a sixth).
 *
 * @typedef {Object} WeLibraryResponse
 * @property {boolean} engineFound
 * @property {string|null} mediaOrigin
 * @property {string} scannedAt     ISO-8601 with offset
 * @property {WeWallpaperItem[]} items
 * @property {{path: string, message: string}[]} errors
 */

/** The `/library` slice the store keeps (§5.4). `scannedAt` is deliberately
 *  dropped: nothing in the UI reads it, and the store is a render input, not a
 *  log.
 *
 * @typedef {Object} WeLibrarySlice
 * @property {WeWallpaperItem[]} items
 * @property {string} mediaOrigin   '' when unknown
 * @property {boolean} engineFound
 * @property {{path: string, message: string}[]} errors
 */

/**
 * Settings block of `ConfigDoc` (config.py SETTINGS_DEFAULTS, all 24 keys).
 *
 * @typedef {Object} WeSettings
 * @property {boolean} enabled
 * @property {number} scrim
 * @property {number} panelBase
 * @property {number} cardBase
 * @property {number} wallpaperBlur
 * @property {number} wallpaperOpacity
 * @property {number} brightness
 * @property {number} contrast
 * @property {number} saturate
 * @property {'cover'|'contain'|'fill'} objectFit
 * @property {boolean} flip
 * @property {number} playbackRate
 * @property {boolean} videoMuted
 * @property {number} videoVolume
 * @property {boolean} pauseOnHidden
 * @property {boolean} pauseOnBlur
 * @property {boolean} sceneLive
 * @property {15|30|60} sceneLiveFps
 * @property {'cut'|'fade'} switchTransition
 * @property {{enabled: boolean, intervalMinutes: number, shuffle: boolean}} rotation
 * @property {'all'|'video'|'image'|'web'|'scene'} typeFilter
 * @property {'all'|'everyone'} contentRating
 * @property {Object<string, Object<string, *>>} userProps  weId → property overrides
 * @property {string[]} extraLibraryRoots
 */

/**
 * Persistent config document — the backend is the single source of truth for
 * every one of these values (config.py:744-748). The renderer never invents a
 * default and never trusts its own optimistic write (§6.3).
 *
 * @typedef {Object} WeConfigDoc
 * @property {number} version
 * @property {string|null} currentId  selected `WallpaperItem.id`, null = none
 * @property {WeSettings} settings
 */

/**
 * `GET /status` — exactly seven keys (plugin_api.py:323-331).
 *
 * @typedef {Object} WeStatusResponse
 * @property {true} ok
 * @property {string} version
 * @property {boolean} engineFound
 * @property {string|null} installDir
 * @property {string[]} libraryDirs
 * @property {string|null} mediaOrigin
 * @property {string|null} mediaError
 */

/**
 * The renderer store (§5.4). Eight fields, all render inputs, none persisted
 * locally: persistence is `PUT /config` and nothing else.
 *
 * @typedef {Object} WeStoreState
 * @property {'loading'|'ready'|'error'} boot
 * @property {WeConfigDoc|null} config
 * @property {WeLibrarySlice|null} library
 * @property {WeWallpaperItem|null} current
 * @property {'idle'|'loading'|'active'|'fallback'|'error'} layer
 * @property {boolean} panelOpen
 * @property {boolean} pickerOpen
 * @property {{text: string, kind: 'info'|'error'}|null} toast
 */

/**
 * Result envelope of every request helper in this file. `error` is an Error
 * when the bridge threw, a string when the body itself said no.
 *
 * @typedef {Object} WeResult
 * @property {boolean} ok
 * @property {*} [value]
 * @property {*} [error]
 */

// ---------------------------------------------------------------------------
// store (§5.4)
// ---------------------------------------------------------------------------

/**
 * A fresh store document. `library` stays null until the first `/library`
 * response (or a cached slice), so consumers can tell "not loaded" from
 * "loaded and empty" — an empty library is a real, meaningful answer.
 *
 * @returns {WeStoreState}
 */
function weInitialState() {
  return {
    boot: WE_BOOT.LOADING,
    config: null,
    library: null,
    current: null,
    layer: WE_LAYER.IDLE,
    panelOpen: false,
    pickerOpen: false,
    toast: null,
  }
}

/**
 * Build one store controller. `set(patch)` is a shallow merge over the current
 * snapshot, restricted to the eight known fields (a typo'd key is ignored
 * instead of silently entering the state), and the snapshot object is replaced
 * only when something actually changed — `useSyncExternalStore` compares
 * snapshots by identity, so returning a fresh object on a no-op `set` would
 * re-render forever.
 *
 * @param {WeStoreState} initial
 * @returns {{getState: function(): WeStoreState, set: function(Object): WeStoreState, subscribe: function(Function): Function, listenerCount: function(): number}}
 */
function weCreateStore(initial) {
  let state = initial
  const listeners = new Set()

  function getState() {
    return state
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') {
      return state
    }
    let next = null
    for (const key of Object.keys(patch)) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) {
        continue
      }
      if (Object.is(state[key], patch[key])) {
        continue
      }
      if (next === null) {
        next = { ...state }
      }
      next[key] = patch[key]
    }
    if (next === null) {
      return state
    }
    state = next
    // Copy first: a listener that unsubscribes itself mid-notify must not skip
    // its neighbour. A throwing listener is contained — one broken consumer is
    // not allowed to stop the others from seeing the new state.
    for (const listener of Array.from(listeners)) {
      try {
        listener(state)
      } catch (error) {
        // Intentionally swallowed: this is the React-boundary guard (§5.4).
      }
    }
    return state
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      return function noop() {}
    }
    listeners.add(listener)
    return function unsubscribe() {
      listeners.delete(listener)
    }
  }

  return {
    getState,
    set,
    subscribe,
    listenerCount: function listenerCount() {
      return listeners.size
    },
  }
}

/**
 * The single store instance for this module evaluation. `00-core.js` appears
 * once in the concatenated product and an ESM module body runs once, so this
 * initialiser cannot run twice in one plugin load; a reload re-evaluates the
 * whole module into a fresh scope, which is exactly the desired "start clean".
 *
 * @type {ReturnType<typeof weCreateStore>}
 */
const weStore = weCreateStore(weInitialState())

/** @returns {ReturnType<typeof weCreateStore>} the controller (set/subscribe). */
function weGetStore() {
  return weStore
}

/** @returns {WeStoreState} current snapshot; stable identity between writes. */
function weGetState() {
  return weStore.getState()
}

/**
 * Apply a shallow patch and notify subscribers.
 *
 * @param {Partial<WeStoreState>} patch
 * @returns {WeStoreState}
 */
function weSet(patch) {
  return weStore.set(patch)
}

/**
 * Subscribe to store changes. Returns the disposer — hand it to
 * `ctx.onDispose` if you subscribe outside a component.
 *
 * @param {(state: WeStoreState) => void} listener
 * @returns {() => void}
 */
function weSubscribe(listener) {
  return weStore.subscribe(listener)
}

/**
 * React binding. Returns the whole snapshot; a panel that needs one field
 * destructures it. Selector-based subscription is deliberately not offered —
 * `useSyncExternalStoreWithSelector` lives in a package outside the import
 * whitelist, and a hand-rolled selector is an infinite-render trap whenever it
 * returns a fresh object.
 *
 * @returns {WeStoreState}
 */
function weUseStore() {
  return useSyncExternalStore(weSubscribe, weGetState, weGetState)
}

/** Restore the initial document (tests, and a disable→enable cycle). */
function weResetStore() {
  return weStore.set(weInitialState())
}

// ---------------------------------------------------------------------------
// toast helpers
// ---------------------------------------------------------------------------

/**
 * @param {*} text
 * @param {'info'|'error'} [kind]
 * @returns {{text: string, kind: 'info'|'error'}}
 */
function weToast(text, kind) {
  const value = text === null || text === undefined ? '' : String(text)
  return {
    text: value,
    kind: kind === WE_TOAST.ERROR ? WE_TOAST.ERROR : WE_TOAST.INFO,
  }
}

/**
 * One-line, human-sized description of anything the bridge or the body threw at
 * us. The Electron api bridge rejects with `<status>: <body>` and a numeric
 * `statusCode` (electron/api-transport.ts:183-190), so the code is only added
 * when the message does not already carry it.
 *
 * @param {*} error
 * @returns {string}
 */
function weDescribeError(error) {
  let text = ''
  let status = 0
  if (typeof error === 'string') {
    text = error
  } else if (error && typeof error === 'object') {
    if (typeof error.statusCode === 'number' && isFinite(error.statusCode)) {
      status = error.statusCode
    }
    if (typeof error.message === 'string' && error.message) {
      text = error.message
    } else if (typeof error.error === 'string') {
      text = error.error
    }
  }
  text = String(text || '').trim() || '未知错误'
  if (status && text.indexOf(String(status)) !== 0) {
    text = status + ' ' + text
  }
  return text.length > WE_ERROR_TEXT_LIMIT ? text.slice(0, WE_ERROR_TEXT_LIMIT - 1) + '…' : text
}

/**
 * @param {string} prefix
 * @param {*} error
 * @returns {{text: string, kind: 'error'}}
 */
function weFailureToast(prefix, error) {
  return weToast(prefix + '：' + weDescribeError(error), WE_TOAST.ERROR)
}

/** Show a toast without touching anything else in the store. */
function weShowToast(text, kind) {
  return weSet({ toast: weToast(text, kind) })
}

/** Clear the current toast (panel dismiss). */
function weClearToast() {
  return weSet({ toast: null })
}

// ---------------------------------------------------------------------------
// ctx.storage cache (§4.2 / §7.1 step 3)
//
// The cache is a first-paint hint, never a source of truth: it is read
// synchronously so the panel has a config before the first `GET /config` lands,
// and overwritten by every successful response. Both directions are wrapped —
// storage can be missing (a host without the capability), full (quota), or hold
// a document from an older shape (JSON that parses but is not a ConfigDoc).
// ---------------------------------------------------------------------------

/**
 * Read one cached value. Silent by design: a cache miss and a broken cache are
 * the same thing to the caller.
 *
 * @param {*} ctx
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
function weStorageGet(ctx, key, fallback) {
  try {
    const storage = ctx && ctx.storage
    if (!storage || typeof storage.get !== 'function') {
      return fallback
    }
    const value = storage.get(key, fallback)
    return value === undefined ? fallback : value
  } catch (error) {
    return fallback
  }
}

/**
 * Write one cached value.
 *
 * @param {*} ctx
 * @param {string} key
 * @param {*} value
 * @returns {boolean} whether it landed
 */
function weStorageSet(ctx, key, value) {
  try {
    const storage = ctx && ctx.storage
    if (!storage || typeof storage.set !== 'function') {
      return false
    }
    storage.set(key, value)
    return true
  } catch (error) {
    return false
  }
}

/**
 * Structural check for a cached/pushed ConfigDoc. Only the shape that would
 * crash a consumer is rejected; individual settings values are the backend's
 * business and are never re-validated here (the renderer has no clamp table and
 * must not grow one — §6.3).
 *
 * @param {*} value
 * @returns {boolean}
 */
function weIsConfigDoc(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const settings = value.settings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return false
  }
  return value.currentId === null || value.currentId === undefined || typeof value.currentId === 'string'
}

/**
 * Normalise any `/library` payload (or cached slice) into the four store keys.
 * Missing fields degrade to the empty value instead of propagating `undefined`
 * into a render path.
 *
 * @param {*} payload
 * @returns {WeLibrarySlice}
 */
function weNormalizeLibrary(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  return {
    items: Array.isArray(source.items) ? source.items : [],
    mediaOrigin: typeof source.mediaOrigin === 'string' ? source.mediaOrigin : '',
    engineFound: source.engineFound === true,
    errors: Array.isArray(source.errors) ? source.errors : [],
  }
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function weIsLibrarySlice(value) {
  return !!value && typeof value === 'object' && Array.isArray(value.items)
}

/**
 * @param {*} ctx
 * @param {WeConfigDoc} config
 * @returns {boolean}
 */
function weCacheConfig(ctx, config) {
  return weIsConfigDoc(config) ? weStorageSet(ctx, WE_CACHE_KEYS.CONFIG, config) : false
}

/**
 * @param {*} ctx
 * @param {WeLibrarySlice} library
 * @returns {boolean}
 */
function weCacheLibrary(ctx, library) {
  return weIsLibrarySlice(library) ? weStorageSet(ctx, WE_CACHE_KEYS.LIBRARY, library) : false
}

/**
 * Seed the store from the last successful session, synchronously.
 *
 * `boot` becomes `ready` when a cached config is present: the eight-field store
 * has no separate "provisional" flag, and leaving it at `loading` would make the
 * panel render a skeleton while it already holds a perfectly usable document —
 * the exact flash §4.2 is trying to avoid. A cached document is provisional in
 * the only sense that matters: the `GET /config` that follows overwrites it, and
 * a failed refresh sets `boot: 'error'` with a toast, so a stale cache is never
 * silently presented as confirmed.
 *
 * @param {*} ctx
 * @returns {boolean} whether anything was hydrated
 */
function weHydrateFromStorage(ctx) {
  try {
    const state = weGetState()
    const cachedConfig = weStorageGet(ctx, WE_CACHE_KEYS.CONFIG, null)
    const cachedLibrary = weStorageGet(ctx, WE_CACHE_KEYS.LIBRARY, null)
    const patch = {}
    if (weIsConfigDoc(cachedConfig)) {
      patch.config = cachedConfig
      patch.boot = WE_BOOT.READY
    }
    if (weIsLibrarySlice(cachedLibrary)) {
      patch.library = weNormalizeLibrary(cachedLibrary)
    }
    if (patch.config === undefined && patch.library === undefined) {
      return false
    }
    patch.current = weDeriveCurrent(
      patch.config === undefined ? state.config : patch.config,
      patch.library === undefined ? state.library : patch.library,
    )
    weSet(patch)
    return true
  } catch (error) {
    return false
  }
}

// ---------------------------------------------------------------------------
// ctx.rest client
//
// `ctx.rest(path, opts)` is the JSON door to this plugin's own namespace: the
// bridge owns the prefix, the token and the profile routing (F9), and it rejects
// on non-2xx with an Error carrying `statusCode`. Everything below therefore
// passes a suffix, catches rejections, and resolves to a result object.
// ---------------------------------------------------------------------------

/**
 * Normalise a path to the suffix form `ctx.rest` expects.
 *
 * @param {string} path
 * @returns {string}
 */
function weApiPath(path) {
  let suffix = typeof path === 'string' ? path : ''
  if (suffix.indexOf(WE_API_PREFIX) === 0) {
    suffix = suffix.slice(WE_API_PREFIX.length)
  }
  if (suffix.charAt(0) !== '/') {
    suffix = '/' + suffix
  }
  return suffix
}

/**
 * One REST round-trip, never rejecting synchronously (the bridge lookup and the
 * call itself are both inside the promise chain).
 *
 * @param {*} ctx
 * @param {string} path
 * @param {Object} [opts]
 * @returns {Promise<*>} the parsed JSON body
 */
function weRestCall(ctx, path, opts) {
  return Promise.resolve().then(function call() {
    if (!ctx || typeof ctx.rest !== 'function') {
      throw new Error('ctx.rest 不可用')
    }
    const suffix = weApiPath(path)
    return opts === undefined ? ctx.rest(suffix) : ctx.rest(suffix, opts)
  })
}

/**
 * A 200 body that carries `{ok: false}` is still a failure; turn it into an
 * Error so every caller handles one shape.
 *
 * @param {*} body
 * @param {string} fallback
 * @returns {Error}
 */
function weBodyError(body, fallback) {
  if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) {
    return new Error(body.error)
  }
  return new Error(fallback)
}

/**
 * Read the ConfigDoc out of a `GET`/`PUT /config` body. CONTRACTS C1: the wire
 * form is `{ok, config}` (PUT adds `clamped`), never a bare ConfigDoc — this is
 * the single place that unwraps it, so no consumer has to remember.
 *
 * @param {*} body
 * @returns {WeConfigDoc|null}
 */
function weConfigFromBody(body) {
  if (!body || typeof body !== 'object') {
    return null
  }
  const doc = body.config
  return weIsConfigDoc(doc) ? doc : null
}

/**
 * GET /status (seven keys). No store field mirrors it — the panel asks for it
 * when it wants to show diagnostics.
 *
 * @param {*} ctx
 * @returns {Promise<{ok: boolean, status: WeStatusResponse|null, error: *}>}
 */
function weRequestStatus(ctx) {
  return weRestCall(ctx, '/status').then(
    function onBody(body) {
      if (!body || typeof body !== 'object' || body.ok === false) {
        return { ok: false, status: null, error: weBodyError(body, 'GET /status 响应无效') }
      }
      return { ok: true, status: body, error: null }
    },
    function onError(error) {
      return { ok: false, status: null, error: error }
    },
  )
}

/**
 * GET /library. `refresh: true` forces a rescan (default hits the backend's 30 s
 * cache).
 *
 * @param {*} ctx
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<{ok: boolean, library: WeLibrarySlice|null, error: *}>}
 */
function weRequestLibrary(ctx, options) {
  const refresh = !!(options && options.refresh === true)
  return weRestCall(ctx, refresh ? '/library?refresh=1' : '/library').then(
    function onBody(body) {
      if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
        return { ok: false, library: null, error: weBodyError(body, 'GET /library 响应无效') }
      }
      return { ok: true, library: weNormalizeLibrary(body), error: null }
    },
    function onError(error) {
      return { ok: false, library: null, error: error }
    },
  )
}

/**
 * GET /config, unwrapped (C1).
 *
 * @param {*} ctx
 * @returns {Promise<{ok: boolean, config: WeConfigDoc|null, error: *}>}
 */
function weRequestConfig(ctx) {
  return weRestCall(ctx, '/config').then(
    function onBody(body) {
      const config = weConfigFromBody(body)
      if (!config) {
        return { ok: false, config: null, error: weBodyError(body, 'GET /config 响应缺少 config 信封') }
      }
      return { ok: true, config, error: null }
    },
    function onError(error) {
      return { ok: false, config: null, error: error }
    },
  )
}

/**
 * PUT /config. The patch is a JSON Merge Patch: send only what changed;
 * `currentId: null` clears the selection; `rotation`/`userProps` are replaced
 * whole by the backend (§6.3).
 *
 * @param {*} ctx
 * @param {{currentId?: string|null, settings?: Object}} patch
 * @returns {Promise<{ok: boolean, config: WeConfigDoc|null, clamped: Object|null, error: *}>}
 */
function weRequestConfigPut(ctx, patch) {
  return weRestCall(ctx, '/config', { method: 'PUT', body: patch }).then(
    function onBody(body) {
      const config = weConfigFromBody(body)
      if (!config) {
        return { ok: false, config: null, clamped: null, error: weBodyError(body, 'PUT /config 响应缺少 config 信封') }
      }
      const clamped = body && typeof body.clamped === 'object' && body.clamped !== null ? body.clamped : null
      return { ok: true, config, clamped, error: null }
    },
    function onError(error) {
      return { ok: false, config: null, clamped: null, error: error }
    },
  )
}

// ---------------------------------------------------------------------------
// selection / derivation
// ---------------------------------------------------------------------------

/**
 * @param {WeLibrarySlice|null} library
 * @param {string|null} id
 * @returns {WeWallpaperItem|null}
 */
function weFindItem(library, id) {
  if (!library || !Array.isArray(library.items) || typeof id !== 'string' || !id) {
    return null
  }
  for (const item of library.items) {
    if (item && item.id === id) {
      return item
    }
  }
  return null
}

/**
 * The selected wallpaper object, derived — never stored as a second truth.
 *
 * @param {WeConfigDoc|null} config
 * @param {WeLibrarySlice|null} library
 * @returns {WeWallpaperItem|null}
 */
function weDeriveCurrent(config, library) {
  const id = config && typeof config.currentId === 'string' ? config.currentId : null
  return weFindItem(library, id)
}

/**
 * @param {WeWallpaperItem|null} item
 * @returns {boolean}
 */
function weIsPlayable(item) {
  return !!item && WE_PLAYABLE_KINDS.indexOf(item.kind) !== -1
}

/**
 * Media origin for the layer's `src` attributes; '' when the media server is
 * down (callers must treat '' as "no URL", not as a relative one).
 *
 * @param {WeStoreState} [state]
 * @returns {string}
 */
function weMediaOrigin(state) {
  const snapshot = state || weGetState()
  return snapshot.library && typeof snapshot.library.mediaOrigin === 'string' ? snapshot.library.mediaOrigin : ''
}

// ---------------------------------------------------------------------------
// store-writing appliers — the only functions that touch the network AND the
// store, so the failure policy lives in one place per endpoint.
// ---------------------------------------------------------------------------

/**
 * Apply a ConfigDoc to the store and refresh `current` from the library.
 *
 * @param {WeConfigDoc} config
 * @param {*} [ctx] cache sink; omit in tests
 * @returns {WeStoreState}
 */
function weApplyConfig(config, ctx) {
  const state = weGetState()
  const next = weSet({
    config,
    current: weDeriveCurrent(config, state.library),
  })
  if (ctx !== undefined) {
    weCacheConfig(ctx, config)
  }
  return next
}

/**
 * Apply a `/library` payload. A selection that is no longer in the library
 * becomes `null` — with a toast, never a silent fallback to some other
 * wallpaper (§5.2). When the library is empty (engine missing, first boot) the
 * toast would be noise, so it is skipped.
 *
 * @param {WeLibrarySlice} library
 * @param {*} [ctx]
 * @returns {WeWallpaperItem|null} the resulting `current`
 */
function weApplyLibrary(library, ctx) {
  const state = weGetState()
  const current = weDeriveCurrent(state.config, library)
  const selectedId = state.config && typeof state.config.currentId === 'string' ? state.config.currentId : null
  const patch = { library, current }
  if (selectedId && !current && library.items.length > 0) {
    patch.toast = weToast('原壁纸已不可用，请重新选择', WE_TOAST.INFO)
  }
  weSet(patch)
  if (ctx !== undefined) {
    weCacheLibrary(ctx, library)
  }
  return current
}

/**
 * GET /config → store. A failure sets `boot: 'error'` and a toast; it never
 * throws, so a dead backend cannot crash the appearance page.
 *
 * @param {*} ctx
 * @returns {Promise<{ok: boolean, config: WeConfigDoc|null, error: *}>}
 */
function weRefreshConfig(ctx) {
  return weRequestConfig(ctx).then(function apply(result) {
    if (!result.ok) {
      weSet({ boot: WE_BOOT.ERROR, toast: weFailureToast('配置加载失败', result.error) })
      return result
    }
    weApplyConfig(result.config, ctx)
    weSet({ boot: WE_BOOT.READY })
    return result
  })
}

/**
 * GET /library → store. A failure is a toast only: `boot` describes the config,
 * and a library outage must not blank a page that already has one.
 *
 * @param {*} ctx
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<{ok: boolean, library: WeLibrarySlice|null, error: *}>}
 */
function weLoadLibrary(ctx, options) {
  return weRequestLibrary(ctx, options).then(function apply(result) {
    if (!result.ok) {
      weSet({ toast: weFailureToast('壁纸库加载失败', result.error) })
      return result
    }
    weApplyLibrary(result.library, ctx)
    return result
  })
}

/**
 * PUT /config → store. The response's `config` replaces the local document
 * wholesale (§6.3) — the renderer never keeps its own clamped-before value. A
 * `clamped` receipt becomes an info toast naming the fields that moved.
 *
 * A failed save is a toast only and leaves `config` untouched: blanking the UI
 * because a slider did not persist would be worse than the stale value.
 *
 * @param {*} ctx
 * @param {{currentId?: string|null, settings?: Object}} patch
 * @returns {Promise<{ok: boolean, config: WeConfigDoc|null, clamped: Object|null, error: *}>}
 */
function weSaveConfig(ctx, patch) {
  return weRequestConfigPut(ctx, patch).then(function apply(result) {
    if (!result.ok) {
      weSet({ toast: weFailureToast('设置保存失败', result.error) })
      return result
    }
    const next = {
      boot: WE_BOOT.READY,
      config: result.config,
      current: weDeriveCurrent(result.config, weGetState().library),
    }
    const fields = result.clamped ? Object.keys(result.clamped) : []
    if (fields.length > 0) {
      const detail = fields.map(function describe(field) {
        const entry = result.clamped[field]
        const effective = Array.isArray(entry) ? entry[1] : entry
        return field + '=' + String(effective)
      })
      next.toast = weToast('已按允许范围修正：' + detail.join('、'), WE_TOAST.INFO)
    }
    weSet(next)
    weCacheConfig(ctx, result.config)
    return result
  })
}

/**
 * Optimistic select, then persist. The local document is updated first so the
 * layer can start loading immediately (§7.2); `weSaveConfig` then overwrites it
 * with whatever the backend actually accepted. The caller owns `pickerOpen` and
 * `layer` — those belong to 50-picker/10-layer, not here.
 *
 * @param {*} ctx
 * @param {string|null} id
 * @returns {Promise<{ok: boolean, config: WeConfigDoc|null, clamped: Object|null, error: *}>}
 */
function weSelectWallpaper(ctx, id) {
  const nextId = typeof id === 'string' && id ? id : null
  const state = weGetState()
  if (state.config) {
    weApplyConfig({ ...state.config, currentId: nextId })
  }
  return weSaveConfig(ctx, { currentId: nextId })
}

// ---------------------------------------------------------------------------
// bootstrap (§7.1 step 3)
// ---------------------------------------------------------------------------

/**
 * First paint, then the truth.
 *
 * 1. synchronously hydrate from `ctx.storage` (no flash, no await)
 * 2. in parallel: `GET /config` and `GET /library`, each overwriting its slice
 * 3. every successful response refreshes the cache for the next launch
 *
 * Never rejects: both branches resolve to result objects, and the synchronous
 * part is guarded. The caller can `void weBootstrap(ctx)` and forget it.
 *
 * @param {*} ctx
 * @returns {Promise<{hydrated: boolean, config: *, library: *}>}
 */
function weBootstrap(ctx) {
  try {
    const hydrated = weHydrateFromStorage(ctx)
    return Promise.all([weRefreshConfig(ctx), weLoadLibrary(ctx)]).then(
      function done(results) {
        return { hydrated, config: results[0], library: results[1] }
      },
      function failed(error) {
        weSet({ boot: WE_BOOT.ERROR, toast: weFailureToast('初始化失败', error) })
        return { hydrated, config: { ok: false, config: null, error }, library: { ok: false, library: null, error } }
      },
    )
  } catch (error) {
    weSet({ boot: WE_BOOT.ERROR, toast: weFailureToast('初始化失败', error) })
    return Promise.resolve({
      hydrated: false,
      config: { ok: false, config: null, error },
      library: { ok: false, library: null, error },
    })
  }
}
