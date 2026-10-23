/**
 * MOD-010 — the `appearance.extra` appearance panel (T2.5).
 *
 * One React tree for every control in design §8.4, rows in the order the table
 * prints them. It is a *view over the store plus a PUT button*, nothing more:
 *
 *   - it reads `config.settings` through `weUseStore()` (00-core),
 *   - it writes through `weSaveConfig(ctx, {settings})` (00-core), so the PUT
 *     response's `config` replaces the local document wholesale (§6.3 / T13),
 *   - for the two seams it calls `weGlassApply`/`weGlassRefresh` (30-glass) and
 *     `weLayerSync` (10-layer) — **never** the DOM they own (MOD-010 boundary:
 *     the panel asks for behaviour, the owning module touches its own furniture).
 *
 * ## Why this file has no `import`
 *
 * `desktop/build.py` rule 1 makes `00-core.js` the only file allowed to import,
 * so a second `react` binding is a build failure. The host installs the app's
 * React *singleton* as `globalThis.__HERMES_REACT__` before any plugin evaluates
 * (`apps/desktop/src/sdk/runtime.ts`: `installPluginSdk()` /
 * `pluginNamespaces()`), which is exactly the object the loader's `react` shim
 * re-exports. `wePanelReact()` resolves that global, so the panel shares the
 * app's React instance (a second copy would break hooks) with **no** import and
 * **no** build rule violation.
 *
 * ## Why not JSX
 *
 * JSX needs a transform. `build.py` concatenates bytes and the runtime loader
 * (`contrib/runtime-loader.ts`) only rewrites bare specifiers — it never
 * transforms. Untransformed JSX in `plugin.js` would fail T12 (`node --check`)
 * and then fail to parse at load. So every element here comes from
 * `wePanelH(...)`, a thin `React.createElement` facade.
 *
 * ## Slider semantics (§8.4: "每个滑杆在 pointerup 时 PUT")
 *
 * Dragging does **two** local things and **zero** requests:
 *   1. `dragRef`/`draft` — the local value the thumb shows,
 *   2. an optimistic store write (`weApplyConfig`) — that is how the preview
 *      becomes visible, because the only sanctioned path from a parameter to the
 *      DOM is store → glass/layer subscription. Writing the token directly from
 *      here would cross the MOD-010 boundary.
 * On `pointerup` (and `keyup`/`blur`, for keyboard and tab-away) exactly one PUT
 * fires, carrying **only** that field. A failed PUT restores the document that
 * was confirmed before the drag, so the panel never keeps showing a value the
 * backend rejected.
 *
 * ## scrim units (the trap)
 *
 * `dashboard/config.py` `_NUMERIC_RANGES` says `scrim: (0.0, 0.9)` — the wire
 * value is a **fraction**. §8.4's label "暗膜 0–90 %" is display semantics. So
 * the slider is an integer 0…90 (`WE_PANEL_SLIDERS.scrim`) and every read/write
 * goes through `wePanelSliderDisplay` (×100) / `wePanelSliderWire` (÷100). This
 * is the only field in the table whose display and wire spaces differ.
 *
 * ## Everything else that is easy to get wrong
 *
 *   - `cardBase`'s floor is 0 (`min=0` here, `(0, 100)` in config.py, and
 *     30-glass renders 0 as `rgba(base, 0)` — a fully transparent card).
 *   - `rotation` is replaced **whole** by the backend (§6.3), so every rotation
 *     write sends `{enabled, intervalMinutes, shuffle}` with `shuffle` preserved
 *     even though §8.4 only exposes a switch and an interval.
 *   - Scene-only controls grey out when the library holds no playable `scene`
 *     item (`sceneLive`, `sceneLiveFps`).
 *   - `enabled: false` greys **and disables** every settings control but keeps
 *     them visible; the library button, rescan and diagnostics stay live because
 *     they are how you fix a disabled panel.
 *   - Transient UI state (`draft`, `rescanning`, `diag`) lives in React
 *     `useState`, never in the eight-field store (§5.4).
 *   - No timer of any kind (F22 / T10c): the spinner is a promise, the
 *     appearance panel has nothing to schedule.
 *   - The whole body is wrapped in a React error boundary class (§8.4), and every
 *     call into a neighbour module is guarded — a broken seam shows an inline
 *     message instead of a dead Appearance page.
 *
 * Symbols are `we`-prefixed and reach their neighbours through the concatenated
 * module's shared scope (build.py rule 5). No `export`: 99-register.js owns the
 * single `export default` and mounts `weAppearanceExtra(ctx)`.
 */

// --------------------------------------------------------------------------- //
// constants
// --------------------------------------------------------------------------- //

/**
 * The DOM marker every part of the tree carries, plus the seam it was mounted
 * through. data-we-area used to be the contribution area, but the panel moved
 * from appearance.extra to panes (see 99-register.js WE_REG_PANEL_AREA for
 * why: the Appearance page's top level is unreachable through normal
 * navigation). Keeping the string here — rather than importing the register
 * file's constant — keeps 40-panel free of wiring knowledge; the value is now
 * informational only, so a test may assert the mark without pinning the area.
 *
 * NOTE: no backticks in this comment. tests/frontend/99-register.test.mjs
 * evaluates the concatenated sources inside a TEMPLATE LITERAL, so a ` here
 * would terminate it and every suite would die with a SyntaxError.
 */
const WE_PANEL_AREA = 'panes'

/** The DOM marker every part of the tree carries. Short and stable so a test (or
 *  a human with DevTools) can find the panel without knowing the area string;
 *  `data-we-area` carries the contribution seam next to it. */
const WE_PANEL_MARK = 'appearance'

/** `settings.sceneLiveFps` legal values (config.py `_NUMERIC_RANGES` has no
 *  entry for it; the enum lives in `normalize_settings`' nearest-value rule). */
const WE_PANEL_SCENE_FPS = Object.freeze([15, 30, 60])

/** §8.4 填充方式 — wire value first, label second. */
const WE_PANEL_OBJECT_FITS = Object.freeze([
  Object.freeze({ value: 'cover', label: '铺满' }),
  Object.freeze({ value: 'contain', label: '完整' }),
  Object.freeze({ value: 'fill', label: '拉伸' }),
])

/** §8.4 转场 — wire value first, label second. */
const WE_PANEL_TRANSITIONS = Object.freeze([
  Object.freeze({ value: 'fade', label: '淡入' }),
  Object.freeze({ value: 'cut', label: '直切' }),
])

/**
 * The slider table, §8.4 row by row. `min`/`max` are the **display** bounds and
 * are copied from `dashboard/config.py` `_NUMERIC_RANGES` — except `scrim`,
 * whose wire range is 0…0.9 and whose display range is 0…90 (`wire: 'fraction'`
 * is what turns one into the other). The renderer does not own a clamp table
 * (§6.3); these numbers exist so the control cannot *offer* an illegal value.
 *
 * @typedef {Object} WePanelSlider
 * @property {string} field  settings key (real name, from config.py)
 * @property {string} label  §8.4 row label
 * @property {number} min    display-space minimum
 * @property {number} max    display-space maximum
 * @property {string} unit   suffix for the value read-out
 * @property {string} [wire] 'fraction' when the wire value is display/100
 * @type {ReadonlyArray<WePanelSlider>}
 */
const WE_PANEL_SLIDERS = Object.freeze([
  Object.freeze({ field: 'panelBase', label: '外壳浓度', min: 0, max: 100, unit: '' }),
  Object.freeze({ field: 'cardBase', label: '卡片玻璃', min: 0, max: 100, unit: '' }),
  Object.freeze({ field: 'overlayBase', label: '浮层透明度', min: 0, max: 100, unit: '' }),
  Object.freeze({ field: 'wallpaperBlur', label: '壁纸模糊', min: 0, max: 40, unit: 'px' }),
  Object.freeze({ field: 'brightness', label: '亮度', min: 0, max: 200, unit: '%' }),
  Object.freeze({ field: 'contrast', label: '对比度', min: 0, max: 200, unit: '%' }),
  Object.freeze({ field: 'saturate', label: '饱和度', min: 0, max: 200, unit: '%' }),
  Object.freeze({ field: 'wallpaperOpacity', label: '壁纸不透明度', min: 0, max: 100, unit: '' }),
  Object.freeze({ field: 'scrim', label: '暗膜', min: 0, max: 90, unit: '%', wire: 'fraction' }),
])

/** §5.1 kind → 徽标文字. `application`/`unknown` are listed but not playable. */
const WE_PANEL_KIND_LABELS = Object.freeze({
  video: '视频',
  image: '图片',
  web: '网页',
  scene: '场景',
  application: '应用',
  unknown: '未知',
})

/** `rotation.intervalMinutes` bounds: one minute to a day. The backend has no
 *  range entry for it (only an int type check), so this is UI sanity, and the
 *  response's `config` is still the truth. */
const WE_PANEL_INTERVAL_MIN = 1
const WE_PANEL_INTERVAL_MAX = 1440

/** Row/label styling. Inline, because the panel cannot import the SDK's UI
 *  primitives (build.py rule 1) and must not inject a stylesheet into a page
 *  10-layer/30-glass already decorate. */
/**
 * One control row: label | control | extra (a unit suffix, a hint, a button).
 *
 * `gridTemplateColumns` used to be `10rem 1fr auto`, sized for the Appearance
 * page's full width. In a 22rem pane minus the section's own 0.875rem padding on
 * both sides that left the slider column ~4rem — cramped, and a long label
 * ("壁纸不透明度") plus a 5rem slider overflowed into a horizontal scrollbar.
 * `minmax(0, 10rem)` lets the label column SHRINK below 10rem when the pane is
 * narrow (and wrap its text), while `1fr` with `minWidth: 0` on the children
 * keeps the control from forcing the grid wider than the pane.
 */
const WE_PANEL_ROW_STYLE = Object.freeze({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 10rem) minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '0.5rem 0.75rem',
  minHeight: '2rem',
})

const WE_PANEL_LABEL_STYLE = Object.freeze({
  fontSize: '0.8125rem',
  opacity: 0.85,
})

/**
 * Root box. Originally written for a `section` INSIDE the Appearance settings
 * page, which already had its own padding — so this carried no horizontal
 * padding at all and a `borderTop` rule to separate it from the rows above.
 *
 * The panel now lives in the `panes` area (see 99-register.js
 * WE_REG_PANEL_AREA), and a pane is a bare container: no padding, no inset. So
 * the horizontal padding has to live HERE, and the divider is meaningless (there
 * is nothing above it to divide from) — it read as a stray line under the pane
 * title. `0.875rem` matches the app's own card inset so the panel reads as a
 * card rather than text glued to the pane edge.
 */
const WE_PANEL_SECTION_STYLE = Object.freeze({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.875rem',
  transition: 'opacity 120ms ease',
  // Long labels ("壁纸不透明度") plus a 5rem slider must not force a horizontal
  // scrollbar in a 22rem pane.
  minWidth: 0,
  boxSizing: 'border-box',
})

/**
 * The pane card the settings sit on.
 *
 * Same material as the chat composer (`--composer-fill` + a 16px backdrop
 * blur), at roughly half strength: the composer is a 39px strip and can afford
 * 88% opacity, but a full-pane card at that strength would bury the wallpaper
 * this plugin exists to show. `margin` + `min-height` make it read as a card
 * inset from the pane edges — the chat column's own card geometry — instead of
 * a full-bleed slab.
 *
 * `--composer-fill` is a host token; the `#0d1117` fallback keeps the card
 * visible if a future host drops it.
 */
const WE_PANEL_CARD_STYLE = Object.freeze({
  background: 'color-mix(in srgb, var(--composer-fill, #0d1117) var(--we-card-pct, 55%), transparent)',
  backdropFilter: 'blur(var(--we-card-blur, 16px)) saturate(1.05)',
  WebkitBackdropFilter: 'blur(var(--we-card-blur, 16px)) saturate(1.05)',
  borderRadius: '0.875rem',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  margin: '0.75rem 0.75rem 1rem',
  minHeight: 'calc(100% - 2rem)',
  padding: '1rem 1rem 1.25rem',
  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.32)',
  boxSizing: 'border-box',
})

/**
 * The `界面卡片化` OFF variant: no inset card anywhere — the panel included.
 * Without this the switch looked dead while the user stood in the panel that
 * owned it (2026-10-22 report: "界面卡片化选项不起效果"), because this style was
 * a frozen literal while the chat/page cards were gated by `data-we-card`.
 */
const WE_PANEL_FLAT_STYLE = Object.freeze({
  background: 'transparent',
  borderRadius: '0',
  border: 'none',
  margin: '0',
  minHeight: '100%',
  padding: '1rem 1rem 1.25rem',
  boxSizing: 'border-box',
})

/**
 * Which surface the panel wears: the inset glass card, or the flat full-bleed
 * page the host shows when cards are off.
 *
 * @param {Object|null} settings
 * @returns {Object}
 */
function wePanelSurfaceStyle(settings) {
  return settings && settings.uiCards === false ? WE_PANEL_FLAT_STYLE : WE_PANEL_CARD_STYLE
}

const WE_PANEL_HEADING_STYLE = Object.freeze({
  fontSize: '0.8125rem',
  fontWeight: 600,
  letterSpacing: '0.02em',
  opacity: 0.75,
})

const WE_PANEL_HINT_STYLE = Object.freeze({
  fontSize: '0.75rem',
  opacity: 0.65,
  margin: 0,
})

const WE_PANEL_BADGE_STYLE = Object.freeze({
  fontSize: '0.6875rem',
  padding: '0.05rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid rgba(127, 127, 127, 0.45)',
  whiteSpace: 'nowrap',
})

const WE_PANEL_THUMB_STYLE = Object.freeze({
  width: '4.5rem',
  height: '2.5rem',
  borderRadius: '0.25rem',
  objectFit: 'cover',
  background: 'rgba(127, 127, 127, 0.25)',
  flex: '0 0 auto',
})

const WE_PANEL_DIAG_STYLE = Object.freeze({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.6875rem',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  margin: '0.25rem 0 0',
  opacity: 0.8,
})

/** `boot` values used by this file (mirror of 00-core's WE_BOOT). */
const WE_PANEL_BOOT_ERROR = 'error'

// --------------------------------------------------------------------------- //
// React access (no import — see the header)
// --------------------------------------------------------------------------- //

/**
 * The app's React singleton, installed by the host before plugins evaluate.
 *
 * Throwing here is deliberate and safe: the only callers are the panel body and
 * the boundary factory, both of which render inside the boundary, so a host
 * without the global degrades to an inline error message instead of a blank
 * contribution.
 *
 * @returns {Object} the React namespace (`createElement`, `useState`, …)
 */
function wePanelReact() {
  const host = typeof globalThis === 'undefined' ? null : globalThis
  const react = host && host.__HERMES_REACT__ ? host.__HERMES_REACT__ : null
  if (!react || typeof react.createElement !== 'function') {
    throw new Error('React 运行时不可用：宿主未注册 globalThis.__HERMES_REACT__')
  }
  return react
}

/**
 * `React.createElement` with the rest-argument form, so a row can be written as
 * one expression per line without an array wrapper.
 *
 * @param {*} type
 * @param {Object|null} props
 * @returns {*} React element
 */
function wePanelH(type, props) {
  const react = wePanelReact()
  const children = Array.prototype.slice.call(arguments, 2)
  const args = [type, props === undefined ? null : props].concat(children)
  return react.createElement.apply(react, args)
}

// --------------------------------------------------------------------------- //
// pure helpers over the store / settings
// --------------------------------------------------------------------------- //

/**
 * `config.settings`, or `{}` when the first `GET /config` has not landed. A
 * panel that throws before its config arrives would blank the Appearance page.
 *
 * @param {*} state
 * @returns {Object}
 */
function wePanelSettings(state) {
  const snapshot = state || (typeof weGetState === 'function' ? weGetState() : null)
  const settings = snapshot && snapshot.config ? snapshot.config.settings : null
  return settings && typeof settings === 'object' ? settings : {}
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function wePanelNumber(value, fallback) {
  if (typeof value === 'number' && isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

/**
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function wePanelClampInt(value, min, max, fallback) {
  const number = wePanelNumber(value, fallback)
  return Math.round(Math.min(max, Math.max(min, number)))
}

/**
 * The slider descriptor for a settings field, or null when the field is not one
 * of §8.4's sliders.
 *
 * @param {string} field
 * @returns {WePanelSlider|null}
 */
function wePanelSliderSpec(field) {
  for (const spec of WE_PANEL_SLIDERS) {
    if (spec.field === field) {
      return spec
    }
  }
  return null
}

/**
 * Display-space value for a slider (integer, inside the descriptor's bounds).
 * `scrim` 0.25 → 25.
 *
 * @param {string} field
 * @param {Object} settings
 * @returns {number}
 */
function wePanelSliderDisplay(field, settings) {
  const spec = wePanelSliderSpec(field)
  const source = settings && typeof settings === 'object' ? settings : {}
  if (!spec) {
    return 0
  }
  const raw = wePanelNumber(source[field], spec.min)
  const display = spec.wire === 'fraction' ? raw * 100 : raw
  return Math.round(Math.min(spec.max, Math.max(spec.min, display)))
}

/**
 * Wire-space value for a slider — what goes into the PUT body. Every field but
 * `scrim` is identity; `scrim` becomes the 0…0.9 fraction `config.py` clamps.
 *
 * @param {string} field
 * @param {*} display display-space value (string from an input is accepted)
 * @returns {number}
 */
function wePanelSliderWire(field, display) {
  const spec = wePanelSliderSpec(field)
  if (!spec) {
    return wePanelNumber(display, 0)
  }
  const value = wePanelClampInt(display, spec.min, spec.max, spec.min)
  if (spec.wire === 'fraction') {
    // Two decimals is exactly the slider's 1 % step; keeping the arithmetic here
    // means no caller ever sees 0.25000000000000006 on the wire.
    return Math.round((value / 100) * 100) / 100
  }
  return value
}

/**
 * Does `settings` describe a state where the layer should be live? Mirrors
 * 30-glass's own rule (`enabled !== false`) so the panel and the engine never
 * disagree about what "off" means.
 *
 * @param {Object} settings
 * @returns {boolean}
 */
function wePanelEnabled(settings) {
  return !(settings && settings.enabled === false)
}

/**
 * Is there a playable `scene` wallpaper to drive? §8.4: "无场景壁纸时置灰".
 *
 * @param {*} state
 * @returns {boolean}
 */
function wePanelHasScene(state) {
  const snapshot = state || (typeof weGetState === 'function' ? weGetState() : null)
  const library = snapshot && snapshot.library ? snapshot.library : null
  const items = library && Array.isArray(library.items) ? library.items : []
  for (const item of items) {
    if (item && item.kind === 'scene' && (typeof weIsPlayable !== 'function' || weIsPlayable(item))) {
      return true
    }
  }
  return false
}

/**
 * @param {*} kind
 * @returns {string}
 */
function wePanelKindLabel(kind) {
  return Object.prototype.hasOwnProperty.call(WE_PANEL_KIND_LABELS, kind) ? WE_PANEL_KIND_LABELS[kind] : '未知'
}

/**
 * Preview thumbnail URL for the current-wallpaper row.
 *
 * `WallpaperItem.preview` is an absolute filesystem path and the media server has
 * no preview route yet, so the `file:///` translation already implemented for the
 * layer's fallback branch (10-layer.js `weLayerPreviewUrl`) is reused rather than
 * re-derived here — one token/path rule in the product, not two. It is a pure
 * function; nothing in 10-layer's DOM is touched.
 *
 * @param {*} state
 * @param {*} item
 * @returns {string} '' when there is nothing to show (caller paints schemeColor)
 */
function wePanelPreviewUrl(state, item) {
  if (typeof weLayerPreviewUrl === 'function') {
    try {
      return weLayerPreviewUrl(state, item) || ''
    } catch (error) {
      return ''
    }
  }
  const raw = item && typeof item.preview === 'string' ? item.preview.trim() : ''
  if (!raw) {
    return ''
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw
  }
  return ''
}

/**
 * Which legal `sceneLiveFps` value a settings object is closest to. The backend
 * snaps to the nearest legal value with ties going lower (config.py), so a
 * hand-edited 45 shows as 30 here too.
 *
 * @param {Object} settings
 * @returns {number}
 */
function wePanelSceneFps(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const raw = wePanelNumber(source.sceneLiveFps, WE_PANEL_SCENE_FPS[0])
  let best = WE_PANEL_SCENE_FPS[0]
  let bestDistance = Infinity
  for (const candidate of WE_PANEL_SCENE_FPS) {
    const distance = Math.abs(candidate - raw)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * `settings.rotation` with every key present (defaults from config.py).
 *
 * @param {Object} settings
 * @returns {{enabled: boolean, intervalMinutes: number, shuffle: boolean}}
 */
function wePanelRotation(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const raw = source.rotation && typeof source.rotation === 'object' ? source.rotation : {}
  return {
    enabled: raw.enabled === true,
    intervalMinutes: wePanelClampInt(raw.intervalMinutes, WE_PANEL_INTERVAL_MIN, WE_PANEL_INTERVAL_MAX, 10),
    shuffle: raw.shuffle === true,
  }
}

// --------------------------------------------------------------------------- //
// store mutation helpers (optimistic → PUT → response wins)
// --------------------------------------------------------------------------- //

/**
 * Merge a `settings` patch into a ConfigDoc without touching anything else.
 * `rotation` is merged one level deeper because the panel sends sub-fields of it
 * while the *backend* replaces the object whole — the optimistic copy must not
 * drop `shuffle` when the user flips only `enabled`.
 *
 * @param {*} config
 * @param {Object} patch settings-level patch
 * @returns {Object|null} a new ConfigDoc, or null when there is nothing to merge
 */
function wePanelApplyOptimistic(config, patch) {
  if (!config || typeof config !== 'object' || !config.settings || typeof config.settings !== 'object') {
    return null
  }
  const settings = Object.assign({}, config.settings)
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (key === 'rotation' && value && typeof value === 'object' && settings.rotation && typeof settings.rotation === 'object') {
      settings.rotation = Object.assign({}, settings.rotation, value)
      continue
    }
    settings[key] = value
  }
  return Object.assign({}, config, { settings })
}

/**
 * Push the current `config.settings` through the glass engine (30-glass).
 *
 * This is the panel's only handle on the seams: `weGlassApply(ctx, settings)`
 * computes and writes the token overrides itself. Calling it from here is what
 * makes a drag preview *visible* even before `weGlassStart` has subscribed (a
 * panel can be mounted first), and it is a no-op write when the values did not
 * change. Exceptions are swallowed — a broken seam must not take the settings
 * page with it (§5.4).
 *
 * @param {*} ctx
 * @param {Object} [settings] defaults to the store's
 * @returns {boolean} whether the call reached the engine
 */
function wePanelApplyGlass(ctx, settings) {
  if (typeof weGlassApply !== 'function') {
    return false
  }
  try {
    const source = settings || (typeof weGlassSettings === 'function' ? weGlassSettings() : null)
    weGlassApply(ctx, source || undefined)
    return true
  } catch (error) {
    return false
  }
}

/**
 * The one place the panel writes: PUT one settings patch, and let the response's
 * `config` replace the local document (T13 — the optimistic value is only ever a
 * bridge; `weSaveConfig` overwrites it with what the backend accepted, clamping
 * included).
 *
 * On failure the document that was confirmed before the edit is put back, so a
 * rejected value does not linger on screen as if it had been saved.
 *
 * @param {*} ctx
 * @param {Object} settingsPatch settings-level merge patch
 * @param {Object|null} revertConfig the confirmed document to restore on failure
 * @returns {Promise<{ok: boolean, config: *, clamped: *, error: *}>}
 */
function wePanelSave(ctx, settingsPatch, revertConfig) {
  const put = { settings: settingsPatch }
  return Promise.resolve()
    .then(function send() {
      return weSaveConfig(ctx, put)
    })
    .then(
      function onSaved(result) {
        if (!result || result.ok !== true) {
          if (revertConfig) {
            weApplyConfig(revertConfig)
          }
          wePanelApplyGlass(ctx)
          return result || { ok: false, config: null, clamped: null, error: new Error('PUT /config 无响应') }
        }
        // The store now holds the *response* document; make the seams agree with
        // it rather than with the value the drag was showing.
        wePanelApplyGlass(ctx)
        return result
      },
      function onThrown(error) {
        // weSaveConfig never rejects; belt and braces so a stub cannot reach React.
        if (revertConfig) {
          weApplyConfig(revertConfig)
        }
        wePanelApplyGlass(ctx)
        weSet({ toast: weFailureToast('设置保存失败', error) })
        return { ok: false, config: null, clamped: null, error }
      },
    )
}

/**
 * Nudge the two seam owners after `settings.enabled` changed.
 *
 * Both modules already follow the store on their own (`weGlassStart` subscribes
 * via `weGlassAutoApply`, `weLayerMount` subscribes to `weLayerSync`), so this is
 * not the only path — it is the path that also works *before* those engines are
 * started (a panel mounted ahead of them) and it is idempotent when they are.
 * Exceptions are swallowed on purpose: a broken glass layer must degrade the
 * wallpaper, not the settings page (§5.4).
 *
 * @param {*} ctx
 * @param {string} reason
 * @returns {{glass: boolean, layer: boolean}}
 */
function wePanelSyncFurniture(ctx, reason) {
  const done = { glass: false, layer: false }
  try {
    if (typeof weGlassRefresh === 'function') {
      weGlassRefresh(ctx, reason || 'panel')
      done.glass = true
    }
  } catch (error) {
    done.glass = false
  }
  try {
    if (typeof weLayerSync === 'function') {
      weLayerSync(ctx)
      done.layer = true
    }
  } catch (error) {
    done.layer = false
  }
  return done
}

// --------------------------------------------------------------------------- //
// diagnostics formatting
// --------------------------------------------------------------------------- //

/**
 * Port out of `mediaOrigin` (`http://127.0.0.1:51234` → `51234`). '' when the
 * media server never came up, which is itself worth showing.
 *
 * @param {*} origin
 * @returns {string}
 */
function wePanelPort(origin) {
  const text = typeof origin === 'string' ? origin : ''
  const match = /:(\d+)\/?$/.exec(text)
  return match ? match[1] : ''
}

/**
 * `GET /status` → the labelled lines §8.4 asks for (媒体源 / 端口 / 库路径 /
 * 错误), plus the glass base-colour source so a theme mismatch is visible where
 * the user already is.
 *
 * @param {*} status the `/status` body (or null when the request failed)
 * @param {*} state the store snapshot
 * @returns {Array<{label: string, value: string}>}
 */
function wePanelStatusLines(status, state) {
  const snapshot = state || (typeof weGetState === 'function' ? weGetState() : null)
  const library = snapshot && snapshot.library ? snapshot.library : null
  const scanErrors = library && Array.isArray(library.errors) ? library.errors : []
  const body = status && typeof status === 'object' ? status : {}
  const origin = typeof body.mediaOrigin === 'string' && body.mediaOrigin ? body.mediaOrigin : ''
  const libraryDirs = Array.isArray(body.libraryDirs) ? body.libraryDirs.filter(function keep(entry) {
    return typeof entry === 'string' && entry
  }) : []
  const lines = [
    { label: '媒体源', value: origin || '未就绪' },
    { label: '端口', value: wePanelPort(origin) || '—' },
    { label: '引擎', value: body.engineFound === true ? '已检测到' : '未检测到' },
    { label: '安装目录', value: typeof body.installDir === 'string' && body.installDir ? body.installDir : '—' },
    { label: '库路径', value: libraryDirs.length > 0 ? libraryDirs.join('、') : '—' },
    { label: '媒体错误', value: typeof body.mediaError === 'string' && body.mediaError ? body.mediaError : '无' },
    {
      label: '扫描错误',
      value:
        scanErrors.length > 0
          ? scanErrors
              .map(function describe(entry) {
                const path = entry && entry.path ? String(entry.path) : '?'
                const message = entry && entry.message ? String(entry.message) : '未知错误'
                return path + ': ' + message
              })
              .join('；')
          : '无',
    },
  ]
  try {
    if (typeof weGlassDiag === 'function') {
      const glass = weGlassDiag()
      const base = glass && glass.base ? glass.base : null
      lines.push({
        label: '玻璃基色',
        value: base ? String(base.source || 'unknown') + ' rgb(' + base.r + ', ' + base.g + ', ' + base.b + ')' : '未探测',
      })
      if (glass && glass.error) {
        lines.push({ label: '玻璃错误', value: weDescribeError(glass.error) })
      }
    }
  } catch (error) {
    lines.push({ label: '玻璃错误', value: weDescribeError(error) })
  }
  return lines
}

// --------------------------------------------------------------------------- //
// error boundary (§8.4 "自带错误边界")
// --------------------------------------------------------------------------- //

/** Cached boundary class — `class X extends React.Component` needs the React
 *  instance at definition time, and this module must not evaluate React at load
 *  time (a host without the global has to fail at render, inside the boundary,
 *  not at import). */
let wePanelBoundaryClassCache = null

/**
 * @returns {Function} a React class component that catches its subtree
 */
function wePanelBoundaryClass() {
  if (wePanelBoundaryClassCache) {
    return wePanelBoundaryClassCache
  }
  const React = wePanelReact()
  const Component = React.Component

  // A class *expression* inside the function body: legal, and only evaluated on
  // the first render, which is the whole point of the lazy factory.
  class PanelErrorBoundary extends Component {
    constructor(props) {
      super(props)
      this.state = { error: null, detail: '' }
    }

    static getDerivedStateFromError(error) {
      return { error: error || new Error('未知错误') }
    }

    componentDidCatch(error, info) {
      // The host logs contribution crashes itself; keeping the component stack
      // here means the fallback can show something actionable without a
      // console round-trip.
      const stack = info && info.componentStack ? String(info.componentStack) : ''
      this.setState({ detail: stack.slice(0, 400) })
    }

    render() {
      const error = this.state ? this.state.error : null
      if (error) {
        const detail = this.state && this.state.detail ? '\n' + this.state.detail : ''
        return wePanelH(
          'section',
          {
            'data-we-panel': WE_PANEL_MARK,
            'data-we-area': WE_PANEL_AREA,
            'data-we-panel-error': 'true',
            style: { padding: '0.5rem 0' },
          },
          wePanelH('p', { style: WE_PANEL_LABEL_STYLE }, '壁纸外观面板渲染失败'),
          wePanelH('pre', { style: WE_PANEL_DIAG_STYLE }, weDescribeError(error) + detail),
        )
      }
      // No wrapper element on the happy path: the body already renders the one
      // `[data-we-panel]` section, and a second one would make every selector
      // ambiguous.
      return this.props.children === undefined ? null : this.props.children
    }
  }

  wePanelBoundaryClassCache = PanelErrorBoundary
  return wePanelBoundaryClassCache
}

/**
 * Boundary + body. Exported-by-convention for 99-register.js:
 * `{ id: 'wallpaper-engine.appearance', area: 'appearance.extra', render: weAppearanceExtra(ctx) }`.
 *
 * @param {*} props `{ctx, children}`
 * @returns {*}
 */
function wePanelBoundary(props) {
  const Boundary = wePanelBoundaryClass()
  return wePanelH(Boundary, null, props && props.children ? props.children : null)
}

// --------------------------------------------------------------------------- //
// small presentational pieces
// --------------------------------------------------------------------------- //

/**
 * One-line, user-facing explanation per row — rendered as `标签（说明）`.
 *
 * Kept in one map instead of at each call site: the rows are built inline, and
 * a hint is display-only (aria-label and the wire field stay the bare label).
 * Chinese, short enough for a 22rem pane.
 */
const WE_PANEL_HINTS = Object.freeze({
  enabled: '总开关，关掉后壁纸与玻璃效果一起停',
  current: '正在使用的壁纸',
  'open-picker': '挑选或更换壁纸',
  uiCards: '把对话区和页面收进圆角玻璃卡',
  panelBase: '左侧栏等外围区域的玻璃浓淡',
  cardBase: '对话卡与页面卡的玻璃厚度',
  overlayBase: '设置、定时任务这类浮层的透明程度',
  wallpaperBlur: '壁纸本身的模糊程度',
  brightness: '壁纸亮度',
  contrast: '壁纸对比度',
  saturate: '壁纸色彩浓度',
  wallpaperOpacity: '壁纸整体透明度',
  scrim: '给壁纸压一层暗膜，让文字更清楚',
  objectFit: '壁纸铺满窗口的方式',
  switchTransition: '换壁纸时的过渡动画',
  sceneLive: '场景类壁纸是否实时渲染',
  pauseOnHidden: '窗口切到后台时暂停播放',
  rotation: '按间隔自动切换壁纸',
  rescan: '重新扫描壁纸库',
  diag: '运行时状态与错误信息',
})

const WE_PANEL_HINT_INLINE_STYLE = Object.freeze({
  fontSize: '0.6875rem',
  fontWeight: 400,
  opacity: 0.55,
})

function wePanelRowEl(key, label, control, extra) {
  const hint = Object.prototype.hasOwnProperty.call(WE_PANEL_HINTS, key) ? WE_PANEL_HINTS[key] : ''
  return wePanelH(
    'div',
    { key: key, 'data-we-row': key, style: WE_PANEL_ROW_STYLE },
    wePanelH(
      'span',
      { style: WE_PANEL_LABEL_STYLE },
      label,
      hint ? wePanelH('span', { style: WE_PANEL_HINT_INLINE_STYLE }, '（' + hint + '）') : null,
    ),
    control,
    extra === undefined ? null : extra,
  )
}

/**
 * A native checkbox rendered as a switch (`role="switch"`): the host has no
 * reachable primitive (build.py rule 1 blocks the SDK import), and a checkbox is
 * the accessible base every switch is built on.
 *
 * @param {{field: string, checked: boolean, disabled: boolean, onChange: Function}} props
 * @returns {*}
 */
function wePanelSwitchEl(props) {
  return wePanelH('input', {
    type: 'checkbox',
    role: 'switch',
    'data-we-setting': props.field,
    'aria-label': props.label,
    checked: props.checked === true,
    disabled: props.disabled === true,
    style: { justifySelf: 'start' },
    onChange: function onChange(event) {
      props.onChange(event.target.checked === true)
    },
  })
}

/**
 * A range input. `onInput` (not `onChange`) carries the drag: React maps
 * `onChange` on a range through its value-tracking polyfill, which needs a native
 * value setter to notice a programmatic change — `onInput` is the raw event in
 * both the desktop host and jsdom.
 *
 * @param {{spec: WePanelSlider, value: number, disabled: boolean, onPreview: Function, onCommit: Function}} props
 * @returns {*}
 */
function wePanelSliderEl(props) {
  const spec = props.spec
  return wePanelH(
    'div',
    { 'data-we-slider': spec.field, style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } },
    wePanelH('input', {
      type: 'range',
      'data-we-setting': spec.field,
      'aria-label': spec.label,
      min: spec.min,
      max: spec.max,
      step: 1,
      value: props.value,
      disabled: props.disabled === true,
      style: { flex: '1 1 auto', minWidth: '6rem' },
      // Drag: local value + optimistic store write, never a request.
      onInput: function onInput(event) {
        props.onPreview(wePanelNumber(event.target.value, props.value))
      },
      // React warns about a controlled input with no `onChange`, and on some
      // hosts the same native `input` event reaches both props. `preview()` drops
      // the duplicate by value, so this is one preview, not two.
      onChange: function onChange(event) {
        props.onPreview(wePanelNumber(event.target.value, props.value))
      },
      // The one commit point §8.4 names.
      onPointerUp: function onPointerUp(event) {
        props.onCommit(wePanelNumber(event.target.value, props.value))
      },
      onPointerCancel: function onPointerCancel(event) {
        props.onCommit(wePanelNumber(event.target.value, props.value))
      },
      // Keyboard users never fire pointer events: arrows fire `input`, and the
      // key release is the equivalent "let go".
      onKeyUp: function onKeyUp(event) {
        props.onCommit(wePanelNumber(event.target.value, props.value))
      },
      // Tab-away is also a release.
      onBlur: function onBlur(event) {
        props.onCommit(wePanelNumber(event.target.value, props.value))
      },
    }),
  )
}

/**
 * @param {{field: string, value: *, disabled: boolean, options: Array, onChange: Function, label: string}} props
 * @returns {*}
 */
function wePanelSelectEl(props) {
  return wePanelH(
    'select',
    {
      'data-we-setting': props.field,
      'aria-label': props.label,
      value: String(props.value),
      disabled: props.disabled === true,
      style: { justifySelf: 'start', minWidth: '7rem' },
      onChange: function onChange(event) {
        props.onChange(event.target.value)
      },
    },
    props.options.map(function option(entry) {
      return wePanelH('option', { key: String(entry.value), value: String(entry.value) }, entry.label)
    }),
  )
}

/**
 * Value read-out next to a slider.
 *
 * @param {WePanelSlider} spec
 * @param {number} value display-space
 * @returns {*}
 */
function wePanelReadoutEl(spec, value) {
  return wePanelH(
    'span',
    { 'data-we-readout': spec.field, style: { fontSize: '0.75rem', opacity: 0.7, justifySelf: 'end', minWidth: '3.5rem', textAlign: 'right' } },
    String(value) + (spec.unit || ''),
  )
}

// --------------------------------------------------------------------------- //
// the panel body
// --------------------------------------------------------------------------- //

/**
 * The appearance panel (§8.4, row by row).
 *
 * Props: `{ctx}` — the plugin context, needed for `ctx.rest` behind
 * `weSaveConfig`/`weLoadLibrary`/`weRequestStatus`. The host's contribution seam
 * calls `render()` with no arguments, which is why `weAppearanceExtra(ctx)`
 * closes over it.
 *
 * @param {{ctx: *}} props
 * @returns {*}
 */
function weAppearancePanel(props) {
  const ctx = props && props.ctx ? props.ctx : null
  const React = wePanelReact()
  const state = weUseStore()
  const settings = wePanelSettings(state)
  const [draft, setDraft] = React.useState({})
  const [rescanning, setRescanning] = React.useState(false)
  const [diag, setDiag] = React.useState({ open: false, loading: false, status: null, error: null })
  // Mirrors of the drag state, written synchronously: two dispatched events in
  // one React batch must still see "a drag is open" / "that drag just closed".
  const dragRef = React.useRef({})
  const baseRef = React.useRef(null)

  const enabled = wePanelEnabled(settings)
  const hasScene = wePanelHasScene(state)
  const sceneDisabled = !enabled || !hasScene
  const rotation = wePanelRotation(settings)

  // ---- draft plumbing ------------------------------------------------- //

  function setDraftField(field, value) {
    setDraft(function merge(prev) {
      if (prev[field] === value) {
        return prev
      }
      const next = Object.assign({}, prev)
      next[field] = value
      return next
    })
  }

  function clearDraftField(field) {
    setDraft(function drop(prev) {
      if (!Object.prototype.hasOwnProperty.call(prev, field)) {
        return prev
      }
      const next = Object.assign({}, prev)
      delete next[field]
      return next
    })
  }

  /**
   * Live preview with no request: remember the confirmed document once per drag,
   * then push the value into the store so glass/layer see it. A repeated value
   * (the same native event reaching both `onInput` and `onChange`) is dropped.
   */
  function preview(settingsPatch, draftField, displayValue) {
    if (draftField && Object.prototype.hasOwnProperty.call(dragRef.current, draftField) && dragRef.current[draftField] === displayValue) {
      return
    }
    if (baseRef.current === null) {
      baseRef.current = weGetState().config
    }
    if (draftField) {
      dragRef.current[draftField] = displayValue
      setDraftField(draftField, displayValue)
    }
    const optimistic = wePanelApplyOptimistic(weGetState().config, settingsPatch)
    if (!optimistic) {
      return
    }
    weApplyConfig(optimistic)
    // Store → (subscription | this call) → tokens. The call keeps the preview
    // alive when the glass engine has not subscribed yet; it is idempotent
    // otherwise, because 30-glass only rewrites values that actually changed.
    wePanelApplyGlass(ctx, optimistic.settings)
  }

  /**
   * Commit exactly once per drag: the ref guard makes `pointerup` + `blur` (or a
   * double-fired pointer event) idempotent.
   */
  function commit(settingsPatch, draftField) {
    if (!Object.prototype.hasOwnProperty.call(dragRef.current, draftField)) {
      return Promise.resolve(null)
    }
    delete dragRef.current[draftField]
    const base = baseRef.current
    baseRef.current = null
    clearDraftField(draftField)
    return wePanelSave(ctx, settingsPatch, base)
  }

  function sliderPatch(field, displayValue) {
    const patch = {}
    patch[field] = wePanelSliderWire(field, displayValue)
    return patch
  }

  function onSliderPreview(field, displayValue) {
    if (!enabled) {
      return
    }
    preview(sliderPatch(field, displayValue), field, displayValue)
  }

  function onSliderCommit(field, displayValue) {
    if (!enabled) {
      return Promise.resolve(null)
    }
    return commit(sliderPatch(field, displayValue), field)
  }

  // ---- discrete controls: optimistic → PUT → response wins ------------ //

  /**
   * A switch/select/interval write. Discrete controls do not drag, so the
   * "confirmed" document is simply what the store held a moment ago.
   */
  function onDiscreteChange(settingsPatch, after) {
    const before = weGetState().config
    const optimistic = wePanelApplyOptimistic(before, settingsPatch)
    if (optimistic) {
      weApplyConfig(optimistic)
    }
    return wePanelSave(ctx, settingsPatch, before).then(function settled(result) {
      if (typeof after === 'function') {
        after(result)
      }
      return result
    })
  }

  /**
   * §8.4 启用壁纸: the only control that moves the glass engine and the layer
   * out of / back into the page. Both owners are asked through their own API and
   * only after the answer is confirmed, so the tokens and the layer end up
   * matching what the backend actually stored.
   */
  function onEnabledChange(next) {
    const before = weGetState().config
    const optimistic = wePanelApplyOptimistic(before, { enabled: next })
    if (optimistic) {
      weApplyConfig(optimistic)
    }
    return wePanelSave(ctx, { enabled: next }, before).then(function settled(result) {
      wePanelSyncFurniture(ctx, 'panel-enabled')
      return result
    })
  }

  function onSceneFpsChange(value) {
    return onDiscreteChange({ sceneLiveFps: wePanelSceneFps({ sceneLiveFps: wePanelNumber(value, WE_PANEL_SCENE_FPS[0]) }) })
  }

  /**
   * Rotation is replaced **whole** by the backend (§6.3), so `shuffle` — which
   * §8.4 does not expose — is carried through instead of being reset by every
   * toggle.
   */
  function onRotationChange(patch) {
    const next = Object.assign({}, rotation, patch)
    return onDiscreteChange({
      rotation: {
        enabled: next.enabled === true,
        intervalMinutes: wePanelClampInt(next.intervalMinutes, WE_PANEL_INTERVAL_MIN, WE_PANEL_INTERVAL_MAX, 10),
        shuffle: next.shuffle === true,
      },
    })
  }

  function onIntervalPreview(value) {
    // Same drag bookkeeping as a slider: the ref is what `onIntervalCommit`
    // checks, so forgetting it here would silently drop the PUT.
    dragRef.current['rotation.intervalMinutes'] = value
    setDraftField('rotation.intervalMinutes', value)
    const optimistic = wePanelApplyOptimistic(weGetState().config, {
      rotation: {
        enabled: rotation.enabled,
        intervalMinutes: wePanelClampInt(value, WE_PANEL_INTERVAL_MIN, WE_PANEL_INTERVAL_MAX, 10),
        shuffle: rotation.shuffle,
      },
    })
    if (optimistic) {
      weApplyConfig(optimistic)
    }
  }

  function onIntervalCommit(value) {
    if (!Object.prototype.hasOwnProperty.call(dragRef.current, 'rotation.intervalMinutes')) {
      return Promise.resolve(null)
    }
    delete dragRef.current['rotation.intervalMinutes']
    clearDraftField('rotation.intervalMinutes')
    return onRotationChange({ intervalMinutes: value })
  }

  // ---- actions ------------------------------------------------------- //

  /** §8.4 打开壁纸库 — the button only opens the modal; 50-picker renders it. */
  function onOpenPicker() {
    weSet({ pickerOpen: true })
  }

  /** §8.4 重新扫描 — `GET /library?refresh=1`, with a local spinner. */
  function onRescan() {
    if (rescanning) {
      return Promise.resolve(null)
    }
    setRescanning(true)
    return Promise.resolve()
      .then(function run() {
        return weLoadLibrary(ctx, { refresh: true })
      })
      .then(
        function done(result) {
          setRescanning(false)
          return result
        },
        function failed(error) {
          setRescanning(false)
          weSet({ toast: weFailureToast('重新扫描失败', error) })
          return { ok: false, error }
        },
      )
  }

  /** §8.4 诊断信息 — `GET /status` on first expand, cached in component state. */
  function onToggleDiag() {
    const open = !diag.open
    setDiag(function toggle(prev) {
      return Object.assign({}, prev, { open: open })
    })
    if (!open || diag.status || diag.loading) {
      return
    }
    setDiag(function starting(prev) {
      return Object.assign({}, prev, { loading: true, error: null })
    })
    return Promise.resolve()
      .then(function ask() {
        return weRequestStatus(ctx)
      })
      .then(function landed(result) {
        setDiag(function settled(prev) {
          return Object.assign({}, prev, {
            loading: false,
            status: result && result.ok ? result.status : null,
            error: result && result.ok ? null : weDescribeError(result ? result.error : '未知错误'),
          })
        })
      })
  }

  function onReloadConfig() {
    return weRefreshConfig(ctx)
  }

  function onIntervalInputEvent(event) {
    onIntervalPreview(event.target.value)
  }

  function onIntervalKeyUpEvent(event) {
    onIntervalCommit(event.target.value)
  }

  function onIntervalBlurEvent(event) {
    onIntervalCommit(event.target.value)
  }

  // ---- empty / loading state ----------------------------------------- //

  if (!state.config) {
    const failed = state.boot === WE_PANEL_BOOT_ERROR
    return wePanelH(
      'section',
      {
        'data-we-panel': WE_PANEL_MARK,
        'data-we-area': WE_PANEL_AREA,
        'data-we-state': failed ? 'error' : 'loading',
        style: Object.assign({}, WE_PANEL_SECTION_STYLE, WE_PANEL_CARD_STYLE),
      },
      wePanelH('p', { style: WE_PANEL_HINT_STYLE }, failed ? '配置加载失败' : '正在加载壁纸配置…'),
      failed
        ? wePanelH(
            'button',
            { type: 'button', 'data-we-action': 'reload-config', onClick: onReloadConfig, style: { justifySelf: 'start' } },
            '重试',
          )
        : null,
    )
  }

  // ---- rows ---------------------------------------------------------- //

  const rows = []

  rows.push(
    wePanelRowEl(
      'enabled',
      '启用壁纸',
      wePanelSwitchEl({
        field: 'enabled',
        label: '启用壁纸',
        checked: enabled,
        disabled: false,
        onChange: onEnabledChange,
      }),
      null,
    ),
  )

  // 当前壁纸: 预览缩略图 + 标题 + 类型徽标 (空态 "未选择壁纸")
  const current = state.current
  const previewUrl = current ? wePanelPreviewUrl(state, current) : ''
  const thumb = current
    ? previewUrl
      ? wePanelH('img', {
          key: 'thumb',
          'data-we-current-preview': 'url',
          src: previewUrl,
          alt: '',
          style: WE_PANEL_THUMB_STYLE,
        })
      : wePanelH('span', {
          key: 'thumb',
          'data-we-current-preview': 'color',
          style: Object.assign({}, WE_PANEL_THUMB_STYLE, {
            background: typeof current.schemeColor === 'string' && current.schemeColor ? current.schemeColor : WE_PANEL_THUMB_STYLE.background,
          }),
        })
    : null

  rows.push(
    wePanelRowEl(
      'current',
      '当前壁纸',
      wePanelH(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 } },
        thumb,
        wePanelH(
          'div',
          { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          wePanelH(
            'span',
            { 'data-we-current-title': current ? 'set' : 'empty', style: { fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            current ? String(current.title || current.id) : '未选择壁纸',
          ),
          current && typeof current.dir === 'string'
            ? wePanelH('span', { style: WE_PANEL_HINT_STYLE }, current.dir)
            : null,
        ),
        current
          ? wePanelH(
              'span',
              { 'data-we-current-kind': current.kind, style: WE_PANEL_BADGE_STYLE },
              wePanelKindLabel(current.kind) + (weIsPlayable(current) ? '' : '（不可播放）'),
            )
          : null,
      ),
      null,
    ),
  )

  rows.push(
    wePanelRowEl(
      'open-picker',
      '壁纸库',
      wePanelH(
        'button',
        { type: 'button', 'data-we-action': 'open-picker', onClick: onOpenPicker, style: { justifySelf: 'start' } },
        '打开壁纸库',
      ),
      null,
    ),
  )

  // 卡片化 — gates the inset-card look on the chat surface AND the full-page
  // views. Above the concentration sliders on purpose: they tune a card that
  // does not exist while this is off.
  rows.push(
    wePanelRowEl(
      'uiCards',
      '界面卡片化',
      wePanelSwitchEl({
        field: 'uiCards',
        label: '界面卡片化',
        checked: settings.uiCards !== false,
        disabled: !enabled,
        onChange: function onChange(next) {
          return onDiscreteChange({ uiCards: next })
        },
      }),
      null,
    ),
  )

  for (const spec of WE_PANEL_SLIDERS) {
    const value =
      Object.prototype.hasOwnProperty.call(draft, spec.field) && draft[spec.field] !== undefined
        ? wePanelNumber(draft[spec.field], wePanelSliderDisplay(spec.field, settings))
        : wePanelSliderDisplay(spec.field, settings)
    rows.push(
      wePanelRowEl(
        spec.field,
        spec.label,
        wePanelSliderEl({
          spec: spec,
          value: value,
          disabled: !enabled,
          // Recreated per render, but each handler closes over the *current* spec
          // and field, so no state is lost between renders.
          onPreview: function onPreview(next) {
            onSliderPreview(spec.field, next)
          },
          onCommit: function onCommit(next) {
            onSliderCommit(spec.field, next)
          },
        }),
        wePanelReadoutEl(spec, value),
      ),
    )
  }

  rows.push(
    wePanelRowEl(
      'objectFit',
      '填充方式',
      wePanelSelectEl({
        field: 'objectFit',
        label: '填充方式',
        value: typeof settings.objectFit === 'string' ? settings.objectFit : 'cover',
        options: WE_PANEL_OBJECT_FITS,
        disabled: !enabled,
        onChange: function onChange(value) {
          return onDiscreteChange({ objectFit: value })
        },
      }),
      null,
    ),
  )

  rows.push(
    wePanelRowEl(
      'switchTransition',
      '转场',
      wePanelSelectEl({
        field: 'switchTransition',
        label: '转场',
        value: settings.switchTransition === 'cut' ? 'cut' : 'fade',
        options: WE_PANEL_TRANSITIONS,
        disabled: !enabled,
        onChange: function onChange(value) {
          return onDiscreteChange({ switchTransition: value === 'cut' ? 'cut' : 'fade' })
        },
      }),
      null,
    ),
  )

  // 场景实时渲染: Switch + 帧率 Select, 无场景壁纸时置灰
  rows.push(
    wePanelRowEl(
      'sceneLive',
      '场景实时渲染',
      wePanelH(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', justifySelf: 'start' } },
        wePanelSwitchEl({
          field: 'sceneLive',
          label: '场景实时渲染',
          checked: settings.sceneLive !== false,
          disabled: sceneDisabled,
          onChange: function onChange(next) {
            return onDiscreteChange({ sceneLive: next })
          },
        }),
        wePanelSelectEl({
          field: 'sceneLiveFps',
          label: '场景帧率',
          value: wePanelSceneFps(settings),
          options: WE_PANEL_SCENE_FPS.map(function option(fps) {
            return { value: fps, label: String(fps) + ' fps' }
          }),
          disabled: sceneDisabled,
          onChange: onSceneFpsChange,
        }),
      ),
      hasScene
        ? null
        : wePanelH('span', { 'data-we-scene-note': 'missing', style: WE_PANEL_HINT_STYLE }, '无场景壁纸'),
    ),
  )

  rows.push(
    wePanelRowEl(
      'pauseOnHidden',
      '后台暂停',
      wePanelSwitchEl({
        field: 'pauseOnHidden',
        label: '后台暂停',
        checked: settings.pauseOnHidden !== false,
        disabled: !enabled,
        onChange: function onChange(next) {
          return onDiscreteChange({ pauseOnHidden: next })
        },
      }),
      null,
    ),
  )

  // 轮换: Switch + 间隔（分钟）
  const intervalDisplay =
    Object.prototype.hasOwnProperty.call(draft, 'rotation.intervalMinutes') && draft['rotation.intervalMinutes'] !== undefined
      ? String(draft['rotation.intervalMinutes'])
      : String(rotation.intervalMinutes)
  rows.push(
    wePanelRowEl(
      'rotation',
      '轮换',
      wePanelH(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', justifySelf: 'start' } },
        wePanelSwitchEl({
          field: 'rotation.enabled',
          label: '轮换',
          checked: rotation.enabled,
          disabled: !enabled,
          onChange: function onChange(next) {
            return onRotationChange({ enabled: next })
          },
        }),
        wePanelH('input', {
          type: 'number',
          'data-we-setting': 'rotation.intervalMinutes',
          'aria-label': '轮换间隔（分钟）',
          min: WE_PANEL_INTERVAL_MIN,
          max: WE_PANEL_INTERVAL_MAX,
          step: 1,
          value: intervalDisplay,
          disabled: !enabled || !rotation.enabled,
          style: { width: '5rem' },
          onInput: onIntervalInputEvent,
          onKeyUp: onIntervalKeyUpEvent,
          onBlur: onIntervalBlurEvent,
        }),
        wePanelH('span', { style: WE_PANEL_HINT_STYLE }, '分钟'),
      ),
      null,
    ),
  )

  // 重新扫描: 转圈态走 React state，不进 store
  rows.push(
    wePanelRowEl(
      'rescan',
      '壁纸库扫描',
      wePanelH(
        'button',
        {
          type: 'button',
          'data-we-action': 'rescan',
          'data-we-busy': rescanning ? 'true' : 'false',
          disabled: rescanning,
          onClick: onRescan,
          style: { justifySelf: 'start' },
        },
        rescanning ? '正在扫描…' : '重新扫描',
      ),
      state.library && Array.isArray(state.library.items)
        ? wePanelH(
            'span',
            { 'data-we-library-count': state.library.items.length, style: WE_PANEL_HINT_STYLE },
            String(state.library.items.length) + ' 项',
          )
        : null,
    ),
  )

  // 诊断信息: 折叠文本
  rows.push(
    wePanelRowEl(
      'diag',
      '诊断信息',
      wePanelH(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '0.25rem' } },
        wePanelH(
          'button',
          {
            type: 'button',
            'data-we-action': 'diag-toggle',
            'aria-expanded': diag.open ? 'true' : 'false',
            onClick: onToggleDiag,
            style: { justifySelf: 'start' },
          },
          diag.open ? '收起诊断' : '展开诊断',
        ),
        diag.open
          ? wePanelH(
              'pre',
              { 'data-we-diag': diag.loading ? 'loading' : diag.error ? 'error' : 'ready', style: WE_PANEL_DIAG_STYLE },
              diag.loading
                ? '正在读取…'
                : diag.error
                  ? diag.error
                  : wePanelStatusLines(diag.status, state)
                      .map(function line(entry) {
                        return entry.label + '：' + entry.value
                      })
                      .join('\n'),
            )
          : null,
      ),
      null,
    ),
  )

  const notice = state.toast && state.toast.text ? state.toast.text : ''

  return wePanelH(
    'section',
    {
      'data-we-panel': WE_PANEL_MARK,
      'data-we-area': WE_PANEL_AREA,
      'data-we-state': 'ready',
      'data-we-disabled': enabled ? 'false' : 'true',
      style: Object.assign({}, WE_PANEL_SECTION_STYLE, wePanelSurfaceStyle(settings), { opacity: enabled ? 1 : 0.6 }),
    },
    wePanelH('h3', { style: WE_PANEL_HEADING_STYLE }, '壁纸外观'),
    !enabled
      ? wePanelH('p', { 'data-we-disabled-note': 'true', style: WE_PANEL_HINT_STYLE }, '壁纸已关闭：以下参数保留，重新启用后立即生效。')
      : null,
    state.library && state.library.engineFound === false
      ? wePanelH('p', { 'data-we-engine-missing': 'true', style: WE_PANEL_HINT_STYLE }, '未检测到 Wallpaper Engine：可在壁纸库里手动添加库根。')
      : null,
    notice ? wePanelH('p', { 'data-we-toast': state.toast.kind || 'info', style: WE_PANEL_HINT_STYLE }, notice) : null,
    ...rows,
    // The library modal lives INSIDE this panel's tree, not in a second
    // contribution. It is `position: fixed; inset: 0`, so visually it is a
    // full-screen overlay wherever it is mounted — but React only subscribes
    // to the store for components that are actually mounted, and the panel's
    // own contribution is the one that is resident. A separate modal
    // contribution on any other seam stays unmounted and the button does
    // nothing (that was the 2026-10-20 regression: the adapter sat on
    // `appearance.extra`, which the host renders only on a page normal
    // navigation never reaches).
    typeof wePickerModal === 'function'
      ? wePanelH(wePickerModal, { ctx: ctx })
      : null,
  )
}

/**
 * The contribution factory 99-register.js wires into `appearance.extra`:
 *
 *     ctx.contributions.register({
 *       id: 'wallpaper-engine.appearance',
 *       area: 'appearance.extra',
 *       render: weAppearanceExtra(ctx),
 *     })
 *
 * The host calls `render()` with no arguments (`ContribRender` →
 * `createElement(render)`), so ctx is closed over here and handed to the body as
 * a prop; the boundary wraps it so a render crash degrades to one inline message
 * instead of a dead Appearance page.
 *
 * @param {*} ctx
 * @returns {() => *} a zero-argument render function
 */
function weAppearanceExtra(ctx) {
  return function renderAppearancePanel() {
    return wePanelH(
      wePanelBoundary,
      null,
      wePanelH(weAppearancePanel, { ctx: ctx }),
    )
  }
}
