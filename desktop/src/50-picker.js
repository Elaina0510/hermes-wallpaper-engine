/**
 * MOD-011 — wallpaper library modal (T2.6, reworked in T2.6-R).
 *
 * Design §8.4 (modal spec) and §9 (Wallpaper Engine missing, scan errors,
 * manual library roots). The modal is the only way a user picks a wallpaper, so
 * every branch here is a "user cannot proceed" branch and has to say why.
 *
 * ── where React comes from (no `import`) ────────────────────────────────────
 *
 * `desktop/build.py` rule 1 makes 00-core.js the only file allowed to import, so
 * a second `react` binding is a build failure. The host installs the app's React
 * *singleton* as `globalThis.__HERMES_REACT__` before any plugin source is
 * evaluated:
 *
 *   - `apps/desktop/src/sdk/runtime.ts` does `import * as React from 'react'`,
 *     assigns that namespace to `globalThis.__HERMES_REACT__`, and wires the
 *     loader's `react` shim (`shimUrl('__HERMES_REACT__')`) to the same object —
 *     so the namespace read here is the very object 00-core.js's
 *     `import { useSyncExternalStore } from 'react'` resolves to. One React
 *     instance, therefore no split-hooks failure, no "invalid hook call".
 *   - `installPluginSdk()` (`apps/desktop/src/contrib/runtime-loader.ts`) runs as
 *     the first statement of the loader, strictly before any plugin module is
 *     evaluated, so the global is always installed by the time this file runs.
 *
 * `wePickerReact()` resolves that global on every use and throws when it is
 * absent — the same contract, message shape and failure policy as 40-panel.js's
 * `wePanelReact()`, so a host without the global degrades to the contribution's
 * error boundary instead of a blank screen. The namespace is deliberately not
 * cached: a cached copy would pin the first host's React across a window reload.
 *
 * ── why no `createPortal`, and why no JSX ───────────────────────────────────
 *
 * `createPortal` lives in `react-dom`, which is **not** on the loader's four-key
 * import whitelist (F2) and is not exported by the plugin SDK, so it cannot be
 * reached at all. That is a constraint on *portals*, not on React: the modal is
 * an ordinary React subtree, rendered by the host's own React root, that paints
 * itself over the app:
 *
 *   - the overlay carries inline `position: fixed; inset: 0` plus
 *     `z-index: 2147483000` (`WE_PICKER_Z_INDEX`) — above every app surface, far
 *     below `2**31 - 1` so no engine clamps it. `fixed` resolves against the
 *     viewport, so an ancestor's `overflow`/`position` cannot clip it or stack
 *     over it. (An ancestor with `transform`/`filter`/`perspective` *would*
 *     become its containing block — a known limit of doing this without a portal,
 *     recorded in the task report; the Appearance contribution has no such
 *     ancestor.)
 *   - because the subtree lives inside the React root, every handler is a React
 *     **synthetic** event (`onClick`, `onInput`, `onError`; `onInput` rather than
 *     `onChange` for the two text fields — see the note in `wePickerToolbar`).
 *     Nothing here
 *     attaches a native listener to the overlay: React already delegates at its
 *     root container, which is the tree this subtree is in. The one exception is
 *     Esc, which must be a document-level listener and is a `useEffect` (see
 *     `wePickerUseEscape`).
 *
 * JSX is impossible for a mechanical reason: `build.py` only concatenates bytes
 * and the runtime loader only rewrites bare specifiers — neither transforms JSX.
 * JSX left in the product fails T12 (`node --check`) and then fails to parse at
 * load. Every element therefore comes from `wePickerH(...)`, a thin
 * `React.createElement` facade (the same pattern as 40-panel.js's `wePanelH`).
 *
 * ── state ──────────────────────────────────────────────────────────────────
 *
 * §5.4 keeps the store at eight fields, and `pickerOpen` is the only one the
 * picker owns. Transient view state (search text, type/rating filter, the rescan
 * busy flag, the manual-root form) lives in React `useState` **inside the dialog
 * component**, which is mounted only while `pickerOpen` is true. Closing the
 * modal unmounts it, so a fresh open starts from `WE_PICKER_INITIAL_UI` — no
 * module-level mutable UI object, no reset code, nothing to leak. The one
 * `useRef` holds the latest committed UI state so the in-flight guards ("do not
 * start a second rescan") see this tick's value instead of the last render's.
 *
 * Esc is a `useEffect`: the document `keydown` listener is added when the dialog
 * mounts and removed by its cleanup when it unmounts, so a closed picker cannot
 * hijack Esc from the rest of the app.
 *
 * ── ownership ──────────────────────────────────────────────────────────────
 *
 *  - `wePickerOpen` / `wePickerClose` / `wePickerToggle` own `store.pickerOpen`;
 *    rendering is React's job — `wePickerModal` is the contribution and re-renders
 *    off `weUseStore()`.
 *  - selection goes through 00-core's `weSelectWallpaper(ctx, id)`, which already
 *    does optimistic-apply → PUT → response-config-overwrites-local → re-derive
 *    `current`. Replaying the PUT here would double-write.
 *  - the layer follows the store on its own (10-layer.js subscribes to
 *    `weSubscribe`), so the picker never touches layer DOM.
 *  - 99-register.js registers `wePickerModal` and calls `wePickerDispose()` from
 *    `ctx.onDispose`.
 *
 * `ctx` has no `timer` (F22) and none is needed: a rescan is a promise and its
 * busy flag is cleared in the promise's own continuation.
 */

// --------------------------------------------------------------------------- //
// constants
// --------------------------------------------------------------------------- //

/** Marker attribute on the overlay — the modal's root node, and what
 *  `wePickerRoot()` looks for. */
const WE_PICKER_MARK_ATTR = 'data-we-picker'

/**
 * Above every app surface, and far below `2**31 - 1` so no engine clamps it.
 * The wallpaper layer itself sits at `z-index:-1` (10-layer.js).
 */
const WE_PICKER_Z_INDEX = 2147483000

/** §8.4: twelve skeleton cells while the library is unknown. */
const WE_PICKER_SKELETON_COUNT = 12

const WE_PICKER_STYLE_ID = 'we-picker-style'

/**
 * Type filter values. These are exactly `settings.typeFilter`'s enum in
 * `dashboard/config.py` (`all|video|image|web|scene`) — `application` and
 * `unknown` have no tab on purpose: they cannot be played, only greyed out in
 * the grid (§8.4).
 */
const WE_PICKER_TYPE_CHOICES = Object.freeze([
  Object.freeze({ value: 'all', label: '全部' }),
  Object.freeze({ value: 'video', label: '视频' }),
  Object.freeze({ value: 'image', label: '图片' }),
  Object.freeze({ value: 'web', label: '网页' }),
  Object.freeze({ value: 'scene', label: '场景' }),
])

/** `settings.contentRating` enum in `dashboard/config.py` (`all|everyone`). */
const WE_PICKER_RATING_CHOICES = Object.freeze([
  Object.freeze({ value: 'all', label: '全部' }),
  Object.freeze({ value: 'everyone', label: '全年龄' }),
])

/** `WallpaperItem.kind` → Chinese badge (§8.4 "类型徽标"). */
const WE_PICKER_KIND_LABELS = Object.freeze({
  video: '视频',
  image: '图片',
  web: '网页',
  scene: '场景',
  application: '应用',
  unknown: '未知',
})

/** Glyph shown inside the schemeColor block when a preview is missing. */
const WE_PICKER_KIND_ICONS = Object.freeze({
  video: '▶',
  image: '▣',
  web: '◍',
  scene: '✦',
  application: '⚙',
  unknown: '?',
})

/** Fallback tile colour when an item has neither `preview` nor `schemeColor`. */
const WE_PICKER_THUMB_FALLBACK = 'rgba(128, 128, 128, 0.18)'

/**
 * The overlay's inline geometry — **this is the portal substitute**. `fixed`
 * escapes ancestor scrolling/overflow by resolving against the viewport, and the
 * z-index puts the modal above every app surface without touching app tokens.
 */
const WE_PICKER_OVERLAY_STYLE = Object.freeze({
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: WE_PICKER_Z_INDEX,
})

/**
 * Initial transient UI state. A frozen constant is both the `useState` initial
 * value and the reset value: the dialog unmounts on close, so a fresh mount is a
 * fresh object and there is no reset code anywhere in this file.
 */
const WE_PICKER_INITIAL_UI = Object.freeze({
  query: '',
  typeFilter: 'all',
  ratingFilter: 'all',
  refreshing: false,
  rootForm: false,
  rootInput: '',
  rootError: '',
  rootNote: '',
  rootBusy: false,
})

/** No preview has failed yet (frozen so equal updates can bail out). */
const WE_PICKER_NO_FAILURES = Object.freeze({})

/**
 * Stylesheet, injected once per mounted dialog. Every selector is
 * `we-picker`-prefixed. Colours are the CSS system colours (`Canvas` /
 * `CanvasText`) so the modal follows the app's light/dark scheme without reading
 * a token that belongs to 30-glass.js.
 */
const WE_PICKER_STYLE = `
.we-picker-overlay{background:rgba(0,0,0,.42);font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.we-picker-card{display:flex;flex-direction:column;width:min(1040px,92vw);height:min(720px,86vh);background:Canvas;color:CanvasText;border:1px solid rgba(128,128,128,.35);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.34);overflow:hidden}
.we-picker-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.28)}
.we-picker-search{flex:1 1 180px;min-width:140px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.10);color:inherit;font:inherit}
.we-picker-tabs{display:flex;gap:2px;padding:2px;border-radius:8px;background:rgba(128,128,128,.12)}
.we-picker-tab{padding:3px 9px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.72}
.we-picker-tab.is-active{background:rgba(99,142,255,.28);opacity:1}
.we-picker-btn{padding:4px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.10);color:inherit;font:inherit;cursor:pointer}
.we-picker-btn:disabled{opacity:.55;cursor:default}
.we-picker-count{margin-left:auto;opacity:.66;white-space:nowrap}
.we-picker-close{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7}
.we-picker-body{flex:1 1 auto;overflow:auto;padding:12px}
.we-picker-errors{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:rgba(214,76,76,.14);border:1px solid rgba(214,76,76,.38);font-size:12px}
.we-picker-errors[hidden]{display:none}
.we-picker-errors ul{margin:4px 0 0;padding-left:18px}
.we-picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}
.we-picker-cell{display:flex;flex-direction:column;gap:6px;padding:7px;border-radius:10px;border:1px solid transparent;background:rgba(128,128,128,.10);color:inherit;font:inherit;text-align:left;cursor:pointer}
.we-picker-cell:hover{border-color:rgba(99,142,255,.55)}
.we-picker-cell.is-selected{outline:2px solid rgb(99,142,255);background:rgba(99,142,255,.18)}
.we-picker-cell.is-disabled{opacity:.45;cursor:not-allowed}
.we-picker-cell.is-disabled:hover{border-color:transparent}
.we-picker-thumb{position:relative;display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:16/9;border-radius:8px;overflow:hidden}
.we-picker-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.we-picker-icon{font-size:26px;line-height:1;opacity:.8}
.we-picker-meta{display:flex;align-items:center;gap:6px;min-width:0}
.we-picker-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.we-picker-badge{flex:0 0 auto;padding:1px 6px;border-radius:999px;background:rgba(128,128,128,.22);font-size:11px;opacity:.85}
.we-picker-skeleton{height:132px;border-radius:10px;background:linear-gradient(90deg,rgba(128,128,128,.12),rgba(128,128,128,.26),rgba(128,128,128,.12));background-size:200% 100%;animation:we-picker-pulse 1.2s ease-in-out infinite}
@keyframes we-picker-pulse{0%{background-position:0 0}100%{background-position:-200% 0}}
.we-picker-empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:24px 8px}
.we-picker-empty[hidden]{display:none}
.we-picker-empty-title{font-size:14px;font-weight:600}
.we-picker-empty-detail{max-width:60ch;opacity:.75}
.we-picker-form{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px}
.we-picker-root-input{min-width:320px;padding:5px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.10);color:inherit;font:inherit}
.we-picker-note{font-size:12px;opacity:.72}
.we-picker-note.is-error{color:rgb(214,76,76);opacity:.95}
`

// --------------------------------------------------------------------------- //
// React access (no import — see the file header)
// --------------------------------------------------------------------------- //

/**
 * The app's React singleton, installed by the host before plugins evaluate.
 *
 * Read fresh on every call (never cached): the namespace must stay the one the
 * host currently uses, and the host is its only writer.
 *
 * @returns {Object} the React namespace (`createElement`, `useState`, …)
 */
function wePickerReact() {
  const host = typeof globalThis === 'undefined' ? null : globalThis
  const react = host && host.__HERMES_REACT__ ? host.__HERMES_REACT__ : null
  if (!react || typeof react.createElement !== 'function') {
    throw new Error('React 运行时不可用：宿主未注册 globalThis.__HERMES_REACT__')
  }
  return react
}

/**
 * `React.createElement` in rest-argument form, so one element can be written per
 * expression without an array wrapper (no JSX — see the file header).
 *
 * @param {*} type component or tag name
 * @param {Object|null} props
 * @returns {*} React element
 */
function wePickerH(type, props) {
  const react = wePickerReact()
  const children = Array.prototype.slice.call(arguments, 2)
  const args = [type, props === undefined ? null : props].concat(children)
  return react.createElement.apply(react, args)
}

// --------------------------------------------------------------------------- //
// pure helpers (no store, no React — the tests pin the matrix here)
// --------------------------------------------------------------------------- //

/**
 * @param {string} kind
 * @returns {string}
 */
function wePickerKindLabel(kind) {
  return WE_PICKER_KIND_LABELS[kind] || WE_PICKER_KIND_LABELS.unknown
}

/**
 * @param {string} kind
 * @returns {string}
 */
function wePickerKindIcon(kind) {
  return WE_PICKER_KIND_ICONS[kind] || WE_PICKER_KIND_ICONS.unknown
}

/**
 * Content-rating predicate for the "全年龄" tab.
 *
 * `rating` is `'everyone'|'pg13'|'mature'|null` (scan.py). Unknown (`null`) is
 * treated as **all-ages**: a workshop item without a rating field must not
 * disappear the moment the user asks for the family-safe view — hiding it would
 * silently shrink the library with no explanation. `pg13`/`mature` are hidden.
 *
 * @param {string|null|undefined} rating
 * @param {string} filter one of `all|everyone`
 * @returns {boolean}
 */
function wePickerRatingMatch(rating, filter) {
  if (filter !== 'everyone') {
    return true
  }
  return rating === null || rating === undefined || rating === 'everyone'
}

/**
 * Search + type + rating, in that order.
 *
 * @param {Array<*>|null|undefined} items `library.items`
 * @param {{query?: string, type?: string, rating?: string}} [filters]
 * @returns {Array<*>}
 */
function wePickerFilterItems(items, filters) {
  const list = Array.isArray(items) ? items : []
  const raw = filters || {}
  const query = typeof raw.query === 'string' ? raw.query.trim().toLowerCase() : ''
  const type = typeof raw.type === 'string' && raw.type ? raw.type : 'all'
  const rating = typeof raw.rating === 'string' && raw.rating ? raw.rating : 'all'

  return list.filter(function keep(item) {
    if (!item || typeof item !== 'object') {
      return false
    }
    if (type !== 'all' && item.kind !== type) {
      return false
    }
    if (!wePickerRatingMatch(item.rating, rating)) {
      return false
    }
    if (!query) {
      return true
    }
    const title = typeof item.title === 'string' ? item.title.toLowerCase() : ''
    const weId = item.weId === null || item.weId === undefined ? '' : String(item.weId).toLowerCase()
    return title.indexOf(query) !== -1 || weId.indexOf(query) !== -1
  })
}

/**
 * Preview URL for a grid thumbnail, with the same three cases as the layer's
 * fallback image so the tile and the layer cannot disagree about one item:
 * already-a-URL passes through, `/`-rooted is resolved against the media origin,
 * and an absolute filesystem path becomes `file:///…`.
 *
 * 10-layer.js owns that logic (`weLayerPreviewUrl`); this file delegates to it
 * when the concatenated product provides it and otherwise runs the identical
 * mirror below, which keeps the module testable on its own.
 *
 * @param {*} state store snapshot (for `library.mediaOrigin`)
 * @param {*} item
 * @returns {string} '' when there is nothing to show
 */
function wePickerPreviewUrl(state, item) {
  if (typeof weLayerPreviewUrl === 'function') {
    try {
      return weLayerPreviewUrl(state, item) || ''
    } catch (error) {
      // fall through to the local mirror
    }
  }
  return wePickerPreviewUrlLocal(state, item)
}

/**
 * Mirror of `wePickerPreviewUrl`'s contract for the standalone case. Kept
 * byte-for-byte equivalent to the layer's rules on purpose.
 *
 * @param {*} state
 * @param {*} item
 * @returns {string}
 */
function wePickerPreviewUrlLocal(state, item) {
  const raw = item && typeof item.preview === 'string' ? item.preview.trim() : ''
  if (!raw) {
    return ''
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw
  }
  if (raw.charAt(0) === '/') {
    const origin = weMediaOrigin(state)
    return origin ? String(origin).replace(/\/+$/, '') + raw : ''
  }
  const segments = raw.replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  const encoded = segments
    .map(function encodeSegment(segment) {
      return /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    })
    .join('/')
  return 'file:///' + encoded
}

/**
 * Selected wallpaper id, from the document first (`config.currentId` is the
 * truth that was PUT) and from the derived `current` only as a fallback.
 *
 * @param {*} state
 * @returns {string}
 */
function wePickerSelectedId(state) {
  const config = state && state.config
  if (config && typeof config.currentId === 'string' && config.currentId) {
    return config.currentId
  }
  const current = state && state.current
  return current && typeof current.id === 'string' ? current.id : ''
}

/**
 * One line of user-facing text for a `library.errors[]` entry. The backend
 * writes strings; anything else is serialised defensively rather than printed
 * as `[object Object]`.
 *
 * @param {*} entry
 * @returns {string}
 */
function wePickerErrorText(entry) {
  if (typeof entry === 'string') {
    return entry
  }
  if (entry === null || entry === undefined) {
    return ''
  }
  try {
    return JSON.stringify(entry)
  } catch (error) {
    return String(entry)
  }
}

/**
 * Which empty-state the body should show (§8.4 / §9), or `null` when the grid
 * has something in it. Split out from the renderer so the precedence is
 * reviewable and testable:
 *
 *   loading            → null (the twelve skeletons are the state)
 *   engineFound:false  → "未检测到 Wallpaper Engine" + 手动添加库根
 *   items 空 + errors  → 扫描出错 (+ the error list, rendered separately)
 *   items 空           → 库里还没有壁纸
 *   filtered 空        → 没有符合筛选条件的壁纸 (filters, not an outage)
 *
 * @param {{loading?: boolean, engineFound?: boolean, items?: Array<*>, shown?: Array<*>, errors?: Array<*>}} input
 * @returns {{kind: string, title: string, detail: string, guide: boolean}|null}
 */
function wePickerEmptyModel(input) {
  const source = input || {}
  const items = Array.isArray(source.items) ? source.items : []
  const shown = Array.isArray(source.shown) ? source.shown : []
  const errors = Array.isArray(source.errors) ? source.errors : []

  if (source.loading) {
    return null
  }
  if (source.engineFound !== true) {
    return {
      kind: 'no-engine',
      title: '未检测到 Wallpaper Engine',
      detail:
        '没有在 Steam 库里找到 wallpaper_engine。安装后重试即可自动发现；' +
        '也可以手动添加库根目录（指向 workshop/content/431960 的上一级，例如 …/steamapps/common/wallpaper_engine）。',
      guide: true,
    }
  }
  if (items.length === 0) {
    if (errors.length > 0) {
      return {
        kind: 'error',
        title: '扫描出错，未找到壁纸',
        detail: '下方列出了出错的路径。修正库根或项目文件后点「刷新」重扫。',
        guide: true,
      }
    }
    return {
      kind: 'no-items',
      title: '库里还没有壁纸',
      detail: '订阅的壁纸会自动出现在这里；也可以手动添加一个库根目录。',
      guide: true,
    }
  }
  if (shown.length === 0) {
    return {
      kind: 'no-match',
      title: '没有符合筛选条件的壁纸',
      detail: '清空搜索词，或把类型/评分过滤切回「全部」。',
      guide: false,
    }
  }
  return null
}

/**
 * `settings.extraLibraryRoots`, cleaned to non-empty strings.
 *
 * @param {*} state
 * @returns {Array<string>}
 */
function wePickerRoots(state) {
  const settings = state && state.config && state.config.settings ? state.config.settings : {}
  const roots = Array.isArray(settings.extraLibraryRoots) ? settings.extraLibraryRoots : []
  return roots.filter(function isText(entry) {
    return typeof entry === 'string' && entry !== ''
  })
}

/**
 * @param {*} ctx
 * @returns {Document|null} `ctx.document` first — the plugin is told to use the
 * host's document (30-glass.js does the same); the global is the jsdom/standalone
 * fallback.
 */
function wePickerDocument(ctx) {
  if (ctx && ctx.document && typeof ctx.document.createElement === 'function') {
    return ctx.document
  }
  const scope = typeof globalThis !== 'undefined' ? globalThis : null
  if (scope && scope.document && typeof scope.document.createElement === 'function') {
    return scope.document
  }
  return null
}

// --------------------------------------------------------------------------- //
// open / close state machine (owns store.pickerOpen — and nothing else)
// --------------------------------------------------------------------------- //

/** @returns {boolean} */
function wePickerIsOpen() {
  return weGetState().pickerOpen === true
}

/**
 * Open the modal: the store flag is the whole state. The mounted contribution
 * (`wePickerModal`) sees it through `weUseStore()` and renders the dialog. If the
 * library has never loaded, a plain `GET /library` is kicked off so the skeletons
 * that are about to appear have something behind them.
 *
 * @param {*} [ctx]
 * @returns {boolean} true when the store says open
 */
function wePickerOpen(ctx) {
  try {
    weSet({ pickerOpen: true })
  } catch (error) {
    return false
  }
  const state = weGetState()
  if (ctx && ctx.rest && !state.library) {
    void weLoadLibrary(ctx)
  }
  return wePickerIsOpen()
}

/**
 * Close the modal. Idempotent, which is what makes Esc + backdrop + the × button
 * safe to fire in any order (and twice). The dialog unmounts on the next render,
 * taking its effect-based Esc listener and its transient UI state with it.
 *
 * @returns {boolean} true when the store says closed
 */
function wePickerClose() {
  try {
    weSet({ pickerOpen: false })
  } catch (error) {
    // a store failure must not keep the modal on screen
  }
  return wePickerIsOpen() === false
}

/**
 * @param {*} [ctx]
 * @returns {boolean} the new open state
 */
function wePickerToggle(ctx) {
  if (wePickerIsOpen()) {
    wePickerClose()
    return false
  }
  return wePickerOpen(ctx)
}

/**
 * Full teardown for `ctx.onDispose` (T2.7). Closing the flag unmounts the dialog,
 * whose cleanup drops the Esc listener; the transient UI state dies with the
 * component, so there is nothing else to reset.
 *
 * @returns {boolean} always true (a dispose path must not throw)
 */
function wePickerDispose() {
  try {
    weSet({ pickerOpen: false })
  } catch (error) {
    // ignore — disposal is best-effort by definition
  }
  return true
}

/**
 * The live overlay element, for tests/diagnostics: `null` while closed. Read from
 * the document rather than kept in a module variable — React owns the node, and a
 * module-side copy would be one more thing to leak.
 *
 * @returns {HTMLElement|null}
 */
function wePickerRoot() {
  const doc = wePickerDocument(null)
  if (!doc || typeof doc.querySelector !== 'function') {
    return null
  }
  return doc.querySelector('[' + WE_PICKER_MARK_ATTR + ']')
}

// --------------------------------------------------------------------------- //
// actions
// --------------------------------------------------------------------------- //

/**
 * Select: highlight, apply, close (§8.4 last bullet).
 *
 * The apply is 00-core's `weSelectWallpaper(ctx, id)` — optimistic local config,
 * PUT, response config overwrites the optimistic value, `current` re-derived.
 * `pickerOpen` belongs to this file, which is why the close is here and not
 * there. Unplayable ids are rejected before any network call.
 *
 * @param {*} ctx
 * @param {string} id
 * @returns {boolean} true when the selection was accepted
 */
function wePickerSelect(ctx, id) {
  const state = weGetState()
  const item = weFindItem(state.library, id)
  if (!weIsPlayable(item)) {
    return false
  }
  weSelectWallpaper(ctx, id)
  wePickerClose()
  return true
}

/**
 * Rescan (§8.4 "刷新按钮 · 转圈态"). `weLoadLibrary(ctx, {refresh:true})` never
 * rejects, so the busy flag is cleared in the same continuation as the result.
 *
 * @param {*} ctx
 * @param {{get?: Function, patch?: Function}} [ctl] dialog controller; without it
 *   the rescan still runs, it just has no busy state to report
 * @returns {Promise<*>} the `weLoadLibrary` result
 */
function wePickerRefresh(ctx, ctl) {
  const control = ctl && typeof ctl.patch === 'function' ? ctl : null
  if (control && typeof control.get === 'function' && control.get().refreshing) {
    return Promise.resolve(null)
  }
  if (control) {
    control.patch({ refreshing: true })
  }

  return weLoadLibrary(ctx, { refresh: true }).then(
    function done(result) {
      if (control) {
        control.patch({ refreshing: false })
      }
      return result
    },
    function failed(error) {
      if (control) {
        control.patch({ refreshing: false })
      }
      return { ok: false, library: null, error: error }
    },
  )
}

/**
 * Manual library root (§8.4 / §9 "手动添加库根"): append to
 * `settings.extraLibraryRoots`, let the backend normalise the list, then force a
 * rescan so the new root's items show up without a second click.
 *
 * The whole array is sent (JSON Merge Patch replaces `extraLibraryRoots` whole,
 * see config.py `_normalize_roots`), built from the *current* config so a
 * concurrently added root is not dropped.
 *
 * @param {*} ctx
 * @param {{get?: Function, patch?: Function}} [ctl] dialog controller
 * @returns {Promise<*>}
 */
function wePickerAddRoot(ctx, ctl) {
  const control = ctl && typeof ctl.patch === 'function' ? ctl : null
  const ui = control && typeof control.get === 'function' ? control.get() : WE_PICKER_INITIAL_UI

  if (ui.rootBusy) {
    return Promise.resolve(null)
  }

  const raw = String(ui.rootInput || '').trim()
  if (!raw) {
    if (control) {
      control.patch({ rootError: '请输入绝对路径' })
    }
    return Promise.resolve(null)
  }

  const roots = wePickerRoots(weGetState())
  if (roots.indexOf(raw) !== -1) {
    if (control) {
      control.patch({ rootError: '该目录已在库根列表中' })
    }
    return Promise.resolve(null)
  }

  if (control) {
    control.patch({ rootBusy: true, rootError: '' })
  }

  return weSaveConfig(ctx, {
    settings: { extraLibraryRoots: roots.concat([raw]) },
  }).then(function afterSave(result) {
    if (!result || !result.ok) {
      if (control) {
        control.patch({
          rootBusy: false,
          rootError: weDescribeError(result ? result.error : null) || '保存库根失败',
        })
      }
      return result
    }
    if (control) {
      control.patch({
        rootBusy: false,
        rootForm: false,
        rootInput: '',
        rootError: '',
        rootNote: '已添加并重新扫描：' + raw,
      })
    }
    // The store subscription re-renders the grid when the scan lands; the old
    // imperative view had to be redrawn by hand here, React does not.
    return weLoadLibrary(ctx, { refresh: true })
  })
}

// --------------------------------------------------------------------------- //
// components (every element comes from wePickerH — no JSX)
// --------------------------------------------------------------------------- //

/**
 * Esc closes (§8.4). A React effect, so the document listener is bounded to the
 * dialog's mounted lifetime: added when the modal opens, removed by the cleanup
 * when it closes or when the contribution unmounts. Capture phase, so it wins
 * over app-level handlers.
 *
 * @param {*} ctx
 */
function wePickerUseEscape(ctx) {
  const react = wePickerReact()
  react.useEffect(
    function attachEscape() {
      const doc = wePickerDocument(ctx)
      if (!doc || typeof doc.addEventListener !== 'function') {
        return undefined
      }
      const onKeydown = function onKeydown(event) {
        if (!event) {
          return
        }
        const key = typeof event.key === 'string' ? event.key : ''
        const legacy = event.keyCode === 27 || event.which === 27
        if (key !== 'Escape' && key !== 'Esc' && !legacy) {
          return
        }
        if (typeof event.preventDefault === 'function') {
          event.preventDefault()
        }
        if (typeof event.stopPropagation === 'function') {
          event.stopPropagation()
        }
        wePickerClose()
      }
      doc.addEventListener('keydown', onKeydown, true)
      return function detachEscape() {
        doc.removeEventListener('keydown', onKeydown, true)
      }
    },
    [ctx],
  )
}

/**
 * The `appearance.extra` contribution (registered by T2.7).
 *
 * Renders nothing while the picker is closed; when `pickerOpen` flips it renders
 * `wePickerDialog`, which is where all transient state and the Esc effect live.
 * Mounting the dialog per open is what makes "close = throw the view state away"
 * free, and why no reset code exists in this file.
 *
 * @param {{ctx?: *}} props
 * @returns {*} React element or null
 */
function wePickerModal(props) {
  const state = weUseStore()
  const ctx = props && props.ctx ? props.ctx : null

  if (state.pickerOpen !== true) {
    return null
  }
  return wePickerH(wePickerDialog, { ctx: ctx, state: state })
}

/**
 * The modal itself. Owns the transient UI state (`useState`), the failed-preview
 * set and the Esc effect; everything it renders is a pure function of the store
 * snapshot it is handed plus that local state.
 *
 * @param {{ctx: *, state: *}} props
 * @returns {*} React element
 */
function wePickerDialog(props) {
  const react = wePickerReact()
  const ctx = props ? props.ctx : null
  const state = props ? props.state : null

  const [ui, setUi] = react.useState(WE_PICKER_INITIAL_UI)
  const [failedPreviews, setFailedPreviews] = react.useState(WE_PICKER_NO_FAILURES)

  // Latest committed UI state, for the in-flight guards: two clicks in one tick
  // would otherwise both read the previous render's `refreshing` and start two
  // rescans.
  const uiRef = react.useRef(ui)
  uiRef.current = ui

  const patch = react.useCallback(function patchUi(part) {
    setUi(function merge(prev) {
      return Object.assign({}, prev, part)
    })
  }, [])

  const failPreview = react.useCallback(function failPreviewById(id) {
    setFailedPreviews(function mark(prev) {
      return prev[id] ? prev : Object.assign({}, prev, { [id]: true })
    })
  }, [])

  const ctl = react.useMemo(
    function buildController() {
      return {
        get: function get() {
          return uiRef.current
        },
        patch: patch,
      }
    },
    [patch],
  )

  wePickerUseEscape(ctx)

  const snapshot = state || weGetState()
  const library = snapshot.library || null
  const items = library && Array.isArray(library.items) ? library.items : []
  const errors = library && Array.isArray(library.errors) ? library.errors : []
  const engineFound = !!(library && library.engineFound === true)
  const loading = ui.refreshing || !library
  const selectedId = wePickerSelectedId(snapshot)
  const shown = wePickerFilterItems(items, {
    query: ui.query,
    type: ui.typeFilter,
    rating: ui.ratingFilter,
  })
  const model = wePickerEmptyModel({ loading, engineFound, items, shown, errors })

  const handlers = {
    close: function close() {
      wePickerClose()
    },
    backdrop: function backdrop(event) {
      // the overlay itself, never the card
      if (event && event.target === event.currentTarget) {
        wePickerClose()
      }
    },
    search: function search(event) {
      patch({ query: event && typeof event.target.value === 'string' ? event.target.value : '' })
    },
    type: function type(value) {
      patch({ typeFilter: value })
    },
    rating: function rating(value) {
      patch({ ratingFilter: value })
    },
    refresh: function refresh() {
      void wePickerRefresh(ctx, ctl)
    },
    select: function select(id) {
      wePickerSelect(ctx, id)
    },
    addRoot: function addRoot() {
      patch({ rootForm: true, rootError: '' })
    },
    rootCancel: function rootCancel() {
      patch({ rootForm: false, rootError: '', rootNote: '' })
    },
    rootSubmit: function rootSubmit() {
      void wePickerAddRoot(ctx, ctl)
    },
    rootInput: function rootInput(event) {
      patch({ rootInput: event && typeof event.target.value === 'string' ? event.target.value : '' })
    },
  }

  const countText = loading
    ? '扫描中…'
    : '共 ' + items.length + ' 张 · 显示 ' + shown.length + ' 张'

  return wePickerH(
    'div',
    {
      className: 'we-picker-overlay',
      'data-we-picker': '',
      role: 'presentation',
      style: WE_PICKER_OVERLAY_STYLE,
      onClick: handlers.backdrop,
    },
    wePickerH('style', {
      id: WE_PICKER_STYLE_ID,
      dangerouslySetInnerHTML: { __html: WE_PICKER_STYLE },
    }),
    wePickerH(
      'section',
      {
        className: 'we-picker-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '壁纸库',
      },
      wePickerH(wePickerToolbar, {
        ui: ui,
        loading: loading,
        countText: countText,
        handlers: handlers,
      }),
      wePickerH(
        'div',
        { className: 'we-picker-body' },
        wePickerH(wePickerErrors, { errors: errors }),
        wePickerH(wePickerGrid, {
          loading: loading,
          shown: shown,
          state: snapshot,
          selectedId: selectedId,
          failedPreviews: failedPreviews,
          onFail: failPreview,
          onSelect: handlers.select,
        }),
        wePickerH(wePickerEmpty, {
          model: model,
          ui: ui,
          roots: wePickerRoots(snapshot),
          handlers: handlers,
        }),
      ),
    ),
  )
}

/**
 * Top bar (§8.4). Tabs are real buttons; `aria-pressed` and `data-we-picker-active`
 * carry the same truth so a screen reader and a test agree.
 *
 * @param {{ui: *, loading: boolean, countText: string, handlers: *}} props
 * @returns {*} React element
 */
function wePickerToolbar(props) {
  const ui = props.ui
  const handlers = props.handlers

  return wePickerH(
    'header',
    { className: 'we-picker-bar' },
    wePickerH('input', {
      className: 'we-picker-search',
      type: 'search',
      placeholder: '搜索标题或 Workshop ID',
      'aria-label': '搜索壁纸',
      'data-we-picker-search': '',
      value: ui.query,
      // `onInput`, not `onChange`: React 19's ChangeEventPlugin does not deliver
      // `onChange` under the test renderer's jsdom (verified against 19.2.7 — the
      // value tracker never reports a change), and `input` is the native event
      // `onChange` is built on, so every keystroke is reported either way.
      onInput: handlers.search,
    }),
    wePickerH(
      'div',
      { className: 'we-picker-tabs', 'data-we-picker-types': '' },
      WE_PICKER_TYPE_CHOICES.map(function typeTab(choice) {
        return wePickerH(wePickerTab, {
          key: 'type-' + choice.value,
          choice: 'type',
          value: choice.value,
          label: choice.label,
          active: ui.typeFilter === choice.value,
          onPick: handlers.type,
        })
      }),
    ),
    wePickerH(
      'div',
      { className: 'we-picker-tabs', 'data-we-picker-ratings': '' },
      WE_PICKER_RATING_CHOICES.map(function ratingTab(choice) {
        return wePickerH(wePickerTab, {
          key: 'rating-' + choice.value,
          choice: 'rating',
          value: choice.value,
          label: choice.label,
          active: ui.ratingFilter === choice.value,
          onPick: handlers.rating,
        })
      }),
    ),
    wePickerH(
      'button',
      {
        className: 'we-picker-btn',
        type: 'button',
        'data-we-picker-refresh': '',
        disabled: props.loading,
        onClick: handlers.refresh,
      },
      props.loading ? '刷新中…' : '刷新',
    ),
    wePickerH('span', { className: 'we-picker-count', 'data-we-picker-count': '' }, props.countText),
    wePickerH(
      'button',
      {
        className: 'we-picker-close',
        type: 'button',
        'aria-label': '关闭',
        'data-we-picker-close': '',
        onClick: handlers.close,
      },
      '×',
    ),
  )
}

/**
 * One filter tab.
 *
 * @param {{choice: string, value: string, label: string, active: boolean, onPick: Function}} props
 * @returns {*} React element
 */
function wePickerTab(props) {
  return wePickerH(
    'button',
    {
      className: props.active ? 'we-picker-tab is-active' : 'we-picker-tab',
      type: 'button',
      'data-we-picker-choice': props.choice,
      'data-we-picker-value': props.value,
      'data-we-picker-active': props.active ? '1' : '0',
      'aria-pressed': props.active ? 'true' : 'false',
      onClick: function pick() {
        props.onPick(props.value)
      },
    },
    props.label,
  )
}

/**
 * Error list (§9: a bad library root or a broken project.json must be named, not
 * swallowed).
 *
 * @param {{errors: Array<*>}} props
 * @returns {*} React element
 */
function wePickerErrors(props) {
  const texts = (Array.isArray(props.errors) ? props.errors : [])
    .map(wePickerErrorText)
    .filter(function keep(text) {
      return !!text
    })

  return wePickerH(
    'div',
    { className: 'we-picker-errors', 'data-we-picker-errors': '', hidden: texts.length === 0 },
    texts.length === 0 ? null : wePickerH('strong', null, '扫描出错（' + texts.length + '）'),
    texts.length === 0
      ? null
      : wePickerH(
          'ul',
          null,
          texts.map(function item(text, index) {
            return wePickerH('li', { key: 'error-' + index }, text)
          }),
        ),
  )
}

/**
 * Grid: twelve skeletons while the library is unknown, one cell per visible item
 * afterwards. React reconciles by `key`, so a search keystroke no longer rebuilds
 * every thumbnail (the old signature compare existed only to avoid that).
 *
 * @param {{loading: boolean, shown: Array<*>, state: *, selectedId: string,
 *          failedPreviews: Object, onFail: Function, onSelect: Function}} props
 * @returns {*} React element
 */
function wePickerGrid(props) {
  const children = props.loading
    ? Array.from({ length: WE_PICKER_SKELETON_COUNT }, function skeleton(value, index) {
        return wePickerH('div', {
          key: 'skeleton-' + index,
          className: 'we-picker-skeleton',
          'data-we-picker-skeleton': String(index),
        })
      })
    : props.shown.map(function cell(item, index) {
        const id = item && item.id !== null && item.id !== undefined ? String(item.id) : ''
        return wePickerH(wePickerCell, {
          key: id || 'cell-' + index,
          item: item,
          state: props.state,
          selectedId: props.selectedId,
          failedPreviews: props.failedPreviews,
          onFail: props.onFail,
          onSelect: props.onSelect,
        })
      })

  return wePickerH('div', { className: 'we-picker-grid', 'data-we-picker-grid': '' }, children)
}

/**
 * Thumbnail: `<img>` when the item has a preview, otherwise the schemeColor block
 * plus a kind glyph. A failed load flips the block in through `onError`, so a
 * `file:///` preview the renderer refuses degrades instead of showing a broken
 * image icon. The failure is remembered per id in dialog state, which is what
 * keeps the icon from flickering back to a dead image on the next re-render.
 *
 * @param {{item: *, state: *, failed: boolean, onFail: Function}} props
 * @returns {*} React element
 */
function wePickerThumb(props) {
  const item = props.item
  const scheme = item && typeof item.schemeColor === 'string' ? item.schemeColor.trim() : ''
  const kind = item && typeof item.kind === 'string' ? item.kind : 'unknown'
  const id = item && item.id !== null && item.id !== undefined ? String(item.id) : ''
  const url = wePickerPreviewUrl(props.state, item)

  return wePickerH(
    'span',
    {
      className: 'we-picker-thumb',
      'data-we-picker-thumb': url ? 'preview' : 'scheme',
      style: { backgroundColor: scheme || WE_PICKER_THUMB_FALLBACK },
    },
    url && !props.failed
      ? wePickerH('img', {
          alt: '',
          loading: 'lazy',
          'data-we-picker-preview': '1',
          src: url,
          onError: function previewFailed() {
            props.onFail(id)
          },
        })
      : wePickerH('span', { className: 'we-picker-icon' }, wePickerKindIcon(kind)),
  )
}

/**
 * One grid cell. `application`/`unknown` get `disabled` **and**
 * `data-we-picker-playable="0"`: `disabled` is what stops the browser from
 * focusing or activating the button, the attribute is what the click handler
 * re-checks — `dispatchEvent` (jsdom, tests, synthetic clicks) ignores `disabled`,
 * so both guards are required (§8.4).
 *
 * @param {{item: *, state: *, selectedId: string, failedPreviews: Object,
 *          onFail: Function, onSelect: Function}} props
 * @returns {*} React element
 */
function wePickerCell(props) {
  const item = props.item
  const playable = weIsPlayable(item)
  const id = item && item.id !== null && item.id !== undefined ? String(item.id) : ''
  const kind = item && typeof item.kind === 'string' ? item.kind : 'unknown'
  const title = item && typeof item.title === 'string' && item.title ? item.title : '（未命名）'
  const selected = !!id && id === props.selectedId

  let className = 'we-picker-cell'
  if (selected) {
    className += ' is-selected'
  }
  if (!playable) {
    className += ' is-disabled'
  }

  return wePickerH(
    'button',
    {
      className: className,
      type: 'button',
      title: playable ? title : title + ' · ' + wePickerKindLabel(kind) + '类型不能作为壁纸播放',
      'data-we-picker-id': id,
      'data-we-picker-kind': kind,
      'data-we-picker-playable': playable ? '1' : '0',
      'data-we-picker-selected': selected ? '1' : undefined,
      'aria-current': selected ? 'true' : undefined,
      'aria-disabled': playable ? undefined : 'true',
      disabled: !playable,
      onClick: function pick() {
        // The real gate: `disabled` is ignored by dispatchEvent, so the handler
        // checks playability too.
        if (!playable) {
          return
        }
        props.onSelect(id)
      },
    },
    wePickerH(wePickerThumb, {
      item: item,
      state: props.state,
      failed: !!(props.failedPreviews && props.failedPreviews[id]),
      onFail: props.onFail,
    }),
    wePickerH(
      'span',
      { className: 'we-picker-meta' },
      wePickerH('span', { className: 'we-picker-title' }, title),
      wePickerH('span', { className: 'we-picker-badge' }, wePickerKindLabel(kind)),
    ),
  )
}

/**
 * Empty state / manual-root form (§8.4 / §9). `hidden` stays on the container so
 * the node is always present and the grid keeps its place.
 *
 * @param {{model: *, ui: *, roots: Array<string>, handlers: *}} props
 * @returns {*} React element
 */
function wePickerEmpty(props) {
  const model = props.model
  const ui = props.ui
  const roots = props.roots
  const handlers = props.handlers
  const children = []

  if (model) {
    children.push(
      wePickerH('div', { key: 'empty-title', className: 'we-picker-empty-title' }, model.title),
      wePickerH('div', { key: 'empty-detail', className: 'we-picker-empty-detail' }, model.detail),
    )

    if (model.guide && !ui.rootForm) {
      children.push(
        wePickerH(
          'button',
          {
            key: 'empty-add-root',
            className: 'we-picker-btn',
            type: 'button',
            'data-we-picker-add-root': '',
            onClick: handlers.addRoot,
          },
          '手动添加库根',
        ),
      )
    } else if (model.guide) {
      children.push(
        wePickerH(
          'div',
          { key: 'empty-form', className: 'we-picker-form' },
          wePickerH('input', {
            className: 'we-picker-root-input',
            type: 'text',
            'data-we-picker-root-input': '',
            'aria-label': '壁纸库根目录',
            placeholder: '例如 D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine',
            value: ui.rootInput,
            onInput: handlers.rootInput,
          }),
          wePickerH(
            'button',
            {
              className: 'we-picker-btn',
              type: 'button',
              'data-we-picker-root-submit': '',
              disabled: ui.rootBusy,
              onClick: handlers.rootSubmit,
            },
            ui.rootBusy ? '添加中…' : '添加并重扫',
          ),
          wePickerH(
            'button',
            {
              className: 'we-picker-btn',
              type: 'button',
              'data-we-picker-root-cancel': '',
              onClick: handlers.rootCancel,
            },
            '取消',
          ),
        ),
      )

      if (ui.rootError) {
        children.push(
          wePickerH('div', { key: 'empty-error', className: 'we-picker-note is-error' }, ui.rootError),
        )
      } else if (ui.rootNote) {
        children.push(
          wePickerH('div', { key: 'empty-note', className: 'we-picker-note' }, ui.rootNote),
        )
      }

      children.push(
        wePickerH(
          'div',
          { key: 'empty-roots', className: 'we-picker-note' },
          roots.length > 0 ? '已有手动库根：' + roots.join('、') : '尚未添加手动库根',
        ),
      )
    }
  }

  return wePickerH(
    'div',
    {
      className: 'we-picker-empty',
      'data-we-picker-empty': '',
      'data-we-picker-empty-kind': model ? model.kind : undefined,
      hidden: !model,
    },
    children,
  )
}
