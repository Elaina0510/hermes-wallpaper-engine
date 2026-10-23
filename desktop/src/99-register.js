/**
 * 99-register.js — MOD-013 (T2.7): the plugin's default export and its wiring.
 *
 * This is the only file allowed to hold `export default` (build.py rule 3) and
 * the only file with no import at all (rule 1 gives `import` to 00-core.js
 * alone). React therefore arrives through `globalThis.__HERMES_REACT__`, and
 * every other module symbol arrives through the shared concatenated scope.
 *
 * What register(ctx) does (design §7.1):
 *
 *   1. register the Appearance contribution — `render` is a ZERO-ARGUMENT
 *      function (the host does `createElement(render)`), so `ctx` is closed
 *      over here instead of passed in,
 *   2. register the wallpaper-library modal adapter as a second contribution in
 *      the same area, driven by the store's `pickerOpen` flag,
 *   3. hydrate the store from `ctx.storage` so the first paint has a document
 *      (no flash), then reconcile the DOM against it,
 *   4. subscribe to the store — this is the only driver of the enable/disable
 *      transition (§7.6), never a poll,
 *   5. kick off `weBootstrap(ctx)` for the truth (`GET /config` + `/library`);
 *      it never rejects, so `register` cannot fail on a dead backend.
 *
 * Ownership split (deliberate, and the reason this file stays small):
 *
 *   - 10-layer owns the layer *nodes* and its own store subscription; this file
 *     owns whether the layer is MOUNTED at all (mount/dispose transitions),
 *     because a disabled plugin must not leave a `[data-wallpaper-layer]` box
 *     behind in the document.
 *   - 30-glass owns the token values and the `enabled` ⇄ token mapping (its
 *     signature includes `enabled`, and `weGlassApply` has an explicit
 *     `disabled` branch that puts every token back). This file only starts it —
 *     once, at the first moment there is something to see — and stops it on
 *     teardown. Re-deriving "off" a second time here would mean two writers
 *     racing over the same inline properties.
 *   - 50-picker owns the modal DOM. Its promised surface is
 *     `wePickerModal(props)` / `wePickerOpen` / `wePickerClose` /
 *     `wePickerToggle` / `wePickerIsOpen` / `wePickerRoot` / `wePickerDispose`;
 *     every call below is `typeof`-guarded, because that file is being
 *     reworked in parallel and a missing symbol must degrade (no modal, one
 *     toast) instead of taking the panel down.
 *
 * Timers: none. Nothing here needs one (rotation is T3), and there is no
 * `timer` object on ctx anyway (F22 — flat disposer-returning methods).
 */

// --------------------------------------------------------------------------- //
// wiring constants
// --------------------------------------------------------------------------- //

/**
 * Contribution ids. `ctx.register` namespaces them to `<plugin>:<local>`.
 */
const WE_REG_PAGE_ID = 'page'
const WE_REG_NAV_ID = 'nav'
/**
 * The pane contribution's local id. The host namespaces it, so the tree (and
 * `host.revealPane`) sees `wallpaper-engine:appearance`.
 */
const WE_REG_PANE_ID = 'appearance'

/**
 * The panel is BOTH a pane and a sidebar row (2026-10-22, second pass):
 *
 *   panes       — the tab in the workspace strip: closable, switchable with
 *                 the chat, which is the "标签栏" the user asked to keep.
 *   sidebar.nav — the row next to 技能与工具 / 消息平台. It points at a route
 *                 because that is the only thing a nav row can point at, and
 *                 the route's page immediately hands the click back to the
 *                 pane (see weRegHandoff) — a route page takes the workspace
 *                 over and would cost the tab strip again.
 *   routes      — that hand-off page. Never rendered for long: it reveals the
 *                 pane and returns the router to where the user was.
 *
 * `appearance.extra` stays out of the picture for the reason recorded below
 * (the host forces a settings subpage, so that seam never mounts).
 */
const WE_REG_PAGE_PATH = '/wallpaper-engine'

/* There is no second registration any more: the library modal is the last
 * child of the panel's own tree (40-panel.js), so it is always mounted and
 * always subscribed. See the comment in weRegRegisterContributions. */

/** Diagnostics ring size — small on purpose: this is for a human, not a log sink. */
const WE_REG_DIAG_LIMIT = 12

/** Toast shown once when the picker adapter is missing (see `weRegWarnPicker`). */
const WE_REG_PICKER_MISSING_TOAST = '壁纸库不可用：模态组件未就绪'

/**
 * Module-level wiring state. One per module evaluation, exactly like
 * `weLayerRuntime` and `weGlassState`: a reload re-evaluates the whole
 * concatenated module into a fresh scope, so there is nothing to reset.
 *
 * `disposed` is the re-entrancy guard: `weLayerDispose()` writes `layer: idle`
 * to the store, and that notification must not make the listener mount a new
 * layer halfway through teardown.
 */
const weRegRuntime = {
  ctx: null,
  registered: false,
  disposed: false,
  /** unsubscribe returned by `weSubscribe` (a function — see 00-core.js:364) */
  unsubscribe: null,
  /** disposers handed back by `ctx.register(...)` */
  contributionDisposers: [],
  pickerMissing: false,
  pickerWarned: false,
  layerMounts: 0,
  layerDrops: 0,
  glassStarts: 0,
  reconciles: 0,
  lastReason: 'init',
  /** hash the sidebar row's hand-off returns to (see weRegTrackReturnHash) */
  returnHash: '#/',
  notes: [],
}

// --------------------------------------------------------------------------- //
// diagnostics
// --------------------------------------------------------------------------- //

/**
 * @param {*} error
 * @returns {string}
 */
function weRegText(error) {
  if (typeof weDescribeError === 'function') {
    return weDescribeError(error)
  }
  if (error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/**
 * Append one diagnostic line, keeping only the last `WE_REG_DIAG_LIMIT`.
 *
 * @param {string} text
 */
function weRegNote(text) {
  const rt = weRegRuntime
  rt.notes.push(String(text))
  while (rt.notes.length > WE_REG_DIAG_LIMIT) {
    rt.notes.shift()
  }
}

/**
 * Wiring snapshot for tests and for a future diagnostics block. Read-only copy:
 * no node references, no ctx.
 *
 * @returns {{registered: boolean, disposed: boolean, pickerMissing: boolean,
 *   pickerMissing: boolean, pickerOpen: boolean, layerMounted: boolean,
 *   glassStarted: boolean, layerMounts: number, layerDrops: number,
 *   glassStarts: number, reconciles: number, lastReason: string, notes: string[]}}
 */
function weRegDiag() {
  const rt = weRegRuntime
  return {
    registered: rt.registered,
    disposed: rt.disposed,
    pickerMissing: rt.pickerMissing,
    pickerOpen: typeof wePickerIsOpen === 'function' ? wePickerIsOpen() === true : false,
    layerMounted: weRegLayerMounted(),
    glassStarted: weRegGlassStarted(),
    layerMounts: rt.layerMounts,
    layerDrops: rt.layerDrops,
    glassStarts: rt.glassStarts,
    reconciles: rt.reconciles,
    lastReason: rt.lastReason,
    notes: rt.notes.slice(),
  }
}

// --------------------------------------------------------------------------- //
// what the store says (§7.4 guard row: `enabled && 非 application`)
// --------------------------------------------------------------------------- //

/**
 * The settings block, or `{}`. Mirrors 30-glass/40-panel: a missing document is
 * not an error, it is simply "nothing configured yet".
 *
 * @param {*} [state]
 * @returns {Object}
 */
function weRegSettings(state) {
  const snapshot = state || (typeof weGetState === 'function' ? weGetState() : null)
  const settings = snapshot && snapshot.config ? snapshot.config.settings : null
  return settings && typeof settings === 'object' ? settings : {}
}

/**
 * §7.6: `settings.enabled === false` means "keep the panel, drop the effect".
 * `enabled !== false` is the same rule 10-layer/30-glass/40-panel use, so the
 * three never disagree about what "off" means.
 *
 * @param {*} [state]
 * @returns {boolean}
 */
function weRegEnabled(state) {
  return weRegSettings(state).enabled !== false
}

/**
 * Should the wallpaper be live right now?
 *
 * `playable` uses the shared `weIsPlayable` (video/image/web/scene) so an
 * `application` selection never gets a layer box built for it — that kind needs
 * an external process and 10-layer refuses it too.
 *
 * @param {*} [state]
 * @returns {{active: boolean, reason: string, item: *}}
 */
function weRegWanted(state) {
  const snapshot = state || (typeof weGetState === 'function' ? weGetState() : null)
  if (!weRegEnabled(snapshot)) {
    return { active: false, reason: 'disabled', item: null }
  }
  const item = snapshot && snapshot.current ? snapshot.current : null
  if (!item) {
    return { active: false, reason: 'no-current', item: null }
  }
  if (typeof weIsPlayable === 'function' && !weIsPlayable(item)) {
    return { active: false, reason: 'not-playable:' + String(item.kind), item }
  }
  return { active: true, reason: 'active', item }
}

// --------------------------------------------------------------------------- //
// layer ownership (mount / drop only — 10-layer owns the nodes)
// --------------------------------------------------------------------------- //

/** @returns {boolean} */
function weRegLayerMounted() {
  if (typeof weLayerState !== 'function') {
    return false
  }
  try {
    return weLayerState().mounted === true
  } catch (error) {
    return false
  }
}

/**
 * Mount the layer stack if it is not mounted. `weLayerMount` is idempotent —
 * when it is already up it only refreshes `ctx` and syncs — so calling this on
 * every active reconcile is safe and costs one sync.
 *
 * @param {*} ctx
 * @returns {boolean} whether this call performed the mount
 */
function weRegMountLayer(ctx) {
  if (typeof weLayerMount !== 'function') {
    weRegNote('layer-unavailable')
    return false
  }
  const wasMounted = weRegLayerMounted()
  try {
    weLayerMount(ctx)
  } catch (error) {
    weRegNote('layer-mount-failed:' + weRegText(error))
    return false
  }
  if (!wasMounted) {
    weRegRuntime.layerMounts += 1
    weRegNote('layer:mount')
  }
  return !wasMounted
}

/**
 * Remove the layer stack. `weLayerDispose` is the full teardown: nodes, the
 * `[data-wallpaper-layer]` box, the stylesheet, the window listeners and its own
 * store subscription. That is deliberately stronger than the internal narrow
 * `weLayerStop`, which leaves an empty fixed box in the document — a disabled
 * plugin should leave no trace of itself in the DOM (§7.6), and T11 asserts the
 * box is gone.
 *
 * @param {string} reason
 * @returns {boolean} whether anything was torn down
 */
function weRegDropLayer(reason) {
  if (typeof weLayerDispose !== 'function') {
    return false
  }
  if (!weRegLayerMounted()) {
    return false
  }
  try {
    weLayerDispose()
  } catch (error) {
    weRegNote('layer-drop-failed:' + weRegText(error))
    return false
  }
  weRegRuntime.layerDrops += 1
  weRegNote('layer:drop:' + reason)
  return true
}

// --------------------------------------------------------------------------- //
// glass ownership (start once, stop on teardown)
// --------------------------------------------------------------------------- //

/** @returns {boolean} whether 30-glass has an observer/ctx attached */
function weRegGlassStarted() {
  if (typeof weGlassDiag !== 'function') {
    return false
  }
  try {
    return weGlassDiag().started === true
  } catch (error) {
    return false
  }
}

/**
 * Start the glass engine if it has not been started yet.
 *
 * Deliberately sticky: once running, 30-glass keeps its own store subscription
 * and re-derives the tokens from `settings` (its signature includes `enabled`,
 * and `weGlassApply` has a `disabled` branch that restores every token). So the
 * `enabled → false` transition is handled by the module that owns the tokens —
 * this file must not write the same inline properties a second time.
 *
 * Starting it lazily (only once there is a wallpaper to see through) is what
 * §7.1 step 4 asks for: no wallpaper, no glass.
 *
 * @param {*} ctx
 * @returns {boolean} whether this call started it
 */
function weRegStartGlass(ctx) {
  if (typeof weGlassStart !== 'function') {
    weRegNote('glass-unavailable')
    return false
  }
  if (weRegGlassStarted()) {
    return false
  }
  try {
    weGlassStart(ctx)
  } catch (error) {
    weRegNote('glass-start-failed:' + weRegText(error))
    return false
  }
  weRegRuntime.glassStarts += 1
  weRegNote('glass:start')
  return true
}

/**
 * Stop the glass engine and put the theme's tokens back.
 *
 * `weGlassStop` is the "full stop" disposer 30-glass documents for
 * `ctx.onDispose`; `weGlassTeardown(true)` is the documented fallback when only
 * that surface exists.
 *
 * @returns {boolean}
 */
function weRegStopGlass() {
  try {
    if (typeof weGlassStop === 'function') {
      weGlassStop()
      return true
    }
    if (typeof weGlassTeardown === 'function') {
      weGlassTeardown(true)
      return true
    }
  } catch (error) {
    weRegNote('glass-stop-failed:' + weRegText(error))
  }
  return false
}

// --------------------------------------------------------------------------- //
// the one reconcile function (§7.6 driver)
// --------------------------------------------------------------------------- //

/**
 * Bring the document in line with the store. Idempotent, never throws, and the
 * single place that decides whether the layer is mounted.
 *
 * Called from three places only:
 *   - once at register time, right after the cache hydrate,
 *   - on every store notification (the `weSubscribe` listener),
 *   - once after `weBootstrap` settles (covers "nothing changed in the store but
 *     the first reconcile ran before there was a document").
 *
 * @param {*} [ctx]
 * @returns {{active: boolean, reason: string, item: *}}
 */
function weRegReconcile(ctx) {
  const rt = weRegRuntime
  if (rt.disposed) {
    return { active: false, reason: 'disposed', item: null }
  }
  const scope = ctx || rt.ctx
  rt.reconciles += 1
  let want
  try {
    want = weRegWanted()
  } catch (error) {
    rt.lastReason = 'state-unreadable'
    weRegNote('state-unreadable:' + weRegText(error))
    return { active: false, reason: 'state-unreadable', item: null }
  }
  rt.lastReason = want.reason
  if (want.active) {
    weRegMountLayer(scope)
    weRegStartGlass(scope)
    return want
  }
  // Stopping order inside the "off" branch: the pixels first (layer), because
  // the tokens only describe what is behind them. Glass itself is not touched
  // here — its own subscription sees the same `enabled` flag and takes the
  // `disabled` branch, which is the one place that knows how to restore a token
  // without clobbering a theme baseline.
  weRegDropLayer(want.reason)
  return want
}

// --------------------------------------------------------------------------- //
// contributions
// --------------------------------------------------------------------------- //

/**
 * Remember where the user was, so the sidebar row can put the router back
 * after it hands the click to the pane. The wallpaper page itself is never a
 * return target (it is the one route that only exists to hand off).
 *
 * @param {*} ctx
 * @returns {void}
 */
function weRegTrackReturnHash(ctx) {
  const read = () => {
    try {
      const hash = String(globalThis.location ? globalThis.location.hash : '') || '#/'
      if (hash !== '#' + WE_REG_PAGE_PATH) {
        weRegRuntime.returnHash = hash
      }
    } catch (error) {
      // location is not readable here — keep the previous target
    }
  }
  read()
  if (ctx && typeof ctx.addEventListener === 'function' && typeof globalThis.addEventListener === 'function') {
    ctx.addEventListener(globalThis, 'hashchange', read)
  }
}

/**
 * The sidebar row's route component — a two-frame hand-off, not a page.
 *
 * A contributed route is a FULL PAGE that takes the workspace over
 * (app/routes.ts), which is exactly how the panel lost its tab strip when the
 * row was added. So this component does not render the panel: it reveals the
 * pane (fronting the tab in the strip) and returns the router to the route the
 * user came from.
 *
 * Order matters. `navigate` first, the reveal a tick later: a route change
 * re-fronts the workspace pane, so revealing first would be undone by the
 * navigation. When the host does not expose the plugin SDK (an older desktop),
 * it degrades to rendering the panel inline — what the row did before.
 *
 * @param {() => *} panelRender the panel's zero-arg render
 * @returns {() => *} the route contribution's render
 */
function weRegHandoff(panelRender) {
  const React = wePanelReact()
  const paneName = WE_PLUGIN_ID + ':' + WE_REG_PANE_ID

  return function WallpaperEnginePage() {
    const [fallback, setFallback] = React.useState(false)

    React.useEffect(() => {
      let host = null
      try {
        const sdk = globalThis.__HERMES_PLUGIN_SDK__
        host = sdk && sdk.host ? sdk.host : null
      } catch (error) {
        host = null
      }
      if (!host || typeof host.revealPane !== 'function' || typeof host.navigate !== 'function') {
        setFallback(true)
        return undefined
      }
      const back = weRegRuntime.returnHash || '#/'
      // Navigate FIRST, reveal after the route settles. Measured 2026-10-22:
      //  · reveal while this page route is still active → the route's own
      //    "front the workspace" pass takes it straight back;
      //  · reveal in the same tick as navigate → lost;
      //  · navigate, wait ~200ms, reveal → the panel tab stays on top.
      // The timer is deliberately NOT cleared on unmount: the unmount is
      // caused by this very navigation, so a cleanup would cancel the reveal.
      try {
        host.navigate(back)
      } catch (error) {
        // Router refused to move — reveal anyway, a page we cannot leave still
        // must not swallow the click.
      }
      setTimeout(() => {
        try {
          host.revealPane(paneName)
        } catch (error) {
          // Nothing more to do; the row already navigated.
        }
      }, 200)
      return undefined
    }, [])

    return fallback ? React.createElement(panelRender) : null
  }
}

/**
 * Register the Appearance contributions. Returns how many landed.
 *
 * The panel registers into `panes` (a dockable window); the picker adapter
 * registers into `appearance.extra` (a space-less host for a fixed overlay).
 * Each lands in its own `ContribBoundary`, so a crash in one does not take the
 * other down — the two areas are independent registries.
 *
 * @param {*} ctx
 * @returns {number}
 */
function weRegRegisterContributions(ctx) {
  const rt = weRegRuntime
  if (!ctx || typeof ctx.register !== 'function') {
    weRegNote('no-register-surface')
    return 0
  }
  let count = 0

  // 1. the settings panel. `render` MUST be zero-argument: the host calls
  //    `createElement(render)` with nothing. `weAppearanceExtra(ctx)` closes over
  //    ctx and returns exactly that function (40-panel.js:1544).
  if (typeof weAppearanceExtra === 'function') {
    const render = weAppearanceExtra(ctx)
    if (typeof render === 'function') {
      try {
        const pane = ctx.register({
          id: WE_REG_PANE_ID,
          area: 'panes',
          order: 10,
          title: '壁纸引擎',
          data: {
            placement: 'main',
            // The tab the user asked to keep: stacked into the workspace strip
            // (never a column of its own — that was the weight-4.0 adoption and
            // then the 552px edge dock, both measured 2026-10-22).
            dock: { pane: 'workspace', pos: 'center', enforce: true },
            defaultCollapsed: true,
            width: '22rem',
          },
          render: render,
        })
        if (typeof pane === 'function') {
          rt.contributionDisposers.push(pane)
        }
        const page = ctx.register({
          id: WE_REG_PAGE_ID,
          area: 'routes',
          title: '壁纸引擎',
          data: { path: WE_REG_PAGE_PATH },
          render: weRegHandoff(render),
        })
        if (typeof page === 'function') {
          rt.contributionDisposers.push(page)
        }
        const nav = ctx.register({
          id: WE_REG_NAV_ID,
          area: 'sidebar.nav',
          data: { codicon: 'eye', label: '壁纸引擎', path: WE_REG_PAGE_PATH },
        })
        if (typeof nav === 'function') {
          rt.contributionDisposers.push(nav)
        }
        count += 3
      } catch (error) {
        weRegNote('panel-register-failed:' + weRegText(error))
      }
    } else {
      weRegNote('panel-render-not-a-function')
    }
  } else {
    weRegNote('panel-unavailable')
  }

  // 2. the library modal — NO separate contribution.
  //
  // It used to be its own `appearance.extra` registration. That was the bug
  // that broke "打开壁纸库" (2026-10-20): when the panel moved to `panes`, the
  // modal adapter stayed on a seam the host renders only on the Appearance
  // page's TOP level, which normal navigation never reaches. An unmounted
  // contribution subscribes to nothing, so the button wrote `pickerOpen: true`
  // into a store nobody was listening to and no dialog ever appeared.
  //
  // It now renders as the last child of the panel's own tree (see the tail of
  // weAppearancePanel in 40-panel.js). The overlay is `position: fixed; inset:
  // 0`, so its DOM parent is irrelevant visually, and the panel's contribution
  // is resident — so the modal is always mounted and always subscribed. This
  // also removes a registration: one contribution instead of two, nothing to
  // keep in sync.
  //
  // `pickerMissing` is still reported, because the panel degrades: the button
  // then does nothing at all, and the diagnostics ring has to say why.
  if (typeof wePickerModal !== 'function') {
    rt.pickerMissing = true
    weRegNote('picker-unavailable:wePickerModal')
  }

  return count
}

/**
 * Degraded-mode notice: the panel's "打开壁纸库" button only sets
 * `store.pickerOpen`, and with no adapter nothing would consume it — the user
 * would click and see nothing. Say so once, then stay quiet.
 *
 * @param {*} state
 */
function weRegWarnPicker(state) {
  const rt = weRegRuntime
  if (!rt.pickerMissing || rt.pickerWarned) {
    return
  }
  if (!state || state.pickerOpen !== true) {
    return
  }
  rt.pickerWarned = true
  weRegNote('picker-open-without-adapter')
  if (typeof weShowToast === 'function') {
    const kind = typeof WE_TOAST !== 'undefined' && WE_TOAST ? WE_TOAST.INFO : 'info'
    weShowToast(WE_REG_PICKER_MISSING_TOAST, kind)
  }
}

// --------------------------------------------------------------------------- //
// the store subscription — the only enable/disable driver (§7.6)
// --------------------------------------------------------------------------- //

/**
 * `weSubscribe(listener)` returns a plain unsubscribe function (00-core.js:364,
 * `weStore.subscribe`), so it can be handed straight to `ctx.onDispose`.
 *
 * @param {*} ctx
 * @returns {Function|null} unsubscribe
 */
function weRegWatch(ctx) {
  if (typeof weSubscribe !== 'function') {
    weRegNote('no-store')
    return null
  }
  const rt = weRegRuntime
  const unsubscribe = weSubscribe(function onStoreChange(state) {
    if (rt.disposed) {
      return
    }
    try {
      weRegWarnPicker(state)
      weRegReconcile(rt.ctx || ctx)
    } catch (error) {
      // A listener that throws must not take the store down with it; the store
      // already isolates listeners, this is the second belt.
      weRegNote('reconcile-failed:' + weRegText(error))
    }
  })
  rt.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
  return rt.unsubscribe
}

// --------------------------------------------------------------------------- //
// teardown (§7.6 unload / plugin disable)
// --------------------------------------------------------------------------- //

/**
 * Order and why:
 *
 *   1. set `disposed` FIRST — every store write below notifies this module's own
 *      listener, and a reconcile during teardown would remount what we are
 *      removing,
 *   2. the modal: it is the outermost surface (a body-level portal at max
 *      z-index), so it goes before anything underneath it changes,
 *   3. the wallpaper layer: the pixels everything else is composed over,
 *   4. the glass tokens: they describe the layer's translucency, so restoring
 *      them while a wallpaper still paints would flash an opaque shell over live
 *      pixels — visible seam,
 *   5. finally this module's own plumbing (contribution disposers + the store
 *      subscription). It goes last on purpose: steps 2-4 are performed *by* this
 *      wiring, and tearing the wiring down first would leave 30-glass without the
 *      `ctx` it restores tokens through.
 *
 * Everything is `typeof`-guarded and individually try/catch'd: a missing module
 * or a throwing disposer must not stop the rest of the unload.
 *
 * @param {string} [reason] diagnostic label
 * @returns {{layer: boolean, glass: boolean, picker: boolean, contributions: number, subscription: boolean}}
 */
function weRegTeardown(reason) {
  const rt = weRegRuntime
  if (rt.disposed) {
    return { layer: false, glass: false, picker: false, contributions: 0, subscription: false }
  }
  rt.disposed = true
  const report = { layer: false, glass: false, picker: false, contributions: 0, subscription: false }

  // 2. modal
  try {
    if (typeof wePickerClose === 'function') {
      wePickerClose()
    }
  } catch (error) {
    weRegNote('picker-close-failed:' + weRegText(error))
  }
  try {
    if (typeof wePickerDispose === 'function') {
      wePickerDispose()
      report.picker = true
    }
  } catch (error) {
    weRegNote('picker-dispose-failed:' + weRegText(error))
  }

  // 3. layer
  report.layer = weRegDropLayer('teardown')

  // 4. glass
  report.glass = weRegStopGlass()

  // 5. plumbing — contribution disposers first, then the store subscription.
  for (const dispose of rt.contributionDisposers) {
    try {
      if (typeof dispose === 'function') {
        dispose()
        report.contributions += 1
      }
    } catch (error) {
      weRegNote('contribution-dispose-failed:' + weRegText(error))
    }
  }
  rt.contributionDisposers = []
  if (typeof rt.unsubscribe === 'function') {
    try {
      rt.unsubscribe()
      report.subscription = true
    } catch (error) {
      weRegNote('unsubscribe-failed:' + weRegText(error))
    }
  }
  rt.unsubscribe = null

  weRegNote('dispose:' + (reason || 'unload'))
  rt.ctx = null
  rt.registered = false
  return report
}

// --------------------------------------------------------------------------- //
// register
// --------------------------------------------------------------------------- //

/**
 * The whole startup sequence (§7.1). Never throws: the loader rolls back every
 * registration when `register` throws, so a half-wired plugin would leave the
 * app without a panel *and* without an explanation. Every step is
 * contained and recorded in the diagnostics ring instead.
 *
 * @param {*} ctx
 * @returns {{contributions: number, hydrated: boolean, initial: Object, bootstrapping: boolean}}
 */
function weRegRegister(ctx) {
  const rt = weRegRuntime
  rt.ctx = ctx || null
  rt.registered = true
  rt.disposed = false
  rt.notes = []
  rt.contributionDisposers = []
  rt.pickerMissing = false,
  rt.pickerWarned = false
  rt.layerMounts = 0
  rt.layerDrops = 0
  rt.glassStarts = 0
  rt.reconciles = 0
  rt.lastReason = 'init'

  // 1. contributions first: the entry point exists even if everything below
  //    fails, which is what "the panel stays, the effect degrades" (§7.6) needs.
  let contributions = 0
  try {
    weRegTrackReturnHash(ctx)
    contributions = weRegRegisterContributions(ctx)
  } catch (error) {
    weRegNote('register-failed:' + weRegText(error))
  }

  // 2. first paint from the cache, synchronously — no flash (§7.1 step 3).
  let hydrated = false
  try {
    if (typeof weHydrateFromStorage === 'function') {
      hydrated = weHydrateFromStorage(ctx) === true
    }
  } catch (error) {
    weRegNote('hydrate-failed:' + weRegText(error))
  }

  // 3. reconcile against that cached snapshot, before any network I/O. This is
  //    what puts a wallpaper on screen at launch without waiting for the API.
  let initial = { active: false, reason: 'skipped', item: null }
  try {
    initial = weRegReconcile(ctx)
  } catch (error) {
    weRegNote('initial-reconcile-failed:' + weRegText(error))
  }

  // 4. the driver for every later change (§7.6). Subscribed after the first
  //    reconcile so the initial mount is not immediately followed by a second.
  try {
    weRegWatch(ctx)
  } catch (error) {
    weRegNote('watch-failed:' + weRegText(error))
  }

  // 5. the truth: GET /config + GET /library, in parallel, never rejecting.
  //    NOTE: `weBootstrap` hydrates from storage again internally — same keys,
  //    same values, so the second read is a no-op; it is not a second source of
  //    truth. The trailing reconcile is likewise redundant with the store
  //    notification, except in the one case that matters: the first reconcile
  //    ran against an empty store and the response body happened to be identical
  //    to it, in which case no notification is emitted.
  let bootstrapping = false
  try {
    if (typeof weBootstrap === 'function') {
      const pending = weBootstrap(ctx)
      if (pending && typeof pending.then === 'function') {
        bootstrapping = true
        pending.then(
          function settled() {
            if (!rt.disposed) {
              weRegReconcile(rt.ctx)
            }
          },
          function rejected(error) {
            weRegNote('bootstrap-rejected:' + weRegText(error))
          },
        )
      }
    }
  } catch (error) {
    weRegNote('bootstrap-failed:' + weRegText(error))
  }

  return { contributions, hydrated, initial, bootstrapping }
}

/**
 * `ctx.onDispose` entry point. Kept as a named function so the ordering above is
 * documented in one place and the loader only ever sees one disposer per plugin.
 *
 * @returns {Object} the teardown report
 */
function weRegDispose() {
  return weRegTeardown('unload')
}

// --------------------------------------------------------------------------- //
// default export (build.py rule 3: exactly one, in this file)
// --------------------------------------------------------------------------- //

export default {
  /** Stable slug — also the `plugin:` source and the ctx id namespace. */
  id: WE_PLUGIN_ID,
  /**
   * English name/description, matching the bundled plugins (`Kanban`,
   * `Hermes Bots`) so the Capabilities ▸ Plugins list reads uniformly; the
   *   contribution `title` above stays Chinese because it is user-facing copy
   *   on the pane tab, like the rest of the panel.
   */
  name: 'Wallpaper Engine',
  description: 'Live Wallpaper Engine wallpapers behind the app, with translucent sidebar and chat surfaces.',
  /** On by default: after `plugins.enabled` loads the module (T2.8) the effect is immediate. */
  defaultEnabled: true,
  register(ctx) {
    weRegRegister(ctx)
    // Registered here rather than inside weRegRegister so the wiring function
    // stays callable from tests with a ctx double that has no onDispose.
    if (ctx && typeof ctx.onDispose === 'function') {
      ctx.onDispose(weRegDispose)
    }
  },
}
