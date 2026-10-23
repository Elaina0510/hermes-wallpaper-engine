/**
 * T2.4 — behaviour tests for `desktop/src/30-glass.js` (MOD-009).
 *
 * Run with:  node --test tests/frontend/30-glass.test.mjs
 *
 * How it loads the module: exactly the way the product runs — `00-core.js` and
 * `30-glass.js` are concatenated into ONE function scope (that is what
 * `desktop/build.py` does to `plugin.js`), with 00-core's single whitelisted
 * `react` import stripped and injected. So the harness proves the two files
 * actually collaborate through the shared scope, and that no top-level symbol
 * collides.
 *
 * jsdom/react come from the Hermes desktop tree's node_modules and are dev-only:
 * nothing here is imported by the plugin at runtime.
 *
 * ## What jsdom can and cannot prove (measured, not assumed)
 *
 * Verified against jsdom 29.1.1 while writing these tests:
 *   - `style.setProperty('--x', v)` / `getPropertyValue` / `removeProperty` on a
 *     custom property: **supported**, value kept verbatim (probe #1).
 *   - `getComputedStyle(documentElement).getPropertyValue('--x')`: **resolves**
 *     the stylesheet declaration, and the inline override wins over it; after
 *     `removeProperty` it falls back to the stylesheet value. So T15 is asserted
 *     through `getComputedStyle` for real, not faked via `style`.
 *   - `getComputedStyle(div).backgroundColor` for `background: var(--x)`:
 *     **NOT resolved** (returns `rgba(0, 0, 0, 0)`). That is why the probe has a
 *     documented fallback chain and why the `probe-div` source cannot be the one
 *     exercised here.
 *   - `MutationObserver`: supported, and our own `setProperty` writes do fire a
 *     `style` record — hence the self-write fingerprint test below.
 *   - Layout/`[data-chat-surface]` real-world colour: **not measurable here**
 *     (no layout engine), so [PV-2] is covered only at the verdict-logic level.
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
const GLASS_PATH = path.join(PLUGIN_ROOT, 'desktop', 'src', '30-glass.js')

const CORE_SOURCE = readFileSync(CORE_PATH, 'utf8')
const GLASS_SOURCE = readFileSync(GLASS_PATH, 'utf8')

// --------------------------------------------------------------------------- //
// dev-only dependency resolution (jsdom 29)
// --------------------------------------------------------------------------- //

const DEP_BASES = [
  process.env.WE_NODE_MODULES,
  path.join(PLUGIN_ROOT, '..', '..', 'hermes-agent'),
  path.join(PLUGIN_ROOT, '..', '..'),
  PLUGIN_ROOT,
].filter(Boolean)

function resolveJsdom() {
  const tried = []
  for (const base of DEP_BASES) {
    try {
      const req = createRequire(pathToFileURL(path.join(base, 'package.json')).href)
      return { JSDOM: req('jsdom').JSDOM, base }
    } catch (error) {
      tried.push(`${base}: ${error.message.split('\n')[0]}`)
    }
  }
  return { error: tried.join(' | ') }
}

const DEPS = resolveJsdom()

// --------------------------------------------------------------------------- //
// loading core + glass into one shared scope (what build.py produces)
// --------------------------------------------------------------------------- //

const IMPORT_RE = /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm

const SYMBOLS = [
  // 00-core
  'weGetState',
  'weSet',
  'weSubscribe',
  'weResetStore',
  'WE_BOOT',
  // 30-glass — constants
  'WE_GLASS_PANEL_VAR',
  'WE_GLASS_CARD_VAR',
  'WE_GLASS_CHROME_VAR',
  'WE_GLASS_ROOT_ATTR',
  'WE_GLASS_CARD_FLOOR',
  'WE_GLASS_THROTTLE_MS',
  'WE_GLASS_THEME_ATTRS',
  'WE_GLASS_PROBE_CHAIN',
  'WE_GLASS_DEFAULT_BASE',
  'WE_GLASS_STATUS',
  'GLASS_VARS',
  // 30-glass — pure helpers
  'weGlassNumber',
  'weGlassRange',
  'weGlassTrim',
  'weGlassSameValue',
  'weGlassParseColor',
  'weGlassRgba',
  'weGlassReadToken',
  'weGlassResolveValue',
  'weGlassProbeBaseColor',
  'weGlassVars',
  'weGlassRegisterVar',
  'weGlassSnapshotToken',
  'weGlassSnapshotTokens',
  'weGlassResyncBaseline',
  'weGlassRestoreToken',
  'weGlassAlphaFor',
  'weGlassWriteVars',
  'weGlassFilters',
  'weGlassSettings',
  'weGlassSignature',
  // 30-glass — lifecycle
  'weGlassApply',
  'weGlassRefresh',
  'weGlassRestore',
  'weGlassSchedule',
  'weGlassCancel',
  'weGlassIsSelfWrite',
  'weGlassObserve',
  'weGlassAutoApply',
  'weGlassStart',
  'weGlassStop',
  'weGlassDiag',
  'weGlassMeasureChatSurface',
  'weGlassMarkRoot',
]

/**
 * Evaluate core + glass in one `new Function` scope with a React stub injected.
 * A missing symbol fails loudly here instead of turning into a confusing
 * `undefined is not a function` deeper down.
 */
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

${GLASS_SOURCE}
return __names.reduce(function collect(acc, name) { acc[name] = eval(name); return acc }, {})`,
  )
  const reactStub = {
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  return factory(reactStub, SYMBOLS)
}

// --------------------------------------------------------------------------- //
// fixtures + ctx double
// --------------------------------------------------------------------------- //

const THEME_CSS = `
  :root {
    --ui-bg-chrome: rgb(18, 20, 24);
    --ui-bg-sidebar: rgb(30, 32, 38);
    --ui-chat-surface-background: rgb(44, 46, 52);
  }
`

function makeDom(options = {}) {
  if (!DEPS.JSDOM) {
    throw new Error(`jsdom is unavailable (dev-only): ${DEPS.error}`)
  }
  const html = `<!doctype html><html><head><style>${options.css === undefined ? THEME_CSS : options.css}</style></head>
<body>${options.body || ''}</body></html>`
  return new DEPS.JSDOM(html, { pretendToBeVisual: true })
}

/**
 * ctx double: the legal timer surface is flat and disposer-returning (F22), so
 * `setTimeout` records the call and returns a canceller. `flushTimers` plays the
 * event loop by hand, which is how the 200 ms coalescing is tested deterministically.
 */
function makeCtx(dom) {
  const timers = []
  const ctx = {
    document: dom.window.document,
    window: dom.window,
    storage: {
      get(key, fallback) {
        return fallback
      },
      set() {},
    },
    rest() {
      return Promise.resolve({ ok: true })
    },
    setTimeout(fn, ms) {
      const entry = { fn, ms, cancelled: false, fired: false }
      timers.push(entry)
      return function cancel() {
        entry.cancelled = true
      }
    },
  }
  return {
    ctx,
    timers,
    pending() {
      return timers.filter((entry) => !entry.cancelled && !entry.fired)
    },
    flush() {
      const due = timers.filter((entry) => !entry.cancelled && !entry.fired)
      for (const entry of due) {
        entry.fired = true
        entry.fn()
      }
      return due.length
    },
  }
}

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

function makeConfig(settingsOverrides = {}) {
  return { version: 2, currentId: null, settings: makeSettings(settingsOverrides) }
}

/** Let MutationObserver deliver its microtask (and any real timer we scheduled). */
function settle(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inline(dom, token) {
  return dom.window.document.documentElement.style.getPropertyValue(token)
}

function computed(dom, token) {
  return dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue(token)
}

const squash = (value) => String(value === null || value === undefined ? '' : value).replace(/\s+/g, '').toLowerCase()

// --------------------------------------------------------------------------- //
// static shape: build.py rules 2/3 and F22, checked at the source
// --------------------------------------------------------------------------- //

test('T2.4 static: 30-glass.js has no import/export and no bare timer', () => {
  assert.equal(IMPORT_RE.test(GLASS_SOURCE), false, '30-glass.js must not import anything')
  IMPORT_RE.lastIndex = 0
  assert.equal(/\bimport\s*\(/.test(GLASS_SOURCE), false, 'no dynamic import() either')
  assert.equal(/^\s*export\b/m.test(GLASS_SOURCE), false, 'only 99-register.js may export')
  // F22: timers are flat ctx methods; there is no timer object to reach into.
  assert.equal(/ctx\s*\.\s*timer\b/.test(GLASS_SOURCE), false, 'ctx has no timer object (F22)')
  assert.match(GLASS_SOURCE, /ctx\.setTimeout/)
})

test('T2.4 static: every top-level symbol is we-prefixed or a pinned constant', () => {
  const declared = Array.from(GLASS_SOURCE.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)).map((m) => m[1])
  assert.ok(declared.length > 30, 'expected the module to declare its surface')
  const offenders = declared.filter(
    (name) => !/^we[A-Z]/.test(name) && !/^WE_[A-Z0-9_]+$/.test(name) && name !== 'GLASS_VARS',
  )
  assert.deepEqual(offenders, [], `symbols must be we-prefixed (build.py rule5): ${offenders.join(', ')}`)
})

// --------------------------------------------------------------------------- //
// GLASS_VARS — the two design seams + the [PV-2] slot
// --------------------------------------------------------------------------- //

test('T2.4 GLASS_VARS covers both §8.1 seams and carries the PV-2 slot unmeasured', () => {
  const product = loadProduct()
  const byToken = new Map(product.GLASS_VARS.map((entry) => [entry.token, entry]))

  const panel = byToken.get('--ui-bg-sidebar')
  assert.ok(panel, 'the shell seam token must be listed')
  assert.equal(panel.setting, 'panelBase')
  assert.equal(panel.floor, 0)
  assert.equal(panel.status, product.WE_GLASS_STATUS.VERIFIED)
  assert.equal(panel.enabled, true)

  const card = byToken.get('--ui-chat-surface-background')
  assert.ok(card, 'the chat-card seam token must be listed')
  assert.equal(card.setting, 'cardBase')
  assert.equal(card.floor, 0, 'cardBase floor is 0 (config.py _NUMERIC_RANGES, 2026-10-22)')
  assert.equal(card.status, product.WE_GLASS_STATUS.VERIFIED)
  assert.equal(card.enabled, true)

  const pending = product.GLASS_VARS.filter((entry) => entry.status === product.WE_GLASS_STATUS.PENDING)
  assert.equal(pending.length, 1, 'the [PV-2] candidate lives in the list, marked pending')
  assert.equal(pending[0].enabled, false, 'an unmeasured token must never be written')
  assert.match(pending[0].note, /PV-2/)

  const editor = byToken.get('--ui-editor-surface-background')
  assert.ok(editor, 'the editor pane surface must be listed — it is the only other solid surface')
  assert.equal(editor.setting, 'cardBase', 'it shares the card tier')
  assert.equal(editor.floor, 0)
  assert.equal(editor.status, product.WE_GLASS_STATUS.VERIFIED)
  assert.equal(editor.enabled, true)

  // the writable list is exactly the verified seams
  assert.deepEqual(
    product.weGlassVars({ enabledOnly: true }).map((entry) => entry.token),
    ['--ui-bg-sidebar', '--ui-chat-surface-background', '--ui-editor-surface-background'],
  )
  // diagnostics can still see everything
  assert.equal(product.weGlassVars({ includeDisabled: true }).length, 4)
})

test('T2.4 GLASS_VARS is extensible at runtime without touching the design list', () => {
  const product = loadProduct()
  assert.equal(product.weGlassRegisterVar({ token: '--ui-chat-surface' }), null, 'no shadowing an existing entry')
  assert.equal(product.weGlassRegisterVar({ token: 'not-a-custom-property' }), null, 'must be a -- token')
  assert.equal(product.weGlassRegisterVar(null), null)

  const stored = product.weGlassRegisterVar({
    id: 'surface',
    token: '--ui-surface-card',
    setting: 'cardBase',
    floor: 20,
    enabled: true,
  })
  assert.ok(stored)
  assert.equal(stored.status, product.WE_GLASS_STATUS.PENDING, 'runtime additions stay marked as measured-later')
  assert.deepEqual(
    product.weGlassVars({ enabledOnly: true }).map((entry) => entry.token),
    ['--ui-bg-sidebar', '--ui-chat-surface-background', '--ui-editor-surface-background', '--ui-surface-card'],
  )
})

// --------------------------------------------------------------------------- //
// colour parsing (the probe's whole input surface)
// --------------------------------------------------------------------------- //

test('T2.4 parse color: rgb/rgba/hex/keywords/percent, and every unusable form → null', () => {
  const { weGlassParseColor } = loadProduct()

  assert.deepEqual(weGlassParseColor('rgb(18, 20, 24)'), { r: 18, g: 20, b: 24, a: 1 })
  assert.deepEqual(weGlassParseColor('rgba(18, 20, 24, 0.55)'), { r: 18, g: 20, b: 24, a: 0.55 })
  assert.deepEqual(weGlassParseColor('RGB( 1 , 2 , 3 )'), { r: 1, g: 2, b: 3, a: 1 })
  // modern space syntax with a slash alpha
  assert.deepEqual(weGlassParseColor('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 })
  assert.deepEqual(weGlassParseColor('rgb(100% 0% 0%)'), { r: 255, g: 0, b: 0, a: 1 })
  assert.deepEqual(weGlassParseColor('#000'), { r: 0, g: 0, b: 0, a: 1 })
  assert.deepEqual(weGlassParseColor('#1e2028'), { r: 30, g: 32, b: 40, a: 1 })
  assert.deepEqual(weGlassParseColor('#1e202880'), { r: 30, g: 32, b: 40, a: 0.502 })
  assert.deepEqual(weGlassParseColor('rebeccapurple'), { r: 102, g: 51, b: 153, a: 1 })
  assert.deepEqual(weGlassParseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 })
  // `transparent` is a real colour with zero alpha — the probe rejects it via
  // `a > 0`, and [PV-2]'s verdict logic needs to be able to *see* it.
  assert.deepEqual(weGlassParseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 })

  // unusable, and honestly reported as such
  for (const bad of ['', '   ', 'currentcolor', 'initial', 'inherit', 'var(--x)', 'rgb()', 'rgb(a b c)', '#12', 'nonsense', null, undefined, 42, {}]) {
    assert.equal(weGlassParseColor(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('T2.4 rgba formatting is stable and clamped', () => {
  const { weGlassRgba } = loadProduct()
  assert.equal(weGlassRgba({ r: 18, g: 20, b: 24 }, 0.55), 'rgba(18, 20, 24, 0.55)')
  assert.equal(weGlassRgba({ r: 18, g: 20, b: 24 }, 100 / 100), 'rgba(18, 20, 24, 1)')
  assert.equal(weGlassRgba({ r: 999, g: -5, b: 12.6 }, 2), 'rgba(255, 0, 13, 1)')
  assert.equal(weGlassRgba({ r: 1, g: 2, b: 3 }, 1 / 3), 'rgba(1, 2, 3, 0.333)')
})

// --------------------------------------------------------------------------- //
// base-colour probe (§8.2 step 1) + its degradation ladder
// --------------------------------------------------------------------------- //

test('T2.4 probe: reads the theme value through computed custom property (jsdom path)', () => {
  const product = loadProduct()
  const dom = makeDom()
  const base = product.weGlassProbeBaseColor({ doc: dom.window.document, win: dom.window })

  assert.equal(base.source, 'computed-token')
  assert.equal(base.token, '--ui-bg-chrome')
  assert.deepEqual([base.r, base.g, base.b], [18, 20, 24])
  // the probe div is inserted and removed, never left behind
  assert.equal(dom.window.document.querySelectorAll('[data-we-glass-probe]').length, 0)
})

test('T2.4 probe: follows a var() chain the host does not resolve', () => {
  const product = loadProduct()
  const dom = makeDom({
    css: ':root { --accent: rgb(10, 20, 30); --ui-bg-chrome: var(--accent); }',
  })
  const base = product.weGlassProbeBaseColor({ doc: dom.window.document, win: dom.window })
  assert.deepEqual([base.r, base.g, base.b, base.source], [10, 20, 30, 'computed-token'])
})

test('T2.4 probe: a var() cycle terminates and falls through to the default', () => {
  const product = loadProduct()
  const dom = makeDom({ css: ':root { --ui-bg-chrome: var(--a); --a: var(--b); --b: var(--a); }' })
  const base = product.weGlassProbeBaseColor({ doc: dom.window.document, win: dom.window })
  assert.equal(base.source, 'default')
  assert.deepEqual([base.r, base.g, base.b], [24, 26, 30])
})

test('T2.4 probe: a token-less host degrades to the documented default, never throws', () => {
  const product = loadProduct()
  const dom = makeDom({ css: '' })
  const base = product.weGlassProbeBaseColor({ doc: dom.window.document, win: dom.window })
  assert.equal(base.source, 'default')
  assert.deepEqual([base.r, base.g, base.b, base.a], [24, 26, 30, 1])
  assert.ok(Array.isArray(base.tried))
  // and no document at all is a report, not an exception
  const empty = product.weGlassProbeBaseColor({ doc: null, win: null })
  assert.equal(empty.source, 'default')
})

// --------------------------------------------------------------------------- //
// T11b — the clean branch: delete, never rgba(...,1)
// --------------------------------------------------------------------------- //

test('T11b: panelBase=100 leaves the inline property EMPTY (delete branch, not rgba(...,1))', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)

  const result = product.weGlassApply(ctx, makeSettings({ panelBase: 100, cardBase: 100 }))
  assert.equal(result.ok, true)

  assert.equal(inline(dom, '--ui-bg-sidebar'), '', 'panel token must be deleted, not set to opaque')
  assert.equal(inline(dom, '--ui-chat-surface-background'), '', 'card token must be deleted too')
  assert.equal(inline(dom, '--ui-editor-surface-background'), '', 'the editor pane follows the same card tier')
  assert.equal(/rgba|rgb/.test(dom.window.document.documentElement.getAttribute('style') || ''), false)
  assert.deepEqual(result.vars.map((entry) => entry.mode), ['clean', 'clean', 'clean'])

  // the theme's own value is still what the user sees (T15's other half)
  assert.equal(squash(computed(dom, '--ui-bg-sidebar')), 'rgb(30,32,38)')
})

test('T11b: panelBase=100 after an override returns the token to the theme', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)

  product.weGlassApply(ctx, makeSettings({ panelBase: 55 }))
  assert.match(inline(dom, '--ui-bg-sidebar'), /^rgba\(18, 20, 24, 0\.55\)$/)

  product.weGlassApply(ctx, makeSettings({ panelBase: 100 }))
  assert.equal(inline(dom, '--ui-bg-sidebar'), '')
  assert.equal(squash(computed(dom, '--ui-bg-sidebar')), 'rgb(30,32,38)')
})

test('T11b: enabled=false clears every token we own (§7.6)', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)

  product.weGlassApply(ctx, makeSettings({ panelBase: 55, cardBase: 65 }))
  assert.notEqual(inline(dom, '--ui-bg-sidebar'), '')
  assert.notEqual(inline(dom, '--ui-chat-surface-background'), '')

  const off = product.weGlassApply(ctx, makeSettings({ enabled: false, panelBase: 55, cardBase: 65 }))
  assert.equal(off.reason, 'disabled')
  assert.equal(inline(dom, '--ui-bg-sidebar'), '')
  assert.equal(inline(dom, '--ui-chat-surface-background'), '')
})

test('T2.4 alpha mapping: cardBase below its floor renders nothing, 0 is fully transparent', () => {
  const product = loadProduct()
  const descriptor = product.weGlassVars({ enabledOnly: true }).find((entry) => entry.id === 'card')
  const panel = product.weGlassVars({ enabledOnly: true }).find((entry) => entry.id === 'panel')

  assert.equal(product.weGlassAlphaFor(panel, 0), 0, 'panelBase 0 = fully transparent, still an override')
  assert.equal(product.weGlassAlphaFor(panel, 55), 0.55)
  assert.equal(product.weGlassAlphaFor(panel, 100), null, 'clean branch')
  assert.equal(product.weGlassAlphaFor(panel, 140), null, 'out of range still clean')
  assert.equal(product.weGlassAlphaFor(descriptor, 20), 0.2)
  assert.equal(product.weGlassAlphaFor(descriptor, 19), 0.19, '19 is a rendered tier since 2026-10-22')
  assert.equal(product.weGlassAlphaFor(descriptor, 0), 0, '0 = fully transparent card, still an override')
  assert.equal(product.weGlassAlphaFor(descriptor, -5), 0, 'negative clamps to 0 before the floor check')
  assert.equal(product.weGlassAlphaFor(descriptor, undefined), null, 'no value = no opinion')
  assert.equal(product.weGlassAlphaFor(descriptor, 'garbage'), null)

  // and an out-of-range wire value must not produce rgba(...,1)
  const dom = makeDom()
  const { ctx } = makeCtx(dom)
  product.weGlassApply(ctx, makeSettings({ panelBase: 400 }))
  assert.equal(inline(dom, '--ui-bg-sidebar'), '')
})

// --------------------------------------------------------------------------- //
// T15 — the override is visible through getComputedStyle, and reverts
// --------------------------------------------------------------------------- //

test('T15: computed value becomes rgba(...) while overridden and reverts to the theme value', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)

  assert.equal(squash(computed(dom, '--ui-bg-sidebar')), 'rgb(30,32,38)', 'baseline: the theme value')

  product.weGlassApply(ctx, makeSettings({ panelBase: 55, cardBase: 45 }))
  assert.equal(squash(computed(dom, '--ui-bg-sidebar')), 'rgba(18,20,24,0.55)')
  assert.equal(squash(computed(dom, '--ui-chat-surface-background')), 'rgba(18,20,24,0.45)')

  const restored = product.weGlassRestore(ctx)
  assert.deepEqual(restored.restored.sort(), [
    '--ui-bg-sidebar',
    '--ui-chat-surface-background',
    '--ui-editor-surface-background',
  ])
  assert.equal(squash(computed(dom, '--ui-bg-sidebar')), 'rgb(30,32,38)')
  assert.equal(squash(computed(dom, '--ui-chat-surface-background')), 'rgb(44,46,52)')
})

// --------------------------------------------------------------------------- //
// T11c — the snapshot is the pre-existing inline value, verbatim
// --------------------------------------------------------------------------- //

test('T11c: an empty-string baseline is a real baseline (restore = absence)', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)

  const snapshot = product.weGlassSnapshotToken('--ui-bg-sidebar', dom.window.document)
  assert.deepEqual(snapshot, { present: false, value: '' })

  product.weGlassApply(ctx, makeSettings({ panelBase: 55 }))
  assert.notEqual(inline(dom, '--ui-bg-sidebar'), '')
  product.weGlassStop()

  assert.equal(inline(dom, '--ui-bg-sidebar'), '', 'back to "no inline value"')
  assert.equal(squash(computed(dom, '--ui-bg-sidebar')), 'rgb(30,32,38)')
})

test('T11c: a pre-existing inline value is snapshotted verbatim and comes back', () => {
  const product = loadProduct()
  const dom = makeDom()
  const root = dom.window.document.documentElement
  root.style.setProperty('--ui-bg-sidebar', 'rebeccapurple')
  root.style.setProperty('--ui-chat-surface-background', '#123456')
  const { ctx } = makeCtx(dom)

  assert.deepEqual(product.weGlassSnapshotToken('--ui-bg-sidebar', dom.window.document), {
    present: true,
    value: 'rebeccapurple',
  })

  product.weGlassApply(ctx, makeSettings({ panelBase: 55, cardBase: 45 }))
  assert.match(inline(dom, '--ui-bg-sidebar'), /^rgba\(18, 20, 24, 0\.55\)$/)

  product.weGlassStop()
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rebeccapurple', 'the original inline value, not a delete')
  assert.equal(inline(dom, '--ui-chat-surface-background'), '#123456')
})

test('T11c: the baseline survives repeated apply calls (no self-snapshot of our own rgba)', () => {
  const product = loadProduct()
  const dom = makeDom()
  const root = dom.window.document.documentElement
  root.style.setProperty('--ui-bg-sidebar', 'rebeccapurple')
  const { ctx } = makeCtx(dom)

  product.weGlassApply(ctx, makeSettings({ panelBase: 55 }))
  product.weGlassApply(ctx, makeSettings({ panelBase: 70 }))
  product.weGlassApply(ctx, makeSettings({ panelBase: 35 }))
  assert.match(inline(dom, '--ui-bg-sidebar'), /^rgba\(18, 20, 24, 0\.35\)$/)

  product.weGlassStop()
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rebeccapurple')
})

test('T11c: an external overwrite while we are applied becomes the new baseline', () => {
  const product = loadProduct()
  const dom = makeDom()
  const root = dom.window.document.documentElement
  const { ctx } = makeCtx(dom)

  product.weGlassApply(ctx, makeSettings({ panelBase: 55 }))
  // somebody else (the theme, another plugin) takes the token over
  root.style.setProperty('--ui-bg-sidebar', 'rgb(9, 9, 9)')

  const tokens = product.weGlassResyncBaseline(product.weGlassVars({ includeDisabled: true }), dom.window.document)
  assert.deepEqual(tokens, ['--ui-bg-sidebar'])
  assert.deepEqual(product.weGlassDiag().snapshot['--ui-bg-sidebar'], { present: true, value: 'rgb(9, 9, 9)' })

  product.weGlassStop()
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgb(9, 9, 9)', 'we restore what was there when we lost the token')
})

// --------------------------------------------------------------------------- //
// theme recompute (§8.2 step 4) + 200 ms coalescing
// --------------------------------------------------------------------------- //

test('T2.4 throttle: five theme mutations cost exactly one 200 ms recompute', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const timers = makeCtx(dom)
  const ctx = timers.ctx

  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  const stop = product.weGlassStart(ctx)
  const runsAfterStart = product.weGlassDiag().runs
  assert.equal(runsAfterStart, 1, 'start applies once')
  timers.timers.length = 0

  const root = dom.window.document.documentElement
  for (const value of ['light', 'dark', 'light', 'dusk', 'light']) {
    root.setAttribute('data-theme', value)
  }
  root.classList.add('themed')
  await settle()

  const pending = timers.pending()
  assert.equal(pending.length, 1, 'a single coalesced run is queued')
  assert.equal(pending[0].ms, product.WE_GLASS_THROTTLE_MS)
  assert.equal(pending[0].ms, 200)

  assert.equal(timers.flush(), 1)
  assert.equal(product.weGlassDiag().runs, runsAfterStart + 1, 'one recompute, not five')
  stop()
})

test('T2.4 recompute: a theme flip re-probes the base and does NOT stack on our own rgba', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const timers = makeCtx(dom)
  const ctx = timers.ctx
  const root = dom.window.document.documentElement

  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  const stop = product.weGlassStart(ctx)
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgba(18, 20, 24, 0.55)')
  timers.timers.length = 0

  // the theme repaints its chrome
  root.style.setProperty('--ui-bg-chrome', 'rgb(200, 100, 50)')
  root.setAttribute('data-theme', 'dusk')
  await settle()
  timers.flush()

  assert.equal(
    inline(dom, '--ui-bg-sidebar'),
    'rgba(200, 100, 50, 0.55)',
    'recomputed from the re-probed base + today\'s parameters',
  )
  assert.equal(product.weGlassDiag().base.source, 'computed-token')
  stop()
})

test('T2.4 recompute: our own write does not re-trigger the observer', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const timers = makeCtx(dom)
  const ctx = timers.ctx

  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  const stop = product.weGlassStart(ctx)
  const runs = product.weGlassDiag().runs
  timers.timers.length = 0

  product.weGlassApply(ctx, makeSettings({ panelBase: 70 }))
  await settle()
  assert.equal(timers.pending().length, 0, 'the style record we caused is recognised as our own')
  assert.equal(product.weGlassDiag().runs, runs + 1, 'only the explicit apply ran')
  assert.match(inline(dom, '--ui-bg-sidebar'), /0\.7\)$/)
  stop()
})

test('T2.4 recompute: a store update reaches the tokens without the panel calling us', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const timers = makeCtx(dom)
  const ctx = timers.ctx

  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  const stop = product.weGlassStart(ctx)
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgba(18, 20, 24, 0.55)')

  product.weSet({ config: makeConfig({ panelBase: 80 }) })
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgba(18, 20, 24, 0.8)')

  // an unrelated field must not cause a rewrite
  const runs = product.weGlassDiag().runs
  product.weSet({ config: makeConfig({ panelBase: 80, videoVolume: 0.5 }) })
  assert.equal(product.weGlassDiag().runs, runs, 'signature unchanged → no work')

  // disabled through the store restores the theme
  product.weSet({ config: makeConfig({ enabled: false }) })
  assert.equal(inline(dom, '--ui-bg-sidebar'), '')
  stop()
})

test('T2.4 throttle: the pending run is cancelled by teardown, never fired later', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const timers = makeCtx(dom)
  const ctx = timers.ctx

  product.weSet({ config: makeConfig() })
  const stop = product.weGlassStart(ctx)
  timers.timers.length = 0

  dom.window.document.documentElement.setAttribute('data-theme', 'light')
  await settle()
  assert.equal(timers.pending().length, 1)

  stop()
  assert.equal(timers.pending().length, 0, 'weGlassStop cancels the coalesced run')
  assert.equal(product.weGlassDiag().pending, false)
  assert.equal(product.weGlassDiag().observing, false)
  // and the observer is really gone
  dom.window.document.documentElement.setAttribute('data-theme', 'dark')
  await settle()
  assert.equal(timers.pending().length, 0)
})

test('T2.4 start is idempotent: a second start does not leave two observers', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const timers = makeCtx(dom)
  const ctx = timers.ctx

  product.weSet({ config: makeConfig() })
  product.weGlassStart(ctx)
  product.weGlassStart(ctx)
  timers.timers.length = 0

  dom.window.document.documentElement.setAttribute('data-theme', 'light')
  await settle()
  assert.equal(timers.pending().length, 1, 'one observer → one queued run')
  product.weGlassStop()
})

// --------------------------------------------------------------------------- //
// filter parameters (§8.2 step 7 — computed here, applied by 10-layer.js)
// --------------------------------------------------------------------------- //

test('T2.4 filters: percent settings map to a CSS filter string plus opacity/scrim', () => {
  const { weGlassFilters } = loadProduct()
  const bundle = weGlassFilters(
    makeSettings({ brightness: 110, contrast: 105, saturate: 120, wallpaperBlur: 8, wallpaperOpacity: 80, scrim: 0.35 }),
  )

  assert.equal(bundle.filter, 'brightness(1.1) contrast(1.05) saturate(1.2) blur(8px)')
  assert.equal(bundle.brightness, 1.1)
  assert.equal(bundle.contrast, 1.05)
  assert.equal(bundle.saturate, 1.2)
  assert.equal(bundle.blurPx, 8)
  assert.equal(bundle.opacity, 0.8)
  assert.equal(bundle.scrim, 0.35)
  assert.equal(bundle.scrimColor, 'rgba(0, 0, 0, 0.35)')
  assert.equal(bundle.objectFit, 'cover')
  assert.equal(bundle.transition, 'fade')
})

test('T2.4 filters: blur(0px) is omitted, defaults are neutral, and the bundle is pure', () => {
  const { weGlassFilters } = loadProduct()
  const neutral = weGlassFilters(makeSettings())
  assert.equal(neutral.filter, 'brightness(1) contrast(1) saturate(1)')
  assert.equal(neutral.blurPx, 0)
  assert.equal(neutral.opacity, 1)
  assert.equal(neutral.scrim, 0.25)

  // the design default row from config.py SETTINGS_DEFAULTS
  assert.equal(neutral.scrimColor, 'rgba(0, 0, 0, 0.25)')

  const cut = weGlassFilters(makeSettings({ objectFit: 'fill', switchTransition: 'cut', scrim: 0 }))
  assert.equal(cut.objectFit, 'fill')
  assert.equal(cut.transition, 'cut')
  assert.equal(cut.scrimColor, 'rgba(0, 0, 0, 0)')

  // garbage/missing fields degrade instead of poisoning the declaration
  const broken = weGlassFilters({ brightness: 'x', contrast: null, saturate: -10, wallpaperBlur: 999, wallpaperOpacity: 500, scrim: 5 })
  assert.equal(broken.filter, 'brightness(1) contrast(1) saturate(0) blur(40px)')
  assert.equal(broken.opacity, 1)
  assert.equal(broken.scrim, 0.9)

  // and a settings object is never mutated by computing filters
  const settings = makeSettings()
  const before = JSON.stringify(settings)
  weGlassFilters(settings)
  assert.equal(JSON.stringify(settings), before)
})

test('T2.4 filters: the bundle key changes only when something visible changes', () => {
  const { weGlassFilters } = loadProduct()
  const a = weGlassFilters(makeSettings({ panelBase: 55 }))
  const b = weGlassFilters(makeSettings({ panelBase: 70 }))
  const c = weGlassFilters(makeSettings({ panelBase: 55 }))
  assert.equal(a.key, c.key, 'panelBase is not a filter input')
  assert.equal(a.key, b.key)
  assert.notEqual(a.key, weGlassFilters(makeSettings({ wallpaperBlur: 4 })).key)
})

test('T2.4 filters: the computed bundle lands on the engine state for 10-layer to read', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)
  const result = product.weGlassApply(ctx, makeSettings({ wallpaperBlur: 12, wallpaperOpacity: 60, scrim: 0.5 }))
  assert.equal(result.filters.blurPx, 12)
  assert.deepEqual(product.weGlassDiag().filters, result.filters)
})

// --------------------------------------------------------------------------- //
// [PV-2] — what jsdom can and cannot settle
// --------------------------------------------------------------------------- //

test('T2.4 [PV-2]: the chat-surface probe reports a verdict and writes nothing', () => {
  const product = loadProduct()

  // no card in the DOM
  // a ctx-shaped double: the real PluginContext has no document/window
  // (apps/desktop/src/contrib/plugin.ts:76-126), so the ambient DOM is the real
  // path; here the same shape is passed explicitly because Node has no DOM.
  const envCtx = (dom) => ({ document: dom.window.document, window: dom.window })

  const empty = makeDom({ body: '' })
  assert.equal(product.weGlassMeasureChatSurface(envCtx(empty)).verdict, 'no-element')

  // the card paints its own, different colour → independent token, needs registering
  const independent = makeDom({
    css: `${THEME_CSS} [data-chat-surface] { background: rgb(50, 60, 70); }`,
    body: '<div data-chat-surface></div>',
  })
  const found = product.weGlassMeasureChatSurface(envCtx(independent))
  assert.equal(found.verdict, 'independent-token')
  assert.equal(found.computed, 'rgb(50, 60, 70)')
  // jsdom normalises the custom property it reports (no spaces) — compare squashed
  assert.equal(squash(found.tokenValue), 'rgb(44,46,52)')

  // the card in the real app inherits the surface: only the seam token is needed
  const inherited = makeDom({ body: '<div data-chat-surface></div>' })
  assert.equal(product.weGlassMeasureChatSurface(envCtx(inherited)).verdict, 'transparent')

  // a card painted with exactly the seam value
  const same = makeDom({
    css: `${THEME_CSS} [data-chat-surface] { background: rgb(44, 46, 52); }`,
    body: '<div data-chat-surface></div>',
  })
  assert.equal(product.weGlassMeasureChatSurface(envCtx(same)).verdict, 'matches-token')

  // the probe never writes
  assert.equal(inline(same, '--ui-chat-surface-background'), '')
})

// --------------------------------------------------------------------------- //
// robustness: no document, no timers, garbage settings
// --------------------------------------------------------------------------- //

test('T2.4 robustness: a host without a document yields a report, not a throw', () => {
  const product = loadProduct()
  const result = product.weGlassApply({}, {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-document')
  assert.equal(product.weGlassDiag().started, false)
  assert.equal(product.weGlassDiag().pending, false)
})

test('T2.4 robustness: a ctx without setTimeout still recomputes (synchronously)', async () => {
  const product = loadProduct()
  const dom = makeDom()
  const root = dom.window.document.documentElement
  // no setTimeout on purpose — the window fallback must carry us
  const ctx = { document: dom.window.document, window: dom.window }
  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  const stop = product.weGlassStart(ctx)

  root.style.setProperty('--ui-bg-chrome', 'rgb(1, 2, 3)')
  root.setAttribute('data-theme', 'light')
  // the window fallback is a real 200 ms timer, so wait past the window
  await settle(300)

  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgba(1, 2, 3, 0.55)')
  stop()
})

test('T2.4 robustness: diag snapshot is a copy, and restore clears the bookkeeping', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)
  product.weGlassApply(ctx, makeSettings({ panelBase: 55 }))

  const diag = product.weGlassDiag()
  assert.equal(diag.applied['--ui-bg-sidebar'], 'rgba(18, 20, 24, 0.55)')
  diag.applied['--ui-bg-sidebar'] = 'tampered'
  assert.equal(product.weGlassDiag().applied['--ui-bg-sidebar'], 'rgba(18, 20, 24, 0.55)')

  product.weGlassStop()
  const after = product.weGlassDiag()
  assert.deepEqual(after.applied, {})
  assert.deepEqual(after.snapshot, {})
  assert.equal(after.base, null)
  assert.equal(after.filters, null)
})

// --------------------------------------------------------------------------- //
// the <html> ownership marker (the 2026-10-22 density-slider regression)
// --------------------------------------------------------------------------- //

test('T2.4 marker: start sets data-we-glass, stop clears it, restart re-sets it', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)
  const root = dom.window.document.documentElement

  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  assert.equal(root.hasAttribute(product.WE_GLASS_ROOT_ATTR), false, 'no claim before start')

  const stop = product.weGlassStart(ctx)
  assert.equal(root.hasAttribute(product.WE_GLASS_ROOT_ATTR), true, 'start claims the tokens')
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgba(18, 20, 24, 0.55)', 'and the tints are live under the marker')

  stop()
  assert.equal(root.hasAttribute(product.WE_GLASS_ROOT_ATTR), false, 'stop releases the root')

  const stop2 = product.weGlassStart(ctx)
  assert.equal(root.hasAttribute(product.WE_GLASS_ROOT_ATTR), true, 'a restart re-claims the root')
  stop2()
  assert.equal(root.hasAttribute(product.WE_GLASS_ROOT_ATTR), false, '... and releases it again')
})

test('T2.4 marker: a hostile document that refuses the attribute does not throw', () => {
  const product = loadProduct()
  const dom = makeDom()
  const { ctx } = makeCtx(dom)
  const root = dom.window.document.documentElement
  root.setAttribute = function () {
    throw new Error('attribute denied')
  }
  root.removeAttribute = function () {
    throw new Error('attribute denied')
  }
  product.weSet({ config: makeConfig({ panelBase: 55 }) })
  const stop = product.weGlassStart(ctx)
  assert.equal(inline(dom, '--ui-bg-sidebar'), 'rgba(18, 20, 24, 0.55)', 'the tints still land')
  stop()
})
