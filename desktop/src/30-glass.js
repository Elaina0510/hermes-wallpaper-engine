/**
 * MOD-009 — the liquid-glass engine (T2.4).
 *
 * Three seams and one parameter block, no DOM furniture:
 *
 *   1. **base-colour probe** — a throwaway `<div style="background: var(--ui-bg-chrome)">`
 *      measures what the theme actually paints the chrome with, so the glass tint
 *      tracks the theme instead of a hard-coded grey (§8.2 step 1).
 *   2. **inline snapshot / override / restore** — before the first write the
 *      *original inline value* of every glass token is recorded verbatim (the
 *      empty string is a legal, meaningful baseline), every write is a single
 *      `style.setProperty`, and teardown puts the baseline back (§8.2 steps 2/3/6).
 *   3. **theme-change recompute** — a `MutationObserver` on `<html>`'s
 *      `class`/`style`/`data-theme` re-probes and rewrites, coalesced to one run
 *      per 200 ms (§8.2 step 4).
 *
 * Wallpaper filter parameters are *computed here and applied elsewhere*: this
 * file returns `{filter, opacity, scrim, scrimColor, …}` and touches no layer
 * element. 10-layer.js owns the filter chain, the scrim film and the transform
 * (§8.2 step 7 belongs to that module — see the deliverable split in T2.4).
 *
 * ## The one rule that is easy to get wrong
 *
 * `panelBase >= 100` / `cardBase >= 100` / `enabled === false` means **delete the
 * inline property**, never write `rgba(r, g, b, 1)`. Writing an opaque colour
 * replaces the theme's whole `var()` chain with a frozen literal, so the moment
 * the theme flips (or we restore) there is nothing left to fall back to and the
 * original colour is gone for good (§8.2 step 5). The clean branch restores the
 * snapshot instead — which, for a token that had no inline value, *is* a delete.
 *
 * ## Why the snapshot is not in the store
 *
 * §8.2 step 2 says "存进 store". The renderer store (§5.4) is exactly eight
 * render inputs and `weSet` silently drops unknown keys, so the baseline lives in
 * this module's own state instead: it is not a render input, it is teardown
 * bookkeeping, and putting it in the store would both fail to land and invite a
 * re-render on every theme flip. Recorded as a deviation in the T2.4 report.
 *
 * ## What this file may not do
 *
 * No `import` / `export` (00-core.js owns the only import, 99-register.js the
 * only export — build.py rules 1/2/3), no bare `setTimeout` (F22: timers are flat
 * `ctx` methods that return disposers), no layer DOM, and no copy of 00-core's
 * store/rest helpers. Every top-level symbol is `we`-prefixed and reaches its
 * neighbours through the concatenated module's shared scope.
 */

// --------------------------------------------------------------------------- //
// constants
// --------------------------------------------------------------------------- //

/** The shell seam (§8.1, F12). */
const WE_GLASS_PANEL_VAR = '--ui-bg-sidebar'

/** The chat-card seam (§8.1, F12). */
const WE_GLASS_CARD_VAR = '--ui-chat-surface-background'

/** The token the base colour is read from (§8.2 step 1). */
const WE_GLASS_CHROME_VAR = '--ui-bg-chrome'

/**
 * `<html>` marker meaning "the glass engine is running and owns the surface
 * tokens". 10-layer's stylesheet fallback (`:root:has([data-wallpaper-layer])
 * :not([data-we-glass])`) keys off it: present → the engine's inline rgba tints
 * win (density sliders live); absent → force the surfaces transparent so a
 * wallpaper is never buried under an opaque theme surface.
 */
const WE_GLASS_ROOT_ATTR = 'data-we-glass'

/**
 * `cardBase` below this is not a rendered tier at all (§8.4). Extended from 20
 * to 0 on 2026-10-22 at the user's request: 0 is now a real tier and renders
 * `rgba(base, 0)`, i.e. a fully transparent card, instead of snapping back to
 * the opaque theme surface. Keep it in step with `dashboard/config.py`'s
 * `_NUMERIC_RANGES` and the panel slider's `min`.
 */
const WE_GLASS_CARD_FLOOR = 0

/** Theme-flip coalescing window (§8.2 step 4). */
const WE_GLASS_THROTTLE_MS = 200

/** `<html>` attributes that can carry a theme flip (§8.2 step 4). */
const WE_GLASS_THEME_ATTRS = Object.freeze(['class', 'style', 'data-theme'])

/**
 * Fallback chrome tokens, tried in order after `--ui-bg-chrome` itself. The
 * design only names `--ui-bg-chrome`; these are cheaper than shipping a hard
 * grey on a host that renamed the token. Every entry is *skipped while it is
 * applied by us*, so a recompute can never read its own output (§8.2 note: no
 * stacking).
 */
const WE_GLASS_PROBE_CHAIN = Object.freeze([
  WE_GLASS_CHROME_VAR,
  '--ui-bg',
  '--ui-bg-body',
  '--ui-bg-elevated',
  '--ui-bg-app',
])

/** Last resort when no token resolves. Matches the app's dark chrome closely
 *  enough that a wrong guess is invisible next to a transparent wall; the probe
 *  reports `source: 'default'` so a host mismatch is diagnosable instead of
 *  silent. */
const WE_GLASS_DEFAULT_BASE = Object.freeze({ r: 24, g: 26, b: 30, a: 1 })

/** How deep a `var()` chain is followed before we give up (§8.3: themes do chain). */
const WE_GLASS_VAR_DEPTH = 8

/**
 * Descriptor states. `verified` = the token is named by the design and is
 * covered by a test; `pending-measurement` = plausible but unmeasured, so it is
 * carried in the list and *not* written.
 */
const WE_GLASS_STATUS = Object.freeze({
  VERIFIED: 'verified',
  PENDING: 'pending-measurement',
})

/**
 * The token list. Extensible by design (§8.3 "[PV-2] … 若为独立 token，将其加入
 * GLASS_VARS（不改设计结构）"): appending a descriptor — or flipping a `pending`
 * one to `enabled: true` after a DevTools measurement — is the whole change.
 *
 * @typedef {Object} WeGlassVar
 * @property {string} id        short handle, also the diagnostic key
 * @property {string} token     CSS custom property on `<html>`
 * @property {string} setting   the `settings` field that drives its alpha
 * @property {number} floor     lowest value that renders this tier (percent)
 * @property {string} status    WE_GLASS_STATUS member
 * @property {boolean} enabled  false → listed, reported, never written
 * @property {string} note      why it is (or is not) trusted
 * @type {ReadonlyArray<WeGlassVar>}
 */
const GLASS_VARS = Object.freeze([
  Object.freeze({
    id: 'panel',
    token: WE_GLASS_PANEL_VAR,
    setting: 'panelBase',
    floor: 0,
    status: WE_GLASS_STATUS.VERIFIED,
    enabled: true,
    note: '§8.1 外壳缝；设计文档点名，测试覆盖（T11b/T11c/T15）',
  }),
  Object.freeze({
    id: 'card',
    token: WE_GLASS_CARD_VAR,
    setting: 'cardBase',
    floor: WE_GLASS_CARD_FLOOR,
    status: WE_GLASS_STATUS.VERIFIED,
    enabled: true,
    note: '§8.1 聊天卡缝；设计文档点名，测试覆盖',
  }),
  Object.freeze({
    id: 'editor-surface',
    token: '--ui-editor-surface-background',
    setting: 'cardBase',
    floor: WE_GLASS_CARD_FLOOR,
    status: WE_GLASS_STATUS.VERIFIED,
    enabled: true,
    note:
      '宿主 styles.css:400 把该 token 映射到 --ui-bg-chrome；pane 树、pane 标签页、diff 行都穿它。' +
      '与聊天卡同档，随 cardBase（2026-10-22 实测宿主源码；不写它会成为玻璃运行时唯一漏下的实色面）',
  }),
  Object.freeze({
    id: 'chat-surface',
    token: '--ui-chat-surface',
    setting: 'cardBase',
    floor: WE_GLASS_CARD_FLOOR,
    status: WE_GLASS_STATUS.PENDING,
    enabled: false,
    note:
      '[PV-2] 候选：若 [data-chat-surface] 的 computed background 不来自 ' +
      '--ui-chat-surface-background 而是独立 token，实测出真名后改 token 并置 enabled:true；' +
      '未实测前一律不写（jsdom 无 layout，只能靠 weGlassMeasureChatSurface 在真机 DevTools 侧判定）',
  }),
])

// --------------------------------------------------------------------------- //
// module state
//
// One glass engine per module evaluation: a reload re-evaluates the concatenated
// module into a fresh scope, which is the "start clean" we want. Nothing here is
// a render input, so nothing here belongs in the renderer store.
// --------------------------------------------------------------------------- //

const weGlassState = {
  /** `{document, window}` resolved from ctx once, reused by every entry point. */
  env: null,
  /** The live ctx (for `ctx.setTimeout`); null when never started. */
  ctx: null,
  /** Per-token baseline: `{present: boolean, value: string}` — value verbatim. */
  snapshot: Object.create(null),
  /** Per-token value *we* wrote; `null` = clean branch (baseline in force). */
  applied: Object.create(null),
  /** Last probed base colour `{r,g,b,a,source,token}`. */
  base: null,
  /** Last computed filter bundle (consumed by 10-layer.js). */
  filters: null,
  /** `<html>`'s `style` attribute right after our last write — the self-write
   *  fingerprint the observer uses to ignore its own mutations. */
  styleMark: null,
  /** Live `MutationObserver`, null when not started. */
  observer: null,
  /** Pending throttle fire: `{dispose: () => void}` or null. */
  timer: null,
  /** Reason string of the pending run, for diagnostics. */
  timerReason: '',
  /** Recompute counter — tests and the diag panel read it. */
  runs: 0,
  /** Store subscription disposer. */
  unsubscribe: null,
  /** Signature of the settings the current override was computed from. */
  signature: '',
  /** Last error, never thrown to a React boundary (§5.4 failure policy). */
  error: null,
}

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //

/**
 * A finite number or the fallback. Strings that parse are accepted because the
 * wire form of a numeric setting is not guaranteed to be a number.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function weGlassNumber(value, fallback) {
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
 * `weGlassNumber` + bounds. This is **not** a second copy of the backend's clamp
 * table (§6.3: the renderer must not grow one — the backend already clamped every
 * value it handed us). It is CSS validity defence: `brightness(NaN)` and a
 * negative blur would poison the whole `filter` declaration, so a garbage or
 * missing field degrades to the neutral value instead.
 *
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function weGlassRange(value, min, max, fallback) {
  const number = weGlassNumber(value, fallback)
  return Math.min(max, Math.max(min, number))
}

/**
 * Strip float noise without exponent notation (`1e-7px` is valid CSS but makes
 * diffs and assertions unreadable).
 *
 * @param {number} value
 * @returns {string}
 */
function weGlassTrim(value) {
  const rounded = Math.round(value * 1000) / 1000
  return String(rounded)
}

/**
 * Two CSS values are "the same" if only whitespace/case differ. Custom
 * properties are token streams, so a host or jsdom may re-space what we wrote;
 * comparing raw strings would then look like an external write.
 *
 * @param {*} left
 * @param {*} right
 * @returns {boolean}
 */
function weGlassSameValue(left, right) {
  const a = left === null || left === undefined ? '' : String(left)
  const b = right === null || right === undefined ? '' : String(right)
  return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()
}

/**
 * The document/window pair. `ctx` is the authority when it carries them
 * (`ctx.document`), otherwise the ambient DOM; a host without either yields
 * nulls and every entry point degrades to a no-op result instead of throwing.
 *
 * @param {*} [ctx]
 * @returns {{ctx: *, doc: Document|null, win: (Window|null)}}
 */
function weGlassEnv(ctx) {
  if (ctx && (ctx.document || ctx.window)) {
    const doc = ctx.document || (ctx.window && ctx.window.document) || null
    const win = ctx.window || (doc && doc.defaultView) || null
    return { ctx, doc, win }
  }
  if (weGlassState.env) {
    return weGlassState.env
  }
  const doc = typeof document !== 'undefined' ? document : null
  const win = typeof window !== 'undefined' ? window : doc && doc.defaultView
  return { ctx: ctx || null, doc, win: win || null }
}

// --------------------------------------------------------------------------- //
// colour parsing
//
// Everything here is a pure function over a string. It has to cope with what a
// host actually returns: `rgb()`, `rgba()`, space-or-comma separated channels,
// `/ alpha`, percentages, hex in 3/4/6/8 digits, a handful of keywords (jsdom
// hands back `rebeccapurple` verbatim when it is an inline custom property), and
// the values that mean "nothing usable" — `''`, `transparent`, `currentcolor`,
// `initial`, a `var()` we could not resolve, or garbage.
// --------------------------------------------------------------------------- //

/** The keyword table. Deliberately short: this is a fallback for hosts that do
 *  not normalise keywords, not a CSS colour library. */
const WE_GLASS_NAMED_COLORS = Object.freeze({
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  silver: [192, 192, 192, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  white: [255, 255, 255, 1],
  maroon: [128, 0, 0, 1],
  red: [255, 0, 0, 1],
  purple: [128, 0, 128, 1],
  rebeccapurple: [102, 51, 153, 1],
  green: [0, 128, 0, 1],
  lime: [0, 255, 0, 1],
  olive: [128, 128, 0, 1],
  yellow: [255, 255, 0, 1],
  navy: [0, 0, 128, 1],
  blue: [0, 0, 255, 1],
  teal: [0, 128, 128, 1],
  aqua: [0, 255, 255, 1],
  cyan: [0, 255, 255, 1],
  fuchsia: [255, 0, 255, 1],
  magenta: [255, 0, 255, 1],
  orange: [255, 165, 0, 1],
})

/** Values that are syntactically fine but carry no colour. */
const WE_GLASS_NO_COLOR = Object.freeze(['', 'none', 'initial', 'inherit', 'unset', 'revert', 'currentcolor', 'auto'])

/**
 * One channel. `50%` means "half of this channel's range" in CSS.
 *
 * @param {string} text
 * @param {number} scale 255 for rgb channels
 * @returns {number|null}
 */
function weGlassChannel(text, scale) {
  const raw = String(text).trim()
  if (!raw) {
    return null
  }
  const percent = raw.charAt(raw.length - 1) === '%'
  const number = Number(percent ? raw.slice(0, -1) : raw)
  if (!isFinite(number)) {
    return null
  }
  const value = percent ? (number / 100) * scale : number
  return Math.round(Math.min(scale, Math.max(0, value)))
}

/**
 * @param {string} text `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`
 * @returns {{r: number, g: number, b: number, a: number}|null}
 */
function weGlassParseHex(text) {
  const digits = text.slice(1)
  if (!/^[0-9a-f]+$/.test(digits)) {
    return null
  }
  const expand = function expand(part) {
    return parseInt(part.length === 1 ? part + part : part, 16)
  }
  if (digits.length === 3 || digits.length === 4) {
    return {
      r: expand(digits.charAt(0)),
      g: expand(digits.charAt(1)),
      b: expand(digits.charAt(2)),
      a: digits.length === 4 ? Math.round((expand(digits.charAt(3)) / 255) * 1000) / 1000 : 1,
    }
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: expand(digits.slice(0, 2)),
      g: expand(digits.slice(2, 4)),
      b: expand(digits.slice(4, 6)),
      a: digits.length === 8 ? Math.round((expand(digits.slice(6, 8)) / 255) * 1000) / 1000 : 1,
    }
  }
  return null
}

/**
 * Split `rgb(1 2 3 / 40%)` or `rgba(1, 2, 3, 0.4)` into channels + alpha.
 *
 * @param {string} body the text between the parentheses
 * @returns {{parts: string[], alpha: string|null}}
 */
function weGlassSplitArgs(body) {
  const slash = body.split('/')
  const head = (slash[0] || '').trim()
  const parts = head
    .split(/[\s,]+/)
    .map(function trim(part) {
      return part.trim()
    })
    .filter(Boolean)
  return { parts, alpha: slash.length > 1 ? (slash[1] || '').trim() : null }
}

/**
 * @param {string} text
 * @returns {{r: number, g: number, b: number, a: number}|null}
 */
function weGlassParseHsl(text) {
  const match = /^hsla?\(([^)]*)\)$/.exec(text)
  if (!match) {
    return null
  }
  const split = weGlassSplitArgs(match[1])
  if (split.parts.length < 3) {
    return null
  }
  const hue = Number(String(split.parts[0]).replace(/deg$/, ''))
  const sat = Number(String(split.parts[1]).replace('%', ''))
  const light = Number(String(split.parts[2]).replace('%', ''))
  if (!isFinite(hue) || !isFinite(sat) || !isFinite(light)) {
    return null
  }
  const alphaRaw = split.alpha === null ? split.parts[3] : split.alpha
  const alpha = alphaRaw === undefined ? 1 : weGlassAlphaValue(alphaRaw)
  const s = Math.min(1, Math.max(0, sat / 100))
  const l = Math.min(1, Math.max(0, light / 100))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const h = ((hue % 360) + 360) % 360
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const table = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ]
  const sector = table[Math.min(5, Math.floor(h / 60))]
  return {
    r: Math.round((sector[0] + m) * 255),
    g: Math.round((sector[1] + m) * 255),
    b: Math.round((sector[2] + m) * 255),
    a: alpha,
  }
}

/**
 * Alpha channel: number, percentage, or missing.
 *
 * @param {string} text
 * @returns {number} 0..1
 */
function weGlassAlphaValue(text) {
  const raw = String(text).trim()
  if (!raw) {
    return 1
  }
  const percent = raw.charAt(raw.length - 1) === '%'
  const number = Number(percent ? raw.slice(0, -1) : raw)
  if (!isFinite(number)) {
    return 1
  }
  const value = percent ? number / 100 : number
  return Math.min(1, Math.max(0, value))
}

/**
 * Parse anything a host may hand us into `{r, g, b, a}`.
 *
 * Never throws and never guesses: `null` means "no usable colour here", and every
 * caller treats that as "try the next source" rather than "assume grey".
 *
 * @param {*} input
 * @returns {{r: number, g: number, b: number, a: number}|null}
 */
function weGlassParseColor(input) {
  if (typeof input !== 'string') {
    return null
  }
  const text = input.trim().toLowerCase()
  if (WE_GLASS_NO_COLOR.indexOf(text) !== -1) {
    return null
  }
  if (Object.prototype.hasOwnProperty.call(WE_GLASS_NAMED_COLORS, text)) {
    const tuple = WE_GLASS_NAMED_COLORS[text]
    return { r: tuple[0], g: tuple[1], b: tuple[2], a: tuple[3] }
  }
  if (text.charAt(0) === '#') {
    return weGlassParseHex(text)
  }
  if (text.indexOf('hsl') === 0) {
    return weGlassParseHsl(text)
  }
  const match = /^rgba?\(([^)]*)\)$/.exec(text)
  if (!match) {
    return null
  }
  const split = weGlassSplitArgs(match[1])
  if (split.parts.length < 3) {
    return null
  }
  const r = weGlassChannel(split.parts[0], 255)
  const g = weGlassChannel(split.parts[1], 255)
  const b = weGlassChannel(split.parts[2], 255)
  if (r === null || g === null || b === null) {
    return null
  }
  const alphaRaw = split.alpha === null ? split.parts[3] : split.alpha
  return { r, g, b, a: alphaRaw === undefined ? 1 : weGlassAlphaValue(alphaRaw) }
}

/**
 * `{r, g, b}` + alpha → the exact string we put on `<html>`. Formatting is
 * fixed (comma + one space) so two runs produce byte-identical attributes and
 * the self-write fingerprint stays comparable.
 *
 * @param {{r: number, g: number, b: number}} color
 * @param {number} alpha 0..1
 * @returns {string}
 */
function weGlassRgba(color, alpha) {
  const rgb = color || WE_GLASS_DEFAULT_BASE
  return (
    'rgba(' +
    Math.round(weGlassRange(rgb.r, 0, 255, 0)) +
    ', ' +
    Math.round(weGlassRange(rgb.g, 0, 255, 0)) +
    ', ' +
    Math.round(weGlassRange(rgb.b, 0, 255, 0)) +
    ', ' +
    weGlassTrim(weGlassRange(alpha, 0, 1, 1)) +
    ')'
  )
}

// --------------------------------------------------------------------------- //
// token resolution
//
// A custom property can be declared inline on `<html>`, by a stylesheet rule on
// `:root`, or as a chain (`--ui-bg-chrome: var(--accent)`), and a host may or may
// not resolve any of it for us. This section reads *all three* sources and
// follows `var()` itself, because:
//   - jsdom's `getComputedStyle(div).backgroundColor` does not resolve `var()`
//     (verified: returns `rgba(0, 0, 0, 0)` for `background: var(--x)`), and
//   - jsdom's computed custom property *does* honour the stylesheet but returns a
//     chained value verbatim (`var(--accent)`).
// Both are measured, not assumed — see the T2.4 report.
// --------------------------------------------------------------------------- //

/**
 * Read the raw declaration text of one custom property from the document, in
 * precedence order: inline on `<html>` → computed → stylesheet.
 *
 * @param {string} token
 * @param {{doc: Document|null, win: Window|null}} env
 * @returns {string|null} raw text, exactly as declared
 */
function weGlassReadToken(token, env) {
  const doc = env && env.doc
  if (!doc || typeof token !== 'string' || token.indexOf('--') !== 0) {
    return null
  }
  const root = doc.documentElement
  // 1. inline — the value whose exact spelling we must be able to restore.
  try {
    if (root && root.style && typeof root.style.getPropertyValue === 'function') {
      const inline = root.style.getPropertyValue(token)
      if (inline && inline.trim()) {
        return inline.trim()
      }
    }
  } catch (error) {
    // fall through to the next source
  }
  // 2. computed — the host's own resolution (browsers substitute, jsdom gives the
  //    stylesheet text; both are useful).
  try {
    const win = env.win || (doc.defaultView || null)
    if (win && root && typeof win.getComputedStyle === 'function') {
      const computed = win.getComputedStyle(root).getPropertyValue(token)
      if (computed && computed.trim()) {
        return computed.trim()
      }
    }
  } catch (error) {
    // fall through to the stylesheet
  }
  // 3. stylesheet — for hosts whose computed style drops unknown properties.
  return weGlassReadSheet(token, doc)
}

/**
 * Walk `document.styleSheets` for the first declaration of `token`, preferring a
 * `:root`/`html` rule. Nested rule lists (`@media`, `@supports`, `@layer`) are
 * followed one level at a time; a cross-origin sheet throws on `.cssRules` and is
 * skipped (it cannot affect us anyway, its declarations are not readable).
 *
 * @param {string} token
 * @param {Document} doc
 * @returns {string|null}
 */
function weGlassReadSheet(token, doc) {
  const sheets = doc && doc.styleSheets
  if (!sheets || typeof sheets.length !== 'number') {
    return null
  }
  let loose = null
  const visit = function visit(rules, depth) {
    if (!rules || depth > 4) {
      return null
    }
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      if (!rule) {
        continue
      }
      if (rule.style && typeof rule.style.getPropertyValue === 'function') {
        const value = rule.style.getPropertyValue(token)
        if (value && value.trim()) {
          const selector = String(rule.selectorText || '')
          if (selector.indexOf(':root') !== -1 || selector.indexOf('html') !== -1) {
            return value.trim()
          }
          if (loose === null) {
            loose = value.trim()
          }
        }
      }
      if (rule.cssRules) {
        const nested = visit(rule.cssRules, depth + 1)
        if (nested) {
          return nested
        }
      }
    }
    return null
  }
  for (let index = 0; index < sheets.length; index += 1) {
    try {
      const found = visit(sheets[index].cssRules, 0)
      if (found) {
        return found
      }
    } catch (error) {
      // cross-origin or otherwise unreadable sheet — skip it
    }
  }
  return loose
}

/**
 * Resolve `var(--x, fallback)` (recursively) down to a concrete value.
 *
 * @param {*} value raw declaration text
 * @param {{doc: Document|null, win: Window|null}} env
 * @param {number} [depth]
 * @param {Set<string>} [seen] cycle guard
 * @returns {string|null}
 */
function weGlassResolveValue(value, env, depth, seen) {
  const level = depth === undefined ? 0 : depth
  const guard = seen || new Set()
  if (value === null || value === undefined || level > WE_GLASS_VAR_DEPTH) {
    return null
  }
  const text = String(value).trim()
  if (!text) {
    return null
  }
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/.exec(text)
  if (!match) {
    return text
  }
  const token = match[1]
  const inlineFallback = match[2] === undefined ? null : match[2].trim()
  if (guard.has(token)) {
    // `--a: var(--b); --b: var(--a)` — a theme bug we must not spin on.
    return inlineFallback
  }
  guard.add(token)
  const next = weGlassReadToken(token, env)
  if (next === null) {
    return inlineFallback === null ? null : weGlassResolveValue(inlineFallback, env, level + 1, guard)
  }
  return weGlassResolveValue(next, env, level + 1, guard)
}

// --------------------------------------------------------------------------- //
// base-colour probe (§8.2 step 1)
// --------------------------------------------------------------------------- //

/**
 * Measure the chrome colour the theme is currently painting.
 *
 * Four sources, cheapest and most faithful first; the first one that yields a
 * visible colour wins and is reported as `source` so a host mismatch is
 * diagnosable:
 *
 *   1. `probe-div`       — a temp `<div style="background: var(--ui-bg-chrome)">`
 *                          inserted into `<body>`, `getComputedStyle` read,
 *                          element removed. This is §8.2 step 1 verbatim and it
 *                          is the only source that honours the cascade
 *                          (`.dark #app { --ui-bg-chrome: … }` included).
 *   2. `computed-token`  — `getComputedStyle` of `<html>`, custom property.
 *                          Browsers resolve it; jsdom resolves stylesheet
 *                          declarations but not `var()` chains.
 *   3. `stylesheet`      — a `var()`-resolved declaration found by walking
 *                          `document.styleSheets` (the jsdom path).
 *   4. `default`         — `WE_GLASS_DEFAULT_BASE`, flagged so nobody mistakes a
 *                          guess for a measurement.
 *
 * Tokens we are currently overriding are skipped in steps 2/3, so a recompute can
 * never read back its own `rgba()` and drift (§8.2 note "不叠加").
 *
 * @param {{doc: Document|null, win: Window|null}} env
 * @returns {{r: number, g: number, b: number, a: number, source: string, token: string|null, tried: Array<{token: string, value: string}>}}
 */
function weGlassProbeBaseColor(env) {
  const doc = env && env.doc
  const win = env && env.win
  const tried = []
  const record = function record(token, value) {
    if (tried.length < 12) {
      tried.push({ token, value: value === null || value === undefined ? '' : String(value) })
    }
  }
  const usable = function usable(parsed) {
    return !!parsed && parsed.a > 0
  }

  // 1. the probe div (§8.2 step 1)
  if (doc && win && typeof win.getComputedStyle === 'function') {
    let probe = null
    try {
      probe = doc.createElement('div')
      probe.setAttribute('aria-hidden', 'true')
      probe.setAttribute('data-we-glass-probe', '')
      probe.style.position = 'absolute'
      probe.style.width = '0'
      probe.style.height = '0'
      probe.style.opacity = '0'
      probe.style.pointerEvents = 'none'
      probe.style.background = 'var(' + WE_GLASS_CHROME_VAR + ')'
      const host = doc.body || doc.documentElement
      if (host) {
        host.appendChild(probe)
        const computed = win.getComputedStyle(probe)
        const raw = computed ? computed.backgroundColor : ''
        record('probe-div', raw)
        const parsed = weGlassParseColor(raw)
        if (usable(parsed)) {
          return { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a, source: 'probe-div', token: WE_GLASS_CHROME_VAR, tried }
        }
      }
    } catch (error) {
      record('probe-div', 'error: ' + String(error && error.message ? error.message : error))
    } finally {
      try {
        if (probe && probe.parentNode) {
          probe.parentNode.removeChild(probe)
        }
      } catch (error) {
        // a detached probe is harmless
      }
    }
  }

  // 2/3. tokens: computed, then any `var()` chain we have to follow ourselves
  const candidates = []
  for (const token of WE_GLASS_PROBE_CHAIN) {
    candidates.push(token)
  }
  for (const descriptor of weGlassVars({ includeDisabled: true })) {
    if (candidates.indexOf(descriptor.token) === -1) {
      candidates.push(descriptor.token)
    }
  }
  for (const token of candidates) {
    if (weGlassState.applied[token] !== undefined && weGlassState.applied[token] !== null) {
      // our own override — reading it back would compound our tint
      continue
    }
    const raw = weGlassReadToken(token, env)
    if (raw === null) {
      record(token, '')
      continue
    }
    const resolved = weGlassResolveValue(raw, env, 0, new Set())
    record(token, resolved === null ? raw : resolved)
    const parsed = weGlassParseColor(resolved)
    if (usable(parsed)) {
      return { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a, source: 'computed-token', token, tried }
    }
  }

  return {
    r: WE_GLASS_DEFAULT_BASE.r,
    g: WE_GLASS_DEFAULT_BASE.g,
    b: WE_GLASS_DEFAULT_BASE.b,
    a: WE_GLASS_DEFAULT_BASE.a,
    source: 'default',
    token: null,
    tried,
  }
}

// --------------------------------------------------------------------------- //
// GLASS_VARS access
// --------------------------------------------------------------------------- //

/** Runtime additions from a measured host (PV-2 path). Kept out of the frozen
 *  design list so the shipped list stays exactly the design's two seams. */
const weGlassExtraVars = []

/**
 * The token list in force. `GLASS_VARS` plus anything registered at runtime,
 * optionally including the disabled/pending descriptors (diagnostics want them).
 *
 * @param {{enabledOnly?: boolean, includeDisabled?: boolean}} [options]
 * @returns {WeGlassVar[]}
 */
function weGlassVars(options) {
  const opts = options || {}
  const list = []
  for (const descriptor of GLASS_VARS) {
    list.push(descriptor)
  }
  for (const descriptor of weGlassExtraVars) {
    list.push(descriptor)
  }
  const enabledOnly = opts.enabledOnly !== false && opts.includeDisabled !== true
  return enabledOnly
    ? list.filter(function keep(descriptor) {
        return descriptor.enabled === true
      })
    : list
}

/**
 * Register a measured extra token (the PV-2 escape hatch, §8.3). Rejects
 * anything that is not a `--custom-property` name and refuses to shadow a
 * descriptor that already exists.
 *
 * @param {{id?: string, token: string, setting?: string, floor?: number, enabled?: boolean, note?: string}} descriptor
 * @returns {WeGlassVar|null} the stored descriptor, or null when rejected
 */
function weGlassRegisterVar(descriptor) {
  if (!descriptor || typeof descriptor.token !== 'string' || descriptor.token.indexOf('--') !== 0) {
    return null
  }
  const exists = weGlassVars({ includeDisabled: true }).some(function same(entry) {
    return entry.token === descriptor.token
  })
  if (exists) {
    return null
  }
  const stored = Object.freeze({
    id: typeof descriptor.id === 'string' && descriptor.id ? descriptor.id : descriptor.token.replace(/^--/, ''),
    token: descriptor.token,
    setting: typeof descriptor.setting === 'string' && descriptor.setting ? descriptor.setting : 'cardBase',
    floor: weGlassRange(descriptor.floor, 0, 100, 0),
    status: WE_GLASS_STATUS.PENDING,
    enabled: descriptor.enabled === true,
    note: typeof descriptor.note === 'string' ? descriptor.note : 'runtime-registered',
  })
  weGlassExtraVars.push(stored)
  return stored
}

// --------------------------------------------------------------------------- //
// inline snapshot (§8.2 step 2)
// --------------------------------------------------------------------------- //

/**
 * Baseline for one token: the *original inline value*, verbatim. `present: false`
 * with `value: ''` is a first-class result — "there was no inline value" — and is
 * exactly what makes T11b pass (restoring it is a `removeProperty`, not an opaque
 * `rgba()`).
 *
 * @param {string} token
 * @param {Document|null} doc
 * @returns {{present: boolean, value: string}}
 */
function weGlassSnapshotToken(token, doc) {
  let value = ''
  try {
    const root = doc && doc.documentElement
    if (root && root.style && typeof root.style.getPropertyValue === 'function') {
      value = root.style.getPropertyValue(token) || ''
    }
  } catch (error) {
    value = ''
  }
  return { present: value.trim() !== '', value }
}

/**
 * Take (or refresh) the baseline for every token in `list`. A token whose
 * baseline is already known keeps it: re-snapshotting while our own override is
 * in place would record `rgba(…)` as "the original" and lose the theme value —
 * the exact failure §8.2's step-2 warning describes. `weGlassRefresh` calls
 * `weGlassResyncBaseline` first, which only re-baselines tokens an *external*
 * writer touched.
 *
 * @param {WeGlassVar[]} list
 * @param {Document|null} doc
 * @param {{force?: boolean}} [options]
 * @returns {number} how many baselines were recorded
 */
function weGlassSnapshotTokens(list, doc, options) {
  const force = !!(options && options.force)
  let recorded = 0
  for (const descriptor of list) {
    const token = descriptor.token
    if (!force && weGlassState.snapshot[token]) {
      continue
    }
    weGlassState.snapshot[token] = weGlassSnapshotToken(token, doc)
    recorded += 1
  }
  return recorded
}

/**
 * Re-baseline a token only when somebody else overwrote our value, i.e. the
 * inline value is no longer what we wrote. That is the one case where "the
 * current inline value" really is a new original (§8.2 note).
 *
 * @param {WeGlassVar[]} list
 * @param {Document|null} doc
 * @returns {string[]} tokens that were re-baselined
 */
function weGlassResyncBaseline(list, doc) {
  const root = doc && doc.documentElement
  const touched = []
  if (!root || !root.style) {
    return touched
  }
  for (const descriptor of list) {
    const token = descriptor.token
    const ours = weGlassState.applied[token]
    if (ours === undefined || ours === null) {
      continue
    }
    const current = root.style.getPropertyValue(token) || ''
    if (!weGlassSameValue(current, ours)) {
      weGlassState.snapshot[token] = { present: current.trim() !== '', value: current }
      touched.push(token)
    }
  }
  return touched
}

// --------------------------------------------------------------------------- //
// write / delete / restore (§8.2 steps 3/5/6)
// --------------------------------------------------------------------------- //

/**
 * Put one token back to its baseline. For a token that had no inline value this
 * is a plain `removeProperty` — the "纯净分支" of §8.2 step 5.
 *
 * @param {string} token
 * @param {Document|null} doc
 * @returns {string} what the inline value is now ('' = absent)
 */
function weGlassRestoreToken(token, doc) {
  const root = doc && doc.documentElement
  let after = ''
  if (!root || !root.style) {
    return after
  }
  const baseline = weGlassState.snapshot[token]
  try {
    if (baseline && baseline.present) {
      root.style.setProperty(token, baseline.value)
    } else {
      root.style.removeProperty(token)
    }
  } catch (error) {
    weGlassState.error = error
  }
  try {
    after = root.style.getPropertyValue(token) || ''
  } catch (error) {
    after = ''
  }
  delete weGlassState.applied[token]
  return after
}

/**
 * The alpha a descriptor should render at, or `null` for the clean branch.
 *
 * `null` covers all three "leave the theme alone" cases from §8.2 step 5 and
 * §7.6: the slider is at/above 100 (opaque = original), the value is below the
 * tier's floor ("低于该档下限不渲染", §8.4), or the field is not a usable number.
 *
 * @param {WeGlassVar} descriptor
 * @param {*} raw the setting value
 * @returns {number|null}
 */
function weGlassAlphaFor(descriptor, raw) {
  const value = weGlassNumber(raw, null)
  if (value === null) {
    return null
  }
  const percent = Math.min(100, Math.max(0, value))
  if (percent >= 100) {
    return null
  }
  if (percent < weGlassRange(descriptor.floor, 0, 100, 0)) {
    return null
  }
  return Math.round((percent / 100) * 1000) / 1000
}

/**
 * Compute + write every enabled token. Writes only when the value actually
 * changes, and records the resulting `style` attribute as the self-write
 * fingerprint the observer uses (§8.2 step 4 loop guard).
 *
 * @param {WeGlassVar[]} list
 * @param {*} settings
 * @param {{doc: Document|null}} env
 * @param {{r: number, g: number, b: number}} base
 * @returns {Array<{id: string, token: string, mode: string, value: string|null, alpha: number|null}>}
 */
function weGlassWriteVars(list, settings, env, base) {
  const doc = env.doc
  const root = doc && doc.documentElement
  const report = []
  for (const descriptor of list) {
    const token = descriptor.token
    const alpha = weGlassAlphaFor(descriptor, settings ? settings[descriptor.setting] : undefined)
    const target = alpha === null ? null : weGlassRgba(base, alpha)
    const previous = weGlassState.applied[token]
    const previousValue = previous === undefined ? null : previous
    const unchanged = target === null ? previousValue === null : previousValue !== null && weGlassSameValue(previousValue, target)
    if (!unchanged) {
      if (target === null) {
        weGlassRestoreToken(token, doc)
      } else {
        try {
          if (root && root.style) {
            root.style.setProperty(token, target)
            weGlassState.applied[token] = target
          }
        } catch (error) {
          weGlassState.error = error
        }
      }
    }
    const live = token in weGlassState.applied && weGlassState.applied[token] !== null
    report.push({
      id: descriptor.id,
      token,
      mode: alpha === null ? 'clean' : 'covered',
      value: live ? weGlassState.applied[token] : null,
      alpha,
    })
  }
  try {
    weGlassState.styleMark = root && root.getAttribute ? root.getAttribute('style') || '' : null
  } catch (error) {
    weGlassState.styleMark = null
  }
  return report
}

// --------------------------------------------------------------------------- //
// wallpaper filter parameters (§8.2 step 7 — computed here, applied by 10-layer)
// --------------------------------------------------------------------------- //

/**
 * The filter/opacity/scrim bundle for the wallpaper layer.
 *
 * Pure: no DOM, no store write, no side effects — 10-layer.js calls this and owns
 * the element. Numbers are percent-valued in `settings` (0–200 for
 * brightness/contrast/saturate, 0–40 px blur, 0–100 opacity) and `scrim` is
 * already a 0–0.9 fraction, per `dashboard/config.py` SETTINGS_DEFAULTS — *not*
 * the 0–90 percent the design's slider label suggests; the backend's wire value is
 * the fraction (config.py `_NUMERIC_RANGES`).
 *
 * `blur(0px)` is omitted rather than emitted: a zero-radius blur still promotes
 * the element to its own compositing layer, which costs GPU memory for nothing.
 *
 * @param {Object} [settings] `config.settings`; falls back to the store's
 * @returns {{filter: string, brightness: number, contrast: number, saturate: number, blurPx: number, opacity: number, scrim: number, scrimColor: string, objectFit: string, transition: string, key: string}}
 */
function weGlassFilters(settings) {
  const source = settings && typeof settings === 'object' ? settings : weGlassSettings()
  const brightness = weGlassRange(source.brightness, 0, 200, 100) / 100
  const contrast = weGlassRange(source.contrast, 0, 200, 100) / 100
  const saturate = weGlassRange(source.saturate, 0, 200, 100) / 100
  const blurPx = weGlassRange(source.wallpaperBlur, 0, 40, 0)
  const opacity = weGlassRange(source.wallpaperOpacity, 0, 100, 100) / 100
  const scrim = weGlassRange(source.scrim, 0, 0.9, 0.25)
  const steps = [
    'brightness(' + weGlassTrim(brightness) + ')',
    'contrast(' + weGlassTrim(contrast) + ')',
    'saturate(' + weGlassTrim(saturate) + ')',
  ]
  if (blurPx > 0) {
    steps.push('blur(' + weGlassTrim(blurPx) + 'px)')
  }
  const filter = steps.join(' ')
  const objectFit =
    source.objectFit === 'contain' || source.objectFit === 'fill' || source.objectFit === 'cover' ? source.objectFit : 'cover'
  const transition = source.switchTransition === 'cut' ? 'cut' : 'fade'
  const bundle = {
    filter,
    brightness,
    contrast,
    saturate,
    blurPx,
    opacity,
    scrim,
    scrimColor: 'rgba(0, 0, 0, ' + weGlassTrim(scrim) + ')',
    objectFit,
    transition,
  }
  bundle.key = filter + '|' + weGlassTrim(opacity) + '|' + weGlassTrim(scrim) + '|' + objectFit + '|' + transition
  return bundle
}

/**
 * `config.settings` from the store, or `{}` so every consumer degrades to the
 * neutral values instead of throwing before the first `GET /config` lands.
 *
 * @param {WeStoreState} [state]
 * @returns {Object}
 */
function weGlassSettings(state) {
  const snapshot = state || (typeof weGetState === 'function' ? weGetState() : null)
  const settings = snapshot && snapshot.config ? snapshot.config.settings : null
  return settings && typeof settings === 'object' ? settings : {}
}

/**
 * Which settings a re-render must react to. Used to skip pointless work when an
 * unrelated field (say `videoVolume`) is PUT.
 *
 * @param {*} settings
 * @returns {string}
 */
function weGlassSignature(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const keys = [
    'enabled',
    'panelBase',
    'cardBase',
    'brightness',
    'contrast',
    'saturate',
    'wallpaperBlur',
    'wallpaperOpacity',
    'scrim',
    'objectFit',
    'switchTransition',
  ]
  return keys
    .map(function pair(key) {
      return key + '=' + String(source[key])
    })
    .join('|')
}

// --------------------------------------------------------------------------- //
// apply / refresh / restore
// --------------------------------------------------------------------------- //

/**
 * Compute and write the glass tokens for one settings object.
 *
 * `enabled === false` (§7.6) and "nothing enabled" both end in the clean branch
 * for every token: the wallpaper layer goes away and the theme gets its tokens
 * back.
 *
 * @param {*} [ctx]
 * @param {Object} [settings] defaults to the store's `config.settings`
 * @returns {{ok: boolean, reason: string, base: Object|null, vars: Array, filters: Object|null, error: *}}
 */
function weGlassApply(ctx, settings) {
  const env = weGlassEnv(ctx)
  weGlassState.env = env
  const source = settings && typeof settings === 'object' ? settings : weGlassSettings()
  weGlassState.filters = weGlassFilters(source)
  try {
    if (!env.doc || !env.doc.documentElement) {
      return { ok: false, reason: 'no-document', base: null, vars: [], filters: weGlassState.filters, error: weGlassState.error }
    }
    const enabled = source.enabled !== false
    const list = enabled ? weGlassVars({ enabledOnly: true }) : []
    // Baseline first, override second — §8.2 step 2 before step 3, always.
    weGlassSnapshotTokens(list, env.doc)
    if (!enabled) {
      // disabled: nothing is ours any more, put every known token back
      const all = weGlassVars({ includeDisabled: true })
      const restored = []
      for (const descriptor of all) {
        if (descriptor.token in weGlassState.applied) {
          restored.push({ id: descriptor.id, token: descriptor.token, mode: 'clean', value: null, alpha: null })
          weGlassRestoreToken(descriptor.token, env.doc)
        }
      }
      weGlassState.signature = weGlassSignature(source)
      weGlassState.runs += 1
      return { ok: true, reason: 'disabled', base: weGlassState.base, vars: restored, filters: weGlassState.filters, error: null }
    }
    const base = weGlassProbeBaseColor(env)
    weGlassState.base = base
    const report = weGlassWriteVars(list, source, env, base)
    weGlassState.signature = weGlassSignature(source)
    weGlassState.runs += 1
    weGlassState.error = null
    return { ok: true, reason: 'applied', base, vars: report, filters: weGlassState.filters, error: null }
  } catch (error) {
    // never reach a React boundary (§5.4)
    weGlassState.error = error
    return { ok: false, reason: 'error', base: weGlassState.base, vars: [], filters: weGlassState.filters, error }
  }
}

/**
 * Recompute after a theme change (§8.2 step 4).
 *
 * The order matters and is the whole point of the "不叠加" note:
 *   1. re-baseline only tokens an external writer changed,
 *   2. re-probe the base colour from the *theme* (never from our own rgba),
 *   3. rewrite with today's parameters.
 *
 * @param {*} [ctx]
 * @param {string} [reason]
 * @returns {Object} the `weGlassApply` result
 */
function weGlassRefresh(ctx, reason) {
  const env = weGlassEnv(ctx)
  try {
    if (env.doc && env.doc.documentElement) {
      const list = weGlassVars({ includeDisabled: true })
      weGlassResyncBaseline(list, env.doc)
    }
  } catch (error) {
    weGlassState.error = error
  }
  const result = weGlassApply(ctx, weGlassSettings())
  result.reason = reason || 'refresh'
  return result
}

/**
 * Put every token back and forget the baselines. This is what teardown and the
 * `enabled: false` path both call; after it the inline values are exactly the
 * ones that were there before our first write (T11c).
 *
 * @param {*} [ctx]
 * @returns {{restored: string[]}}
 */
function weGlassRestore(ctx) {
  const env = weGlassEnv(ctx)
  const restored = []
  const tokens = Object.keys(weGlassState.applied)
  for (const token of weGlassVars({ includeDisabled: true }).map(function tokenOf(descriptor) {
    return descriptor.token
  })) {
    if (tokens.indexOf(token) === -1 && !weGlassState.snapshot[token]) {
      continue
    }
    weGlassRestoreToken(token, env.doc)
    restored.push(token)
  }
  for (const token of tokens) {
    if (restored.indexOf(token) === -1) {
      weGlassRestoreToken(token, env.doc)
      restored.push(token)
    }
  }
  weGlassState.snapshot = Object.create(null)
  weGlassState.applied = Object.create(null)
  weGlassState.base = null
  weGlassState.filters = null
  weGlassState.signature = ''
  weGlassState.styleMark = env.doc && env.doc.documentElement ? env.doc.documentElement.getAttribute('style') || '' : null
  return { restored }
}

// --------------------------------------------------------------------------- //
// theme observer + 200 ms coalescing (§8.2 step 4)
// --------------------------------------------------------------------------- //

/**
 * Schedule one recompute, at most one per `WE_GLASS_THROTTLE_MS`.
 *
 * Coalescing is trailing-only: the first mutation opens a 200 ms window, every
 * mutation inside it is absorbed, and one recompute runs when it closes. A theme
 * flip that touches `class` *and* `data-theme` *and* `style` therefore costs one
 * probe, not three.
 *
 * The timer is `ctx.setTimeout(fn, ms)`, whose return value is a disposer (F22 —
 * flat timer methods, no `ctx` timer object). A host without it falls back to the
 * window's own `setTimeout` so the renderer degrades instead of dying.
 *
 * @param {string} reason
 * @returns {boolean} whether a run is pending
 */
function weGlassSchedule(reason) {
  if (weGlassState.timer) {
    weGlassState.timerReason = reason
    return true
  }
  const env = weGlassState.env || weGlassEnv()
  const ctx = weGlassState.ctx
  const fire = function fire() {
    weGlassState.timer = null
    const pending = weGlassState.timerReason || reason
    weGlassState.timerReason = ''
    try {
      weGlassRefresh(ctx, pending)
    } catch (error) {
      weGlassState.error = error
    }
  }
  let dispose = null
  try {
    if (ctx && typeof ctx.setTimeout === 'function') {
      const handle = ctx.setTimeout(fire, WE_GLASS_THROTTLE_MS)
      if (typeof handle === 'function') {
        dispose = handle
      } else if (handle !== undefined && handle !== null && typeof ctx.clearTimeout === 'function') {
        // a host that hands back an id instead of a disposer still gets cancelled
        dispose = function cancel() {
          ctx.clearTimeout(handle)
        }
      }
    } else if (env.win && typeof env.win.setTimeout === 'function') {
      const handle = env.win.setTimeout(fire, WE_GLASS_THROTTLE_MS)
      dispose = function cancel() {
        env.win.clearTimeout(handle)
      }
    }
  } catch (error) {
    weGlassState.error = error
    dispose = null
  }
  if (!dispose) {
    // No timer surface at all: recompute synchronously rather than drop a theme
    // flip on the floor.
    fire()
    return false
  }
  weGlassState.timer = { dispose }
  weGlassState.timerReason = reason
  return true
}

/** Cancel a pending coalesced run (teardown, or a test that wants determinism). */
function weGlassCancel() {
  if (!weGlassState.timer) {
    return false
  }
  try {
    weGlassState.timer.dispose()
  } catch (error) {
    weGlassState.error = error
  }
  weGlassState.timer = null
  weGlassState.timerReason = ''
  return true
}

/**
 * Is this mutation batch our own write? `style.setProperty` on `<html>` fires a
 * `style` record just like a theme change does, so without this the observer
 * would re-trigger itself forever. The fingerprint is the `style` attribute we
 * left behind: if the only thing that changed is `style` and it still equals that
 * fingerprint, nobody else touched anything.
 *
 * @param {MutationRecord[]} records
 * @param {Document|null} doc
 * @returns {boolean}
 */
function weGlassIsSelfWrite(records, doc) {
  if (!records || records.length === 0 || weGlassState.styleMark === null) {
    return false
  }
  for (const record of records) {
    if (record.attributeName !== 'style') {
      return false
    }
  }
  try {
    const root = doc && doc.documentElement
    const current = root && root.getAttribute ? root.getAttribute('style') || '' : null
    return current !== null && weGlassSameValue(current, weGlassState.styleMark)
  } catch (error) {
    return false
  }
}

/**
 * Observe `<html>` for a theme flip. `attributeFilter` keeps the callback off the
 * hot path: only `class`, `style` and `data-theme` can change what
 * `--ui-bg-chrome` resolves to.
 *
 * @param {{doc: Document|null, win: Window|null}} env
 * @returns {MutationObserver|null}
 */
function weGlassObserve(env) {
  const win = env && env.win
  const doc = env && env.doc
  const root = doc && doc.documentElement
  if (!win || !root || typeof win.MutationObserver !== 'function') {
    return null
  }
  const observer = new win.MutationObserver(function onMutations(records) {
    if (weGlassIsSelfWrite(records, doc)) {
      return
    }
    weGlassSchedule('theme-change')
  })
  observer.observe(root, { attributes: true, attributeFilter: WE_GLASS_THEME_ATTRS.slice() })
  return observer
}

// --------------------------------------------------------------------------- //
// store glue + lifecycle
// --------------------------------------------------------------------------- //

/**
 * Keep the glass in step with `config.settings`. The store is the single source of
 * truth (§4), so a PUT response that lands (including a clamp the panel did not
 * expect) reaches the tokens through this subscription rather than through the
 * panel calling us by hand.
 *
 * @param {*} ctx
 * @returns {() => void} disposer
 */
function weGlassAutoApply(ctx) {
  if (typeof weSubscribe !== 'function') {
    return function noop() {}
  }
  return weSubscribe(function onStore(state) {
    const settings = state && state.config ? state.config.settings : null
    if (weGlassSignature(settings) === weGlassState.signature) {
      return
    }
    weGlassApply(ctx, settings || {})
  })
}

/**
 * Boot the engine: apply once, observe the theme, subscribe to the store.
 *
 * Idempotent — calling it twice tears the first instance down first, so a hot
 * reload cannot leave two observers fighting over the same attribute.
 *
 * @param {*} ctx needs `setTimeout` (F22) and optionally `document`/`window`
 * @returns {() => void} disposer (identical to `weGlassStop`)
 */
function weGlassStart(ctx) {
  weGlassTeardown(false)
  const env = weGlassEnv(ctx)
  weGlassState.ctx = ctx || null
  weGlassState.env = env
  weGlassApply(ctx, weGlassSettings())
  // Tell 10-layer's stylesheet fallback to stand down: from here on the tokens
  // are ours, and its `!important transparent` rule would beat our inline
  // rgba tints (the 2026-10-22 "density slider does nothing" bug).
  weGlassMarkRoot(env, true)
  weGlassState.observer = weGlassObserve(env)
  weGlassState.unsubscribe = weGlassAutoApply(ctx)
  return weGlassStop
}

/**
 * Set / clear the `<html>` ownership marker. Never throws — a document that
 * refuses an attribute must not take the engine down.
 *
 * @param {{doc: Document|null}} env
 * @param {boolean} on
 * @returns {void}
 */
function weGlassMarkRoot(env, on) {
  const root = env && env.doc ? env.doc.documentElement : null
  if (!root || typeof root.setAttribute !== 'function') {
    return
  }
  try {
    if (on) {
      root.setAttribute(WE_GLASS_ROOT_ATTR, '')
    } else {
      root.removeAttribute(WE_GLASS_ROOT_ATTR)
    }
  } catch (error) {
    weGlassState.error = error
  }
}

/**
 * Detach everything but leave the DOM alone (used by `weGlassStart`'s restart).
 *
 * @param {boolean} restore whether to put the tokens back
 * @returns {void}
 */
function weGlassTeardown(restore) {
  if (weGlassState.observer) {
    try {
      weGlassState.observer.disconnect()
    } catch (error) {
      weGlassState.error = error
    }
    weGlassState.observer = null
  }
  if (typeof weGlassState.unsubscribe === 'function') {
    try {
      weGlassState.unsubscribe()
    } catch (error) {
      weGlassState.error = error
    }
    weGlassState.unsubscribe = null
  }
  weGlassCancel()
  if (restore) {
    weGlassRestore(weGlassState.ctx)
    weGlassMarkRoot(weGlassState.env, false)
  }
  weGlassState.ctx = null
}

/**
 * Full stop: detach and restore. This is what `ctx.onDispose` gets — after it the
 * inline tokens are byte-for-byte what they were before the first write, and the
 * theme owns them again (T11c).
 *
 * @returns {{restored: string[]}}
 */
function weGlassStop() {
  const result = weGlassRestore(weGlassState.ctx)
  weGlassMarkRoot(weGlassState.env, false)
  weGlassTeardown(false)
  return result
}

// --------------------------------------------------------------------------- //
// diagnostics
// --------------------------------------------------------------------------- //

/**
 * Internal state, copied for inspection. Tests read `runs`/`timer` here; the
 * appearance panel's diag block shows `base.source` and `error`.
 *
 * @returns {Object}
 */
function weGlassDiag() {
  return {
    started: weGlassState.ctx !== null,
    observing: weGlassState.observer !== null,
    pending: weGlassState.timer !== null,
    runs: weGlassState.runs,
    signature: weGlassState.signature,
    base: weGlassState.base,
    filters: weGlassState.filters,
    applied: { ...weGlassState.applied },
    snapshot: { ...weGlassState.snapshot },
    styleMark: weGlassState.styleMark,
    error: weGlassState.error,
  }
}

/**
 * [PV-2] measurement helper — the pair of eyes the design asks for.
 *
 * §8.3 wants `[data-chat-surface]`'s computed background inspected in DevTools
 * before trusting `--ui-chat-surface-background`. jsdom has no layout, so this
 * cannot be *proven* here; what this function does instead is run the same
 * comparison on whatever the host provides and report a verdict, which is how a
 * human (or the diag panel) decides whether to register an extra token with
 * `weGlassRegisterVar`.
 *
 * Verdicts:
 *   `no-element`      — this host has no `[data-chat-surface]` (or no DOM)
 *   `transparent`     — the card paints nothing itself; it inherits the surface,
 *                       so the documented token is right
 *   `matches-token`   — computed background equals `--ui-chat-surface-background`
 *   `independent-token` — it differs; find the real token name and register it
 *   `unreadable`      — `getComputedStyle` unavailable/blank
 *
 * Never writes anything.
 *
 * @param {*} [ctx]
 * @returns {{verdict: string, selector: string, computed: string, tokenValue: string|null, tokenColor: Object|null, computedColor: Object|null}}
 */
function weGlassMeasureChatSurface(ctx) {
  const env = weGlassEnv(ctx)
  const selector = '[data-chat-surface]'
  const report = {
    verdict: 'no-element',
    selector,
    computed: '',
    tokenValue: null,
    tokenColor: null,
    computedColor: null,
  }
  const doc = env && env.doc
  const win = env && env.win
  if (!doc || !win || typeof doc.querySelector !== 'function' || typeof win.getComputedStyle !== 'function') {
    report.verdict = 'no-element'
    return report
  }
  let element = null
  try {
    element = doc.querySelector(selector)
  } catch (error) {
    element = null
  }
  if (!element) {
    return report
  }
  try {
    report.computed = (win.getComputedStyle(element).backgroundColor || '').trim()
  } catch (error) {
    report.verdict = 'unreadable'
    return report
  }
  const raw = weGlassReadToken(WE_GLASS_CARD_VAR, env)
  report.tokenValue = raw
  report.tokenColor = weGlassParseColor(weGlassResolveValue(raw, env, 0, new Set()))
  report.computedColor = weGlassParseColor(report.computed)
  if (!report.computed || !report.computedColor) {
    report.verdict = 'unreadable'
    return report
  }
  if (report.computedColor.a === 0) {
    report.verdict = 'transparent'
    return report
  }
  const same =
    !!report.tokenColor &&
    report.tokenColor.r === report.computedColor.r &&
    report.tokenColor.g === report.computedColor.g &&
    report.tokenColor.b === report.computedColor.b
  report.verdict = same ? 'matches-token' : 'independent-token'
  return report
}
