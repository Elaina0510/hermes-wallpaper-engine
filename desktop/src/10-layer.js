/**
 * T2.3 — MOD-007: the wallpaper layer (video / image rendering, switch control
 * flow, content-reveal gate).
 *
 * This file is a *fragment*: it is concatenated into the single ES module the
 * loader evaluates, so it declares no imports and no exports and collaborates
 * with the constants/store/rest helpers of the core part through the shared
 * global scope (symbols are `we`-prefixed by convention). It never re-implements
 * a core helper — `weGetState` / `weSet` / `weSubscribe` / `weIsPlayable` /
 * `weMediaOrigin` / `weToast` are used as-is.
 *
 * Design anchors:
 *   §7.1 step 4  enabled && currentId → mount the layer
 *   §7.2         optimistic select → PUT → layer switch (retire → build → load
 *                → destroy); fade keeps the old layer pinned, cut does not wait
 *   §7.4         the layer state machine (this file is its only writer)
 *   §7.6         settings.enabled=false → remove the layer (token restore is the
 *                glass module's job, not ours)
 *   F22          timers come from `ctx.setTimeout` (flat method, disposer) —
 *                there is no timer object on ctx, and a bare global timer is
 *                never used
 *   F24          fade = old layer stays at opacity:1 as an opaque underlay and is
 *                never faded out (the glass `backdrop-filter` samples its pixels);
 *                base duration 1800ms. DSH's "cut to 150ms" idea is NOT adopted.
 *
 * Ownership boundaries:
 *   - this module owns DOM nodes, media elements, its gate timer and its
 *     visibility listeners;
 *   - it owns `store.layer` and nothing else in the store (it reads
 *     `store.current` / `store.config.settings` and writes `toast` on failure);
 *   - it APPLIES the look chain (§8.2 step 7): filter / wallpaper opacity on the
 *     media element, the `scrim` film under the root. The values come from the
 *     settings the panel writes; 30-glass's `weGlassFilters` is the design's
 *     source of truth for them, and this module owns the elements. It never
 *     writes a CSS custom property — the surface tokens belong to 30-glass.
 *     The `opacity:1` pinned on each layer element is a stacking guarantee and
 *     the fade animation's target, not a look setting.
 */

// --------------------------------------------------------------------------- //
// constants
// --------------------------------------------------------------------------- //

/** Host attribute the design names for the layer container (§2). */
const WE_LAYER_ROOT_ATTR = 'data-wallpaper-layer'

/** Container class (we-prefixed, like every class this module creates). */
const WE_LAYER_ROOT_CLASS = 'we-layer-stack'

/** `<style>` id holding the keyframes; its absence only costs the fade-in. */
const WE_LAYER_STYLE_ID = 'we-layer-style'

const WE_LAYER_CLASS = 'we-layer'
const WE_LAYER_MEDIA_CLASS = 'we-layer__media'
/** Theme-coloured floor painted under the wallpaper (`z-index:-2`). */
const WE_LAYER_BACKDROP_CLASS = 'we-layer__backdrop'
/** Dark film over the wallpaper (`scrim` setting), a child of the layer root. */
const WE_LAYER_SCRIM_CLASS = 'we-layer__scrim'
const WE_LAYER_VIDEO_CLASS = 'we-layer--video'
const WE_LAYER_IMAGE_CLASS = 'we-layer--image'
const WE_LAYER_SCENE_CLASS = 'we-layer--scene'
const WE_LAYER_WEB_CLASS = 'we-layer--web'
const WE_LAYER_FALLBACK_CLASS = 'we-layer--fallback'

/** Fade-in of the incoming layer. Never applied to the outgoing one (F24). */
const WE_LAYER_IN_CLASS = 'we-layer--switch-in'

/** Fade-out marker. Only non-fade transitions may ever put this on a layer —
 *  with `switchTransition` clamped to {cut,fade} that means: never today. It
 *  exists so a future transition mode has a named hook instead of inventing one. */
const WE_LAYER_OUT_CLASS = 'we-layer--switch-out'

/** §7.4: `loading --(2s, no onload/onloadeddata)--> fallback`. */
const WE_LAYER_CONTENT_TIMEOUT_MS = 2000

/** Scene / web get their own, longer budget. Their media child is an iframe
 *  pointing at `/gl/host.html`, which has to boot a whole renderer document
 *  (parse `scene.pkg`, decode textures) before the frame's `load` arrives. On a
 *  cold start that competes with the host's own boot, and the 2s gate fired
 *  first — the live layer was destroyed and the still preview took over. The
 *  fallback is sticky by design, so the wallpaper stayed a preview until the
 *  user re-picked it. Measured 2026-10-24: a healthy scene needs well over 2s
 *  right after the desktop window opens. */
const WE_LAYER_HEAVY_TIMEOUT_MS = 15000

/** Auto-retry a failed live layer. A cold start can lose the race with the
 *  media server (origin not published yet) or with the renderer; the sticky
 *  fallback then hides that it would have worked a few seconds later. Bounded
 *  so a genuinely broken wallpaper still settles on its preview. */
const WE_LAYER_RETRY_DELAY_MS = 5000
const WE_LAYER_RETRY_MAX = 2

/** A scene/web frame must not boot its renderer while the window has no
 *  viewport. The vendor render page measures its canvas ONCE, from the frame
 *  viewport at boot, and has no resize path for a scene
 *  (`y0` → `clientWidth || innerWidth`, clamped to 1). Booting inside a
 *  zero-area window therefore freezes a 1x1 canvas for the whole session:
 *  iframe `load` still fires, so the gate passes, the layer reports `active`,
 *  and nothing is drawn. Measured 2026-10-26 21:42 on a cold start:
 *  `fit cover: view 2160x2160 scene 3840x2160 canvas 1x1`.
 *  So the frame waits for a real viewport first. Bounded so a permanently
 *  hidden window still ends up with the preview instead of nothing. */
const WE_LAYER_FRAME_BOX_WAIT_MS = 10000
const WE_LAYER_FRAME_BOX_POLL_MS = 100

/** F24: fade base. There is no speed-tier field in the accepted settings
 *  document, so the base is used as-is (documented trade-off, see the report). */
const WE_LAYER_FADE_MS = 1800

/** Cold-start fade. On launch there is no wallpaper underneath the incoming
 *  layer, so the 1800ms base only delays the moment the screen stops being
 *  empty. Measured 2026-10-26 (cold start): the window opened at ~4.4s, the
 *  live layer was ready ~3s later, and the fade then kept it near-transparent
 *  for another 1.8s — the whole launch read as "still loading". A short ease
 *  reads the same over an empty screen and lands ~1.6s earlier.
 *  Guarded by "no layer of ours is currently mounted" (see
 *  `weLayerSetCurrent`), so a wallpaper switch between two real layers keeps
 *  the F24 base duration. */
const WE_LAYER_COLD_FADE_MS = 200

/** Bounded diagnostic ring; `weLayerState().notes` exposes it. */
const WE_LAYER_DIAG_LIMIT = 24

/** Kinds this module can put on screen today. `scene` and `web` both render
 *  through `/gl/host.html` as an iframe: `type=scene` for WebGL scenes,
 *  `type=web` for author HTML + the injected shim. Neither has a heartbeat
 *  channel back to us (vendor CONTRACT §2.2 — `we-frame` goes to the render
 *  page, not to its parent), so liveness is the iframe `load` event plus the
 *  content timeout. `application` is not playable at all. */
const WE_LAYER_RENDERED_KINDS = Object.freeze(['video', 'image', 'scene', 'web'])

/** Structural CSS. Everything positional is also set inline on the elements, so
 *  a missing `<style>` (or a stylesheet-less test DOM) still yields a correct
 *  box; this block adds what inline styles cannot express (keyframes). */
const WE_LAYER_CSS = [
  '[data-wallpaper-layer]{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background:transparent}',
  // Host background clears — the DECLARATIVE twin of weLayerEnsureRoot's JS
  // pass. The JS pass runs once, on first mount, and cannot see elements the
  // host mounts LATER: the React shell paints its two full-window divs (the
  // SidebarProvider wrapper and the [data-contrib-shell] div, see
  // app/contrib/controller.tsx) after this plugin's register() has already
  // walked an empty #root. A scoped stylesheet rule has no timing at all —
  // it is live exactly while the host box is in the document, dies with it on
  // dispose, and re-clears the painters on every shell re-mount. The selectors
  // mirror the host's own glass rules (styles.css [data-hermes-glass] block):
  // the boot script's inline <html> colour, the <body> sheet paint, and the
  // shell's two full-window painters. !important is required the same way the
  // host's block requires it (inline boot style + layered Tailwind utilities).
  // On an engine without :has() these rules are inert and the JS pass still
  // does its job — the same degradation as any missing <style>.
  ':root:has([data-wallpaper-layer]){background-color:transparent !important;background-image:none !important}',
  ':root:has([data-wallpaper-layer]) body{background:transparent !important}',
  ':root:has([data-wallpaper-layer]) [data-contrib-shell],:root:has([data-wallpaper-layer]) [data-slot=sidebar-wrapper]{background-color:transparent !important}',
  // The surfaces paint from tokens, not from the shell divs: the transcript
  // column and the right sidebar read --ui-chat-surface-background /
  // --ui-sidebar-surface-background (host styles.css :root block maps them to
  // --ui-bg-chrome / --ui-bg-sidebar), and the left rail's rows do the same.
  // Clearing only the shell left those three columns opaque, which read as
  // "the wallpaper shows at the bottom edge but not in the middle" — the
  // status bar is the one strip that does not wear a surface token.
  //
  // These rules are a FALLBACK ONLY. 30-glass owns the same tokens while it is
  // running: it writes rgba(base, panelBase/cardBase alpha) as INLINE styles on
  // <html>, and an inline declaration beats a stylesheet one — except when the
  // stylesheet rule carries `!important`. An earlier revision put `!important`
  // on this rule unconditionally, which beat the engine's inline writes and
  // froze the 外壳浓度 / 卡片玻璃 sliders at "fully transparent" (2026-10-22
  // bug report). The `:not([data-we-glass])` guard is the fix: the engine sets
  // that marker when it starts and clears it when it stops, so
  //   - engine running  → this rule is inert, the inline rgba tints win and the
  //                       density sliders work;
  //   - engine failed / not started → the marker is absent, the rule forces the
  //                       surfaces transparent so the wallpaper is still visible.
  ':root:has([data-wallpaper-layer]):not([data-we-glass]){--ui-chat-surface-background:transparent !important;--ui-sidebar-surface-background:transparent !important;--ui-editor-surface-background:transparent !important}',
  // Chat-only "independent card" (2026-10-22, user request). The chat surface
  // is `div[data-chat-surface]` (host app/chat/index.tsx): `h-full`, no radius,
  // no margin. Inside it `[data-slot="composer-bounds"]` paints the SAME
  // surface colour again, so it has to go transparent or it covers the card.
  //   - `h-full` must be overridden to `calc(100% - 24px)`: margins alone would
  //     push the box past the pane and clip the composer.
  //   - material = the host composer's own fill at 55% + a 16px blur, i.e. the
  //     same glass the wallpaper panel uses, so the two read as one family.
  //   - scoped to `[data-we-card]` on <html>: 10-layer sets that attribute
  //     from `settings.uiCards` (and drops it with the layer), so the 卡片化
  //     switch is a one-line write instead of a stylesheet rebuild, and with
  //     the wallpaper off the app keeps its stock full-bleed look.
  // Sidebars are deliberately NOT carded (user: 只卡对话区).
  ':root[data-we-card] [data-chat-surface]{margin:12px !important;height:calc(100% - 24px) !important;border-radius:14px !important;background:color-mix(in srgb, var(--composer-fill, #0d1117) var(--we-card-pct, 55%), transparent) !important;-webkit-backdrop-filter:blur(var(--we-card-blur, 16px)) saturate(1.05);backdrop-filter:blur(var(--we-card-blur, 16px)) saturate(1.05);border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 32px rgba(0,0,0,0.32)}',
  ':root[data-we-card] [data-slot="composer-bounds"]{background:transparent !important}',
  // Full-page views (技能与工具, 消息平台, 产物, 定时任务 …) get the SAME card as
  // the chat surface (2026-10-22, user request: 做成和壁纸引擎一样的卡片).
  // They are `section.flex.h-full.min-w-0.flex-col.overflow-hidden` inside a
  // zone body, painting `--ui-chat-surface-background`; a direct child paints
  // it AGAIN, exactly like the composer-bounds seam, so both have to yield for
  // the card material to show. Scoped to `[data-zone-body]` so a nested
  // `<section>` inside a page never picks the card up.
  ':root[data-we-card] [data-zone-body] section.flex.h-full.min-w-0.flex-col.overflow-hidden{margin:12px !important;height:calc(100% - 24px) !important;border-radius:14px !important;background:color-mix(in srgb, var(--composer-fill, #0d1117) var(--we-card-pct, 55%), transparent) !important;-webkit-backdrop-filter:blur(var(--we-card-blur, 16px)) saturate(1.05);backdrop-filter:blur(var(--we-card-blur, 16px)) saturate(1.05);border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 32px rgba(0,0,0,0.32)}',
  ':root[data-we-card] [data-zone-body] section.flex.h-full.min-w-0.flex-col.overflow-hidden>[class~="bg-(--ui-chat-surface-background)"]{background:transparent !important}',
  // Overlay views (定时任务 / 设置 / 命令中心 …) render through the host's
  // OverlayView shell: a scrim plus a `[data-glass-raised]` card that paints
  // --ui-chat-surface-background. Give that card the same material as the page
  // cards so the look is one family (2026-10-23: 定时任务 was the odd one out —
  // it kept the token colour and the square-ish radius while every other
  // surface was glass).
  ':root[data-we-card] [data-overlay-surface] [data-glass-raised]{background:color-mix(in srgb, var(--composer-fill, #0d1117) var(--we-overlay-pct, 55%), transparent) !important;-webkit-backdrop-filter:blur(var(--we-overlay-blur, 16px)) saturate(1.05);backdrop-filter:blur(var(--we-overlay-blur, 16px)) saturate(1.05);border-radius:14px !important;border-color:rgba(255,255,255,0.08) !important;box-shadow:0 12px 32px rgba(0,0,0,0.32) !important}',
  // The host's cold-boot screen (GatewayConnectingOverlay) paints an opaque
  // full-window mask with `--ui-chat-surface-background` and declares
  // `[data-glass-opaque]`. We rewrite that same token to rgba(chrome,
  // cardBase%) so the page cards turn to glass — so the moment this plugin
  // mounted, the CONNECTING screen dropped to 15% opacity and the window's own
  // light background showed through: launch read as a blank white page
  // (measured 2026-10-27: overlay background `rgba(24,26,30,0.15)` at t=746ms,
  // while the host's own token was `rgb(13,16,21)` at t=589ms). The host's glass
  // mode solves the identical collision by pinning `[data-glass-opaque]` back to
  // the opaque chrome token; mirror that rule while our engine owns the tokens.
  ':root[data-we-glass] [data-glass-opaque]{background-color:var(--ui-bg-chrome) !important}',
  '.we-layer{position:absolute;inset:0;opacity:1;pointer-events:none;background:transparent}',
  '.we-layer__backdrop{position:fixed;inset:0;z-index:-2;pointer-events:none;background:var(--ui-bg-chrome, #0d1015)}',
  '.we-layer__media{display:block;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;background:transparent}',
  // The scrim film sits ABOVE every layer node (z-index 1 in the root's own
  // stacking context, nodes are z-index auto) and below the app content, which
  // is outside this box entirely. It is a child of the root, so teardown takes
  // it with the root.
  '.we-layer__scrim{position:absolute;inset:0;z-index:1;pointer-events:none;background:transparent}',
  '.we-layer--switch-in{animation-name:we-layer-fade-in;animation-timing-function:ease;animation-fill-mode:both;animation-duration:1800ms}',
  '@keyframes we-layer-fade-in{from{opacity:0}to{opacity:1}}',
  '.we-layer--switch-out{animation-name:we-layer-fade-out;animation-timing-function:ease;animation-fill-mode:both;animation-duration:1800ms}',
  '@keyframes we-layer-fade-out{from{opacity:1}to{opacity:0}}',
].join('\n')

/**
 * Module-level runtime. A single `const` object with mutable fields: the store
 * is a singleton for the same reason (see the core part), and top-level `let`
 * declarations are avoided so the concatenated module stays declaration-only.
 *
 * @type {{
 *   mounted: boolean, disposed: boolean, debug: boolean, ctx: *, root: *, styleEl: *, scrim: *,
 *   nodes: Object[], pending: *, gate: *, currentId: string|null, mode: string,
 *   transition: string, generation: number, paused: boolean, pauseReason: string|null,
 *   notes: string[], unsubscribe: *, listeners: Object[]
 * }}
 */
const weLayerRuntime = {
  mounted: false,
  disposed: false,
  /** `<html>`'s original inline background-color, saved before we made it
   *  transparent so the z-index:-1 layer can be seen (see weLayerEnsureRoot).
   *  `null` = we never touched it. `htmlOwner` is the element we changed, held
   *  so teardown restores THAT document even if `document` has since moved on
   *  (a test that rebuilds its DOM between mount and dispose). */
  htmlBaseline: null,
  htmlOwner: null,
  /** `<body>`'s original inline `background` shorthand, for the same reason. */
  bodyBaseline: null,
  bodyOwner: null,
  /** The app shell's own first div inside #root (`bg-background`). */
  shellBaseline: null,
  shellOwner: null,
  debug: false,
  ctx: null,
  root: null,
  /** Theme floor under the layer; see weLayerEnsureBackdrop. */
  backdrop: null,
  /** Cached still painted before the live node has a frame (see the poster block). */
  poster: null,
  /** True once GET /config + /library settled. The hydrated boot flag is NOT a
   *  proxy for this: hydration marks the store `ready` from the cache, which is
   *  exactly the state that must not retire the poster (a dead-port frame can
   *  report `active` there). See weLayerMarkBootstrapped. */
  bootstrapDone: false,
  styleEl: null,
  /** The `scrim` dark-film element under the root (one per layer stack). */
  scrim: null,
  nodes: [],
  pending: null,
  gate: null,
  /** Bounded auto-retry of a failed live layer (see WE_LAYER_RETRY_MAX).
   *  `retryTimer` is the disposer of the armed timer; `retryItemId` scopes the
   *  counter to one wallpaper so a new selection starts from zero. */
  retryTimer: null,
  retryCount: 0,
  retryItemId: null,
  currentId: null,
  /** Media-server origin the mounted node's URLs were built from. The media
   *  server binds an ephemeral port per backend process, so a cold start that
   *  mounts from the localStorage snapshot uses the PREVIOUS process's origin —
   *  a dead port. The frame then loads a chrome-error page (its `load` event
   *  still fires), the layer reports `active` over nothing, and the sticky
   *  same-id guard never rebuilds it. `weLayerSync` compares this against the
   *  store and remounts once the bootstrap response brings the live origin. */
  originUsed: '',
  /** id of an item we deliberately refused, so a store notification about the
   *  same item cannot re-run the refusal (and re-raise its toast) in a loop. */
  skippedId: null,
  mode: 'idle',
  transition: 'fade',
  generation: 0,
  paused: false,
  pauseReason: null,
  notes: [],
  unsubscribe: null,
  listeners: [],
}

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //

/** @returns {Document|null} */
function weLayerDocument() {
  return typeof document === 'undefined' ? null : document
}

/** @param {*} media @returns {string} lowercase tag name, '' when unknown */
function weLayerTagOf(media) {
  return media && typeof media.tagName === 'string' ? media.tagName.toLowerCase() : ''
}

/** @param {*} value @param {number} lo @param {number} hi @param {number} fallback */
function weLayerClamp(value, lo, hi, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!isFinite(n)) {
    return fallback
  }
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Append one line to the bounded diagnostic ring. `diag` in the design has no
 * `ctx` API (F22 lists storage/os/socket/rest/register/onDispose/i18n/timers
 * only), so the record lives here and is readable through `weLayerState()`.
 *
 * @param {Object} rt
 * @param {string} text
 */
function weLayerNote(rt, text) {
  rt.notes.push(String(text))
  while (rt.notes.length > WE_LAYER_DIAG_LIMIT) {
    rt.notes.shift()
  }
  if (rt.debug && typeof console !== 'undefined' && typeof console.debug === 'function') {
    console.debug('[wallpaper-engine:layer] ' + text)
  }
}

/** Human text for a failure reason (toasts are read by people). */
function weLayerReasonText(reason) {
  if (reason === 'timeout') {
    return '内容加载超时'
  }
  if (reason === 'no-media-origin') {
    return '媒体服务不可用'
  }
  if (reason === 'no-url') {
    return '没有可用的媒体地址'
  }
  return '媒体加载失败'
}

// --------------------------------------------------------------------------- //
// settings projection
//
// The backend clamps and is the single source of truth; the fallbacks below are
// only for "config has not arrived yet" and never invent a user preference.
// --------------------------------------------------------------------------- //

/**
 * @param {*} [state]
 * @returns {{enabled: boolean, switchTransition: 'cut'|'fade', objectFit: string,
 *   flip: boolean, playbackRate: number, videoMuted: boolean, videoVolume: number,
 *   pauseOnHidden: boolean, pauseOnBlur: boolean, fadeMs: number}}
 */
function weLayerSettings(state) {
  const snapshot = state || weGetState()
  const raw =
    snapshot && snapshot.config && typeof snapshot.config.settings === 'object' && snapshot.config.settings
      ? snapshot.config.settings
      : {}
  return {
    enabled: raw.enabled !== false,
    switchTransition: raw.switchTransition === 'cut' ? 'cut' : 'fade',
    objectFit: raw.objectFit === 'contain' || raw.objectFit === 'fill' ? raw.objectFit : 'cover',
    flip: raw.flip === true,
    playbackRate: weLayerClamp(raw.playbackRate, 0.25, 3, 1),
    videoMuted: raw.videoMuted !== false,
    videoVolume: weLayerClamp(raw.videoVolume, 0, 1, 0),
    pauseOnHidden: raw.pauseOnHidden !== false,
    pauseOnBlur: raw.pauseOnBlur === true,
    fadeMs: WE_LAYER_FADE_MS,
    // The look chain (§8.2 step 7). 30-glass's `weGlassFilters` is the single
    // source of truth for the ranges and the CSS spelling; these mirrors exist
    // because this module applies the values and must not re-derive them from
    // a different clamp table. Keep them in sync with `dashboard/config.py`
    // `_NUMERIC_RANGES` (0–200 / 0–40 px / 0–100 / 0–0.9 fraction).
    brightness: weLayerClamp(raw.brightness, 0, 200, 100),
    contrast: weLayerClamp(raw.contrast, 0, 200, 100),
    saturate: weLayerClamp(raw.saturate, 0, 200, 100),
    wallpaperBlur: weLayerClamp(raw.wallpaperBlur, 0, 40, 0),
    wallpaperOpacity: weLayerClamp(raw.wallpaperOpacity, 0, 100, 100),
    scrim: weLayerClamp(raw.scrim, 0, 0.9, 0.25),
    // 卡片玻璃. Drives the two composer-material cards (chat surface + the
    // wallpaper panel) through `--we-card-pct` / `--we-card-blur`.
    cardBase: weLayerClamp(raw.cardBase, 0, 100, 45),
    // Overlay cards (设置 / 定时任务 / …) carry their own transparency.
    overlayBase: weLayerClamp(raw.overlayBase, 0, 100, 55),
    // Whether those cards are drawn at all (`data-we-card` on <html>).
    uiCards: raw.uiCards !== false,
    // Scene render page fps ceiling (CONTRACT §1 #6). The backend only lets
    // 15/30/60 through, so anything else degrades to 15 rather than being sent.
    sceneLiveFps: raw.sceneLiveFps === 30 || raw.sceneLiveFps === 60 ? raw.sceneLiveFps : 15,
  }
}

// --------------------------------------------------------------------------- //
// media URLs
// --------------------------------------------------------------------------- //

/**
 * Absolute URL for `WallpaperItem.play` (`/m/<token>` or `/s/<token>/<entry>`).
 * `weMediaOrigin` is '' when the media server is down, and '' means "no URL" —
 * never a relative one (file:// renderer, F8).
 *
 * @param {*} state
 * @param {*} item
 * @returns {string}
 */
function weLayerPlayUrl(state, item) {
  if (!item || !item.play || typeof item.play.url !== 'string' || !item.play.url) {
    return ''
  }
  const url = item.play.url
  if (url.charAt(0) !== '/') {
    return url
  }
  const origin = weMediaOrigin(state)
  if (!origin) {
    return ''
  }
  return String(origin).replace(/\/+$/, '') + url
}

/**
 * Render-page URL for a scene wallpaper (vendor CONTRACT §1).
 *
 * `item.play.url` is `/s/<token>/<entry>` (scan.py). The renderer wants `src` to
 * be the DIRECTORY base `/s/<token>` — it appends its own candidates
 * (`scene.pkg` / `scenes/scene.pkg` / `gifscene.pkg`) — plus `mediaBase` = the
 * media origin. Passing the entry path instead produces
 * `…/scene.pkg/scene.pkg` → 404 (CONTRACT §1 #2), which is the trap this helper
 * exists to avoid.
 *
 * `type=scene` is mandatory: the default `canvas` lands on the vendor's
 * `onUnhandledType` fallback, whose iframe src points at a DSH-only path
 * (CONTRACT §4.2).
 *
 * @param {*} state
 * @param {*} item
 * @returns {string} absolute URL, or '' when the item cannot be rendered
 */
function weLayerSceneUrl(state, item) {
  const play = item && item.play
  if (!play || typeof play.url !== 'string') {
    return ''
  }
  const parts = play.url.split('/')
  // ['', 's', <token>, ...entry] — the token is base64url, never contains '/'
  const token = parts.length >= 3 && parts[1] === 's' ? parts[2] : ''
  if (!token) {
    return ''
  }
  const origin = weMediaOrigin(state)
  if (!origin) {
    return ''
  }
  const base = String(origin).replace(/\/+$/, '')
  const s = weLayerSettings(state)
  const params = [
    ['type', 'scene'],
    ['src', '/s/' + token],
    ['fit', s.objectFit === 'contain' ? 'contain' : 'cover'],
    ['sceneFps', String(s.sceneLiveFps)],
    ['muted', 'true'],
    ['opaque', '1'],
    ['mediaBase', base],
  ]
  return weLayerHostUrl(base, params)
}

/**
 * Assemble `/gl/host.html?…` from a base origin and CONTRACT §1 query pairs.
 *
 * @param {string} base origin without a trailing slash
 * @param {Array<[string, string]>} params
 * @returns {string}
 */
function weLayerHostUrl(base, params) {
  return (
    base +
    '/gl/host.html?' +
    params
      .map(function encodePair(pair) {
        return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1])
      })
      .join('&')
  )
}

/**
 * `/gl/host.html` URL for a web wallpaper (vendor CONTRACT §1 #1).
 *
 * Unlike a scene, `src` here IS the author page (`/s/<token>/index.html`):
 * `type=web` dispatches to the renderer's web chain, which iframes that page
 * and relies on `web-shim.js` being injected into it — the media server does
 * that injection on token routes (§10.2), so nothing extra is needed here.
 *
 * `webSandbox=strict` is deliberately NOT sent: strict means
 * `sandbox="allow-scripts"`, which makes the shim's own `window` opaque; the
 * render page and the author page are same-origin here, so the default
 * (same-origin) path is both simpler and strictly more capable.
 *
 * @param {*} state
 * @param {*} item
 * @returns {string} absolute URL, or '' when the item cannot be rendered
 */
function weLayerWebUrl(state, item) {
  const play = item && item.play
  if (!play || typeof play.url !== 'string' || play.url.charAt(0) !== '/') {
    return ''
  }
  const origin = weMediaOrigin(state)
  if (!origin) {
    return ''
  }
  const base = String(origin).replace(/\/+$/, '')
  const s = weLayerSettings(state)
  const params = [
    ['type', 'web'],
    ['src', play.url],
    ['fit', s.objectFit === 'contain' ? 'contain' : 'cover'],
    ['muted', 'true'],
    ['opaque', '1'],
    ['mediaBase', base],
  ]
  return weLayerHostUrl(base, params)
}

/**
 * URL for the still preview used by the fallback branch.
 *
 * `WallpaperItem.preview` is an absolute filesystem path (backend scan.py:863),
 * and the media server has no preview route yet, so it is turned into a
 * `file:///` URL (the renderer is itself a file:// document, F23). An item that
 * already carries a URL (or a media-relative path) is passed through unchanged.
 *
 * @param {*} state
 * @param {*} item
 * @returns {string}
 */
function weLayerPreviewUrl(state, item) {
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
      return segment === 'C:' || segment === 'c:' || /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    })
    .join('/')
  return 'file:///' + encoded
}

// --------------------------------------------------------------------------- //
// host container + stylesheet
// --------------------------------------------------------------------------- //

/**
 * Inject (once) the keyframes stylesheet. Failure is non-fatal: the rules that
 * matter for layout are inline.
 *
 * @param {Document} doc
 * @returns {*}
 */
function weLayerEnsureStyle(doc) {
  const rt = weLayerRuntime
  if (rt.styleEl && rt.styleEl.parentNode) {
    return rt.styleEl
  }
  let el = typeof doc.getElementById === 'function' ? doc.getElementById(WE_LAYER_STYLE_ID) : null
  if (!el) {
    el = doc.createElement('style')
    el.id = WE_LAYER_STYLE_ID
    el.textContent = WE_LAYER_CSS
    const host = doc.head || doc.documentElement
    if (host) {
      host.appendChild(el)
    }
  }
  rt.styleEl = el
  return el
}

/**
 * The wallpaper stack: one fixed, pointer-transparent, bottom-most box on
 * `document.body` (design §2: `position:fixed; inset:0; z-index:-1`).
 * Layers inside it are absolutely positioned and stack in DOM order, so the
 * newest layer is always on top without any z-index bookkeeping.
 *
 * @param {Document} doc
 * @returns {*}
 */
function weLayerEnsureRoot(doc) {
  const rt = weLayerRuntime
  if (rt.root && rt.root.parentNode) {
    return rt.root
  }
  let root = typeof doc.querySelector === 'function' ? doc.querySelector('[' + WE_LAYER_ROOT_ATTR + ']') : null
  if (!root) {
    root = doc.createElement('div')
    root.className = WE_LAYER_ROOT_CLASS
    root.setAttribute(WE_LAYER_ROOT_ATTR, '1')
    root.setAttribute('aria-hidden', 'true')
  }
  // Inline (not only stylesheet) so the box is right even without CSS support.
  root.style.position = 'fixed'
  root.style.top = '0'
  root.style.right = '0'
  root.style.bottom = '0'
  root.style.left = '0'
  root.style.zIndex = '-1'
  root.style.pointerEvents = 'none'
  root.style.overflow = 'hidden'
  // A hot reload may leave children from a previous module instance behind.
  while (root.firstChild) {
    root.removeChild(root.firstChild)
  }
  if (!root.parentNode) {
    const host = doc.body || doc.documentElement
    if (host) {
      host.appendChild(root)
    }
  }
  weLayerEnsureBackdrop(doc, doc.body || doc.documentElement)
  // `<html>` must be transparent while the layer exists.
  //
  // `z-index: -1` puts this box BEHIND its stacking context's background — and
  // the host's own boot script (apps/desktop/index.html) pins an OPAQUE inline
  // `backgroundColor` on `<html>` before first paint. That opaque background
  // therefore covered the wallpaper completely: the node was in the DOM, the
  // video loaded, and nothing was visible. The host hits the same wall for its
  // own glass mode and solves it exactly this way — `styles.css` forces
  // `:root[data-hermes-glass] { background-color: transparent !important }`.
  //
  // We take the inline route instead of the class route because we cannot set
  // the host's data attribute, and we restore the ORIGINAL inline value (not a
  // guess) on teardown, so a value the host or the user had set survives us.
  // `applyTheme` only writes `localStorage['hermes-boot-background']` (read by
  // the pre-paint script on the NEXT window), so it never overwrites this.
  if (rt.htmlBaseline === null) {
    const html = doc.documentElement
    const body = doc.body
    rt.htmlBaseline = html && html.style && typeof html.style.getPropertyValue === 'function'
      ? html.style.getPropertyValue('background-color') || ''
      : ''
    rt.htmlOwner = html
    // `<body>` paints `var(--ui-chat-surface-background)` (host styles.css:801-803).
    // That is the SAME token our glass engine writes (WE_GLASS_CARD_VAR), so with
    // the glass on it is already translucent — but with the glass OFF it is the
    // theme's opaque colour, and an opaque body sits squarely on top of a
    // `z-index: -1` layer. Clearing only `<html>` therefore was not enough: the
    // wallpaper stayed hidden behind the body's own paint. Save and clear both,
    // restore both.
    rt.bodyBaseline = body && body.style && typeof body.style.getPropertyValue === 'function'
      ? body.style.getPropertyValue('background') || ''
      : ''
    rt.bodyOwner = body

    if (rt.htmlBaseline !== 'transparent' && rt.htmlBaseline !== 'rgba(0, 0, 0, 0)') {
      html.style.setProperty('background-color', 'transparent')
    }
    // Unconditional: when `<body>` has NO inline background the paint still
    // comes from `var(--ui-chat-surface-background)` in the host stylesheet —
    // an opaque value just the same. The baseline is only about what to RESTORE,
    // never about whether to clear.
    if (body && body.style) {
      body.style.setProperty('background', 'transparent')
    }
    // The app shell paints TWO full-window opaque divs, and the host says so
    // itself (app/contrib/controller.tsx): "this div and the sidebar-wrapper
    // above it are the app shell's two full-window opaque painters; the
    // [data-hermes-glass] rules in styles.css clear them". The host clears them
    // only when ITS glass mode is on — our glass writes token values instead,
    // so both stay opaque and both cover a z-index:-1 layer.
    //   1. #root > first element   (SidebarProvider, `bg-background`, h-screen)
    //   2. [data-contrib-shell]    (`bg-(--ui-bg-chrome)`, h-screen w-screen)
    // The second is found by the host's own attribute, which is far more
    // stable than a positional walk.
    const shell = doc.getElementById ? doc.getElementById('root') : null
    const painters = []
    if (shell && shell.firstElementChild) {
      painters.push(shell.firstElementChild)
    }
    const marked = doc.querySelector ? doc.querySelector('[data-contrib-shell]') : null
    if (marked && painters.indexOf(marked) === -1) {
      painters.push(marked)
    }
    rt.shellBaseline = []
    rt.shellOwner = []
    for (const painter of painters) {
      if (!painter || !painter.style || typeof painter.style.getPropertyValue !== 'function') {
        continue
      }
      const before = painter.style.getPropertyValue('background-color') || ''
      rt.shellBaseline.push(before)
      rt.shellOwner.push(painter)
      if (before !== 'transparent' && before !== 'rgba(0, 0, 0, 0)') {
        painter.style.setProperty('background-color', 'transparent')
      }
    }
  }
  rt.root = root
  return root
}

/**
 * Theme-coloured floor under the wallpaper (`z-index:-2`).
 *
 * `weLayerEnsureRoot` clears `<html>`, `<body>` and both shell painters so the
 * `z-index:-1` layer can be seen. That also means that while there is no
 * wallpaper pixel yet, the Electron window's own backing (white here) shows
 * across the whole screen. Measured 2026-10-27 on a cold start: the CONNECTING
 * mask left at t=6.9s, the scene's first frame landed at t=7.5s, and the screen
 * in between measured `rgb(193,194,194)` — a white flash right after the boot
 * screen, which reads as "the wallpaper is still loading".
 *
 * This div sits below the wallpaper (so it never hides one) and above the window
 * paint, so the gap shows the theme's chrome colour instead of white. Its
 * background token is `--ui-bg-chrome` — the one the glass engine reads from and
 * never rewrites.
 *
 * @param {Document} doc
 * @param {Element|null} host
 * @returns {Element|null}
 */
function weLayerEnsureBackdrop(doc, host) {
  const rt = weLayerRuntime
  if (!doc || !host || typeof doc.createElement !== 'function') {
    return null
  }
  let el = rt.backdrop && rt.backdrop.parentNode ? rt.backdrop : null
  if (!el && typeof doc.querySelector === 'function') {
    el = doc.querySelector('.' + WE_LAYER_BACKDROP_CLASS)
  }
  if (!el) {
    el = doc.createElement('div')
    el.className = WE_LAYER_BACKDROP_CLASS
    el.setAttribute('aria-hidden', 'true')
  }
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.right = '0'
  el.style.bottom = '0'
  el.style.left = '0'
  el.style.zIndex = '-2'
  el.style.pointerEvents = 'none'
  el.style.background = 'var(--ui-bg-chrome, #0d1015)'
  if (!el.parentNode) {
    host.appendChild(el)
  }
  rt.backdrop = el
  return el
}

// --------------------------------------------------------------------------- //
// cached poster
//
// The launch gap: the CONNECTING mask lifts at ~6.9s on this machine and the
// live layer's first frame lands ~0.5s later (measured 2026-10-27). A themed
// floor stops that gap from being white, but it is still a gap. So each
// wallpaper's preview is cached (small JPEG data URL, LRU) the first time it is
// on screen, and the next launch paints that still immediately — the poster is
// below the live node, which replaces it the moment the real frame arrives.
// --------------------------------------------------------------------------- //

/** Per-wallpaper poster; the index key holds the LRU order (oldest first). */
const WE_LAYER_POSTER_KEY = 'we.poster.v1.'
const WE_LAYER_POSTER_INDEX_KEY = 'we.poster.index.v1'
/** Keep the cache small: storage is localStorage-class (~5MB) and one poster is
 *  ~40–60KB at this size, so 8 of them is a few hundred KB. */
const WE_LAYER_POSTER_MAX = 8
const WE_LAYER_POSTER_WIDTH = 480
const WE_LAYER_POSTER_QUALITY = 0.62
/** The still sits ABOVE the live node on purpose: a scene iframe is opaque from
 *  its first paint (host.html paints a background), so a still underneath it is
 *  invisible until the scene draws — exactly the gap it exists to cover. It is
 *  retired shortly after the layer reports active, which is also when a scene's
 *  first frame has landed (measured ~0.4s after `renderer started`). */
const WE_LAYER_POSTER_HOLD_MS = 450
const WE_LAYER_POSTER_FADE_MS = 320

/** @param {*} ctx @returns {string[]} */
function weLayerPosterIndex(ctx) {
  const raw = weStorageGet(ctx, WE_LAYER_POSTER_INDEX_KEY, [])
  return Array.isArray(raw) ? raw.filter(function isId(value) { return typeof value === 'string' && value }) : []
}

/**
 * @param {*} ctx
 * @param {string} id
 * @returns {string} data URL, or '' when nothing usable is cached
 */
function weLayerPosterRead(ctx, id) {
  if (!ctx || !id) {
    return ''
  }
  const value = weStorageGet(ctx, WE_LAYER_POSTER_KEY + id, '')
  return typeof value === 'string' && value.indexOf('data:image/') === 0 ? value : ''
}

/**
 * Cache one poster and evict the oldest beyond the cap. A quota failure is
 * silent: the poster is an optimisation, never a dependency.
 *
 * @param {*} ctx
 * @param {string} id
 * @param {string} dataUrl
 * @returns {boolean}
 */
function weLayerPosterWrite(ctx, id, dataUrl) {
  if (!ctx || !id || !dataUrl) {
    return false
  }
  const index = weLayerPosterIndex(ctx).filter(function notSame(value) { return value !== id })
  index.push(id)
  while (index.length > WE_LAYER_POSTER_MAX) {
    const drop = index.shift()
    weStorageSet(ctx, WE_LAYER_POSTER_KEY + drop, '')
  }
  if (!weStorageSet(ctx, WE_LAYER_POSTER_KEY + id, dataUrl)) {
    return false
  }
  weStorageSet(ctx, WE_LAYER_POSTER_INDEX_KEY, index)
  return true
}

/** Drop the poster node (real frame arrived, fallback took over, or teardown). */
function weLayerPosterClear(rt) {
  if (!rt.poster) {
    return
  }
  if (rt.poster.parentNode) {
    rt.poster.parentNode.removeChild(rt.poster)
  }
  rt.poster = null
}

/**
 * Called by the register step once `GET /config` + `GET /library` settled.
 * Only from here on is an `active` layer trustworthy: before it, the mount is
 * built from the cached snapshot's media origin, which belongs to the previous
 * backend process (an ephemeral port). That frame's `load` fires on a
 * chrome-error page, so retiring the poster on it would remove the still
 * seconds before the real one arrives — the exact gap it exists to cover.
 *
 * A warm start (the snapshot origin still live) already has its layer active by
 * now and never sees another `activate`, so retire here in that case.
 */
function weLayerMarkBootstrapped() {
  const rt = weLayerRuntime
  rt.bootstrapDone = true
  if (rt.poster && weGetState().layer === WE_LAYER.ACTIVE) {
    weLayerPosterRetire(rt)
  }
}

/**
 * Retire the still once the live layer is really up.
 *
 * The hold exists because `activate` for a scene means "the render page's
 * document loaded", which lands ~0.4s before the first drawn frame. It only
 * runs when the bootstrap has settled: on a cold start the first mount is built
 * against the previous process's dead media port, `load` fires anyway, and
 * retiring there would remove the still seconds before the real one arrives.
 *
 * @param {Object} rt
 */
function weLayerPosterRetire(rt) {
  const poster = rt.poster
  if (!poster) {
    return
  }
  weLayerSetTimeout(rt, function fadePoster() {
    if (rt.poster !== poster) {
      return
    }
    poster.style.transition = 'opacity ' + WE_LAYER_POSTER_FADE_MS + 'ms ease'
    poster.style.opacity = '0'
    weLayerSetTimeout(rt, function dropPoster() {
      if (rt.poster === poster) {
        weLayerPosterClear(rt)
      }
    }, WE_LAYER_POSTER_FADE_MS + 40)
  }, WE_LAYER_POSTER_HOLD_MS)
}

/**
 * Paint the cached still for `item`, under every live node. Returns null when
 * nothing is cached (first run, or a wallpaper never seen on screen).
 *
 * @param {Object} rt
 * @param {*} item
 * @returns {Element|null}
 */
function weLayerPosterShow(rt, item) {
  const doc = weLayerDocument()
  if (!doc || !rt.root || !item || !item.id) {
    return null
  }
  if (rt.poster) {
    if (rt.poster.getAttribute('data-we-poster') === item.id) {
      return rt.poster
    }
    // A different wallpaper: the still must not outlive its own selection.
    weLayerPosterClear(rt)
  }
  const dataUrl = weLayerPosterRead(rt.ctx, item.id)
  if (!dataUrl) {
    return null
  }
  const img = doc.createElement('img')
  img.className = 'we-layer__poster'
  img.setAttribute('aria-hidden', 'true')
  img.setAttribute('alt', '')
  img.setAttribute('data-we-poster', item.id)
  img.src = dataUrl
  img.style.position = 'absolute'
  img.style.top = '0'
  img.style.right = '0'
  img.style.bottom = '0'
  img.style.left = '0'
  img.style.width = '100%'
  img.style.height = '100%'
  img.style.objectFit = weLayerSettings(weGetState()).objectFit
  img.style.objectPosition = 'center'
  img.style.pointerEvents = 'none'
  img.style.background = 'transparent'
  // Above the live node (a scene iframe paints opaque immediately); retired on
  // activate, see weLayerPosterRetire.
  img.style.zIndex = '2'
  // Appended last = top of the stack inside the root.
  rt.root.appendChild(img)
  rt.poster = img
  weLayerNote(rt, 'poster:' + item.id)
  return img
}

/**
 * Fetch + downscale the preview into storage. Runs off the critical path, never
 * throws, and skips when this wallpaper already has a poster or when the
 * environment cannot decode (tests, no fetch).
 *
 * @param {*} ctx
 * @param {*} item
 * @param {string} url  preview URL on the LIVE media origin
 */
function weLayerPosterCapture(ctx, item, url) {
  if (!ctx || !item || !item.id || !url) {
    return
  }
  if (weLayerPosterRead(ctx, item.id)) {
    return
  }
  if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') {
    return
  }
  const doc = weLayerDocument()
  if (!doc || typeof doc.createElement !== 'function') {
    return
  }
  fetch(url, { mode: 'cors', credentials: 'omit' })
    .then(function toBlob(response) {
      return response && response.ok ? response.blob() : null
    })
    .then(function toBitmap(blob) {
      return blob ? createImageBitmap(blob) : null
    })
    .then(function shrink(bitmap) {
      if (!bitmap || !bitmap.width) {
        return
      }
      const width = WE_LAYER_POSTER_WIDTH
      const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width))
      const canvas = doc.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const cx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
      if (!cx) {
        return
      }
      cx.drawImage(bitmap, 0, 0, width, height)
      if (typeof bitmap.close === 'function') {
        bitmap.close()
      }
      const dataUrl = canvas.toDataURL('image/jpeg', WE_LAYER_POSTER_QUALITY)
      if (typeof dataUrl === 'string' && dataUrl.indexOf('data:image/jpeg') === 0) {
        weLayerPosterWrite(ctx, item.id, dataUrl)
      }
    })
    .catch(function ignored() {
      // Offline / dead port / decode failure: the next launch simply has no
      // poster for this wallpaper, which is the pre-existing behaviour.
    })
}

// --------------------------------------------------------------------------- //
// layer nodes
// --------------------------------------------------------------------------- //
/**
 * Build one layer element plus its media child. Nothing is attached to the
 * document here — the caller appends it once the previous layer's fate is
 * decided, which is what makes the cut/fade difference a one-line decision.
 *
 * @param {*} item
 * @param {boolean} fallback  true → still preview image (we-layer--fallback)
 * @returns {Object|null} node record
 */
function weLayerCreateNode(item, fallback) {
  const doc = weLayerDocument()
  if (!doc) {
    return null
  }
  const kind = fallback
    ? 'image'
    : item.kind === 'video'
      ? 'video'
      : item.kind === 'scene'
        ? 'scene'
        : item.kind === 'web'
          ? 'web'
          : 'image'
  const el = doc.createElement('div')
  const classes = [
    WE_LAYER_CLASS,
    kind === 'video'
      ? WE_LAYER_VIDEO_CLASS
      : kind === 'scene'
        ? WE_LAYER_SCENE_CLASS
        : kind === 'web'
          ? WE_LAYER_WEB_CLASS
          : WE_LAYER_IMAGE_CLASS,
  ]
  if (fallback) {
    classes.push(WE_LAYER_FALLBACK_CLASS)
  }
  el.className = classes.join(' ')
  el.setAttribute('data-we-id', item.id)
  el.setAttribute('data-we-media', fallback ? 'preview' : kind)
  el.setAttribute('data-we-state', 'loading')
  el.setAttribute('aria-hidden', 'true')
  el.style.position = 'absolute'
  el.style.top = '0'
  el.style.right = '0'
  el.style.bottom = '0'
  el.style.left = '0'
  el.style.pointerEvents = 'none'
  // Pinned, never animated by us: the glass `backdrop-filter` needs an opaque
  // underlay for as long as this node is the newest one (F24). Look-level
  // opacity/filters belong to the glass module.
  el.style.opacity = '1'

  const media =
    kind === 'video'
      ? doc.createElement('video')
      : kind === 'scene' || kind === 'web'
        ? doc.createElement('iframe')
        : doc.createElement('img')
  media.className = WE_LAYER_MEDIA_CLASS
  media.style.display = 'block'
  media.style.width = '100%'
  media.style.height = '100%'
  media.style.pointerEvents = 'none'
  let hostUrl = null
  if (kind === 'scene' || kind === 'web') {
    // Both kinds are the vendor's WebWallGL render page (CONTRACT §1): scene is
    // WebGL, web is an author-HTML iframe the render page owns. It is
    // cross-origin to the app, so nothing here may reach into it; liveness is
    // the iframe `load` event plus the content timeout.
    //
    // The src is NOT assigned here: this element is still detached, so the
    // frame would boot with a 0x0 viewport and freeze a 1x1 canvas (see
    // WE_LAYER_FRAME_BOX_WAIT_MS). `weLayerBootFrame` navigates it once the
    // node is in the document and the window has a viewport.
    media.setAttribute('frameborder', '0')
    media.setAttribute('scrolling', 'no')
    media.setAttribute('allow', 'autoplay')
    media.setAttribute('title', '')
    media.style.border = '0'
    hostUrl = kind === 'web' ? weLayerWebUrl(null, item) : weLayerSceneUrl(null, item)
    if (!hostUrl) {
      weLayerNote(weLayerRuntime, kind + '-url-missing')
    }
  } else if (kind === 'video') {
    media.setAttribute('preload', 'auto')
    media.setAttribute('playsinline', '')
    media.setAttribute('webkit-playsinline', '')
    media.setAttribute('disablepictureinpicture', '')
    media.autoplay = true
    media.controls = false
    media.loop = true
  } else {
    media.setAttribute('decoding', 'async')
    media.setAttribute('draggable', 'false')
    media.alt = ''
  }
  el.appendChild(media)

  return {
    id: item.id,
    item,
    kind,
    fallback: !!fallback,
    el,
    media,
    /** Render-page URL for scene/web; the frame is navigated by
     *  `weLayerBootFrame` once the node is in the document. */
    hostUrl,
    /** `'<w>x<h>'` of the frame at boot, `''` before it boots. A `'0x0'` here
     *  means the renderer measured a 1x1 canvas; see `weLayerFrameBox`. */
    bootBox: '',
    /** One-shot re-boot after a zero-box boot (never loops). */
    frameRebooted: false,
    state: 'loading',
    retired: false,
    generation: 0,
    handlers: [],
  }
}

/**
 * Three-decimal rounding for CSS numbers — the same precision `weGlassTrim`
 * uses, so the two modules spell the same look the same way.
 *
 * @param {number} value
 * @returns {number}
 */
function weLayerRound(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * The **window** viewport, which is what an iframe's `100%` box resolves to
 * once the host shell has been laid out.
 *
 * `0` here is the fatal case: the vendor render page reads
 * `container.clientWidth || window.innerWidth` once, so a zero viewport is a
 * 1x1 canvas for the rest of the session (see WE_LAYER_FRAME_BOX_WAIT_MS).
 *
 * @returns {{w: number, h: number}}
 */
function weLayerViewportBox() {
  if (typeof window === 'undefined') {
    return { w: 0, h: 0 }
  }
  return {
    w: Math.max(0, Math.round(Number(window.innerWidth) || 0)),
    h: Math.max(0, Math.round(Number(window.innerHeight) || 0)),
  }
}

/** @param {*} media @returns {{w: number, h: number}} laid-out frame box */
function weLayerFrameBox(media) {
  return {
    w: Math.max(0, Math.round(Number(media && media.clientWidth) || 0)),
    h: Math.max(0, Math.round(Number(media && media.clientHeight) || 0)),
  }
}

/**
 * Navigate a scene/web iframe — but only when there is a viewport to measure.
 *
 * The node has to be in the document first (the caller appends it), otherwise
 * the frame boots inside a 0x0 box. If the window itself has no viewport yet
 * (cold start: the host window is still hidden while the shell mounts), wait
 * for one, then boot. `onBoot` runs in the same turn the frame is navigated so
 * the content gate starts counting from the load, not from the wait.
 *
 * @param {Object} rt
 * @param {Object} node
 * @param {Function} [onBoot]
 * @returns {boolean} true when the frame was navigated synchronously
 */
function weLayerBootFrame(rt, node, onBoot) {
  const media = node && node.media
  if (!media || !node.hostUrl) {
    return false
  }
  const boot = function boot(why) {
    const box = weLayerFrameBox(media)
    node.bootBox = box.w + 'x' + box.h
    weLayerNote(rt, 'frame-boot:' + node.id + ':' + node.bootBox + (why ? ':' + why : ''))
    try {
      media.setAttribute('src', node.hostUrl)
    } catch (error) {
      weLayerNote(rt, 'frame-src-failed:' + (error && error.message ? error.message : String(error)))
    }
    if (typeof onBoot === 'function') {
      onBoot()
    }
  }
  const view = weLayerViewportBox()
  if (view.w > 0 && view.h > 0) {
    boot('now')
    return true
  }
  const started = Date.now()
  const tick = function waitForViewport() {
    if (rt.disposed || rt.nodes.indexOf(node) === -1) {
      return
    }
    const next = weLayerViewportBox()
    if (next.w > 0 && next.h > 0) {
      boot('waited')
      return
    }
    if (Date.now() - started >= WE_LAYER_FRAME_BOX_WAIT_MS) {
      weLayerNote(rt, 'frame-box-timeout:' + node.id)
      boot('timeout')
      return
    }
    weLayerSetTimeout(rt, tick, WE_LAYER_FRAME_BOX_POLL_MS)
  }
  weLayerNote(rt, 'frame-wait:' + node.id + ':' + view.w + 'x' + view.h)
  weLayerSetTimeout(rt, tick, WE_LAYER_FRAME_BOX_POLL_MS)
  return false
}

/**
 * The CSS `filter` for the wallpaper media, from the settings the panel writes.
 *
 * Mirrors `30-glass`'s `weGlassFilters` (the design makes that function the
 * source of truth and this module the applier). `blur(0px)` is omitted on
 * purpose: a zero-radius blur still promotes the element to its own compositing
 * layer, which costs GPU memory for nothing.
 *
 * @param {Object} s result of weLayerSettings
 * @returns {string}
 */
function weLayerLookFilter(s) {
  const steps = [
    'brightness(' + weLayerRound(s.brightness / 100) + ')',
    'contrast(' + weLayerRound(s.contrast / 100) + ')',
    'saturate(' + weLayerRound(s.saturate / 100) + ')',
  ]
  if (s.wallpaperBlur > 0) {
    steps.push('blur(' + weLayerRound(s.wallpaperBlur) + 'px)')
  }
  return steps.join(' ')
}

/**
 * Keep the scrim film (`scrim` 0–0.9) in step with the settings.
 *
 * One film per layer stack, a child of the root with `z-index:1` so it covers
 * every media node regardless of how many are stacked during a fade. It is not
 * part of any node: a node is destroyed on switch and the film must survive it.
 *
 * @param {Object} s result of weLayerSettings
 * @returns {void}
 */
function weLayerApplyScrim(s) {
  const rt = weLayerRuntime
  const root = rt.root
  if (!root) {
    return
  }
  const alpha = weLayerRound(s.scrim)
  if (!(alpha > 0)) {
    if (rt.scrim && rt.scrim.parentNode) {
      rt.scrim.parentNode.removeChild(rt.scrim)
    }
    rt.scrim = null
    return
  }
  if (!rt.scrim) {
    const doc = weLayerDocument()
    if (!doc) {
      return
    }
    const film = doc.createElement('div')
    film.className = WE_LAYER_SCRIM_CLASS
    film.setAttribute('aria-hidden', 'true')
    film.style.position = 'absolute'
    film.style.top = '0'
    film.style.right = '0'
    film.style.bottom = '0'
    film.style.left = '0'
    film.style.zIndex = '1'
    film.style.pointerEvents = 'none'
    rt.scrim = film
  }
  rt.scrim.style.background = 'rgba(0, 0, 0, ' + alpha + ')'
  if (rt.scrim.parentNode !== root) {
    root.appendChild(rt.scrim)
  }
}

/**
 * Publish the 卡片玻璃 strength as two CSS variables on `<html>`.
 *
 * Both composer-material cards read them: the chat surface card (this module's
 * stylesheet) and the wallpaper panel card (40-panel's inline style). Without
 * this the cards were hard-coded to 55% + 16px, so the slider did nothing —
 * "哪怕调到 20 都还是很浓的虚化" (2026-10-22 report).
 *
 * Mapping: cardBase is a 0–100 percentage of the composer fill, and the blur
 * scales with it (20 → 3.2px, 45 → 7.2px, 100 → 16px), so 20 really is a thin
 * glass and 100 is the full frosted pane.
 *
 * @param {Object} s result of weLayerSettings
 * @returns {void}
 */
function weLayerApplyCardVars(s) {
  const doc = weLayerDocument()
  const root = doc && doc.documentElement
  if (!root || !root.style || typeof root.style.setProperty !== 'function') {
    return
  }
  const pct = Math.max(0, Math.min(100, weLayerRound(s.cardBase)))
  root.style.setProperty('--we-card-pct', pct + '%')
  root.style.setProperty('--we-card-blur', weLayerRound(pct * 0.16) + 'px')
  // Overlay cards (设置 / 定时任务 / 命令中心 …) have their own dial: a modal
  // has to stay readable when the pages behind it are thinned right out, so it
  // must not share 卡片玻璃's value.
  const overlay = Math.max(0, Math.min(100, weLayerRound(s.overlayBase)))
  root.style.setProperty('--we-overlay-pct', overlay + '%')
  root.style.setProperty('--we-overlay-blur', weLayerRound(overlay * 0.16) + 'px')
  // The card rules in WE_LAYER_CSS are all rooted at `[data-we-card]`, so this
  // attribute — not the stylesheet — is what turns 卡片化 on and off. Absent
  // means the stock full-bleed surfaces.
  if (typeof root.setAttribute === 'function' && typeof root.removeAttribute === 'function') {
    if (s.uiCards === false) {
      root.removeAttribute('data-we-card')
    } else {
      root.setAttribute('data-we-card', '1')
    }
  }
}

/**
 * Apply the look-ish settings that belong to the media element itself. Kept
 * separate from the glass module: object-fit / mirroring / playback rate are
 * properties of the *source*, not of the glass panel.
 *
 * @param {Object} node
 * @param {Object} settings result of weLayerSettings
 */
function weLayerApplySettings(node, settings) {
  if (!node || !node.media) {
    return
  }
  const media = node.media
  const s = settings || weLayerSettings()
  // A fallback still is the gallery preview, not the wallpaper. WE previews are
  // commonly 1:1 (measured 2026-10-24: 1024×1024 for a 3840×2160 scene), so
  // `cover` in a 16:9 window upscaled it ~2.5× and cut 44% of the height — on
  // screen that reads as "the wallpaper suddenly zoomed in". `contain` keeps the
  // preview whole; when the preview already matches the window it is identical.
  media.style.objectFit = node.fallback ? 'contain' : s.objectFit
  media.style.transform = s.flip ? 'scaleX(-1)' : ''
  // Look chain (§8.2 step 7). The filter and the wallpaper opacity land on the
  // MEDIA element, never on the layer box: the box opacity is the F24 stacking
  // guarantee and is also what the switch-in keyframes animate, so a look
  // opacity written there would be overwritten by the animation and then snap
  // at the end of the fade.
  media.style.filter = weLayerLookFilter(s)
  media.style.opacity = String(weLayerRound(s.wallpaperOpacity / 100))
  weLayerApplyScrim(s)
  weLayerApplyCardVars(s)
  if (weLayerTagOf(media) === 'video') {
    media.loop = true
    try {
      media.muted = s.videoMuted
      media.defaultMuted = s.videoMuted
    } catch (error) {
      // a locked-down element may refuse; not worth a toast
    }
    if (s.videoMuted) {
      try {
        media.volume = 0
      } catch (error) {
        // ignore
      }
    } else {
      try {
        media.volume = s.videoVolume
      } catch (error) {
        // ignore
      }
    }
    try {
      media.playbackRate = s.playbackRate
    } catch (error) {
      // jsdom/older engines: keep the default rate
    }
  }
}

/**
 * @param {Object} node
 */
function weLayerAttachMediaListeners(rt, node) {
  const media = node && node.media
  if (!media || typeof media.addEventListener !== 'function') {
    return
  }
  const onReady = function onLayerContentReady() {
    // A scene/web frame that booted with no box froze a 1x1 canvas (the
    // renderer measured once, see weLayerViewportBox). If the box has appeared
    // by the time the document loads, re-navigate ONCE so it measures the real
    // size; the reload's own `load` event activates the layer.
    if (
      (node.kind === 'scene' || node.kind === 'web') &&
      node.bootBox === '0x0' &&
      !node.frameRebooted
    ) {
      const box = weLayerFrameBox(media)
      if (box.w > 0 && box.h > 0) {
        node.frameRebooted = true
        node.bootBox = box.w + 'x' + box.h
        weLayerNote(rt, 'frame-reboot:' + node.id + ':' + node.bootBox)
        try {
          media.setAttribute('src', node.hostUrl)
          return
        } catch (error) {
          node.frameRebooted = false
        }
      }
    }
    weLayerContentReady(rt, node)
  }
  const onError = function onLayerContentError() {
    weLayerContentFailed(rt, node, 'error')
  }
  const pairs =
    node.kind === 'video'
      ? [
          ['loadeddata', onReady],
          ['canplay', onReady],
          ['error', onError],
        ]
      : [
          ['load', onReady],
          ['error', onError],
        ]
  for (const pair of pairs) {
    media.addEventListener(pair[0], pair[1])
    node.handlers.push({ type: pair[0], fn: pair[1] })
  }
}

/** @param {Object} node */
function weLayerDetachMediaListeners(node) {
  if (!node || !node.media || !node.handlers || node.handlers.length === 0) {
    return
  }
  for (const handler of node.handlers) {
    try {
      node.media.removeEventListener(handler.type, handler.fn)
    } catch (error) {
      // ignore: a detached element may refuse
    }
  }
  node.handlers = []
}

/**
 * §7.2 teardown: `video.pause(); src=''; load(); remove`. Listeners go first so
 * the deliberate `src=''` cannot be mistaken for a media failure.
 *
 * @param {Object} node
 */
function weLayerReleaseMedia(node) {
  const media = node && node.media
  if (!media) {
    return
  }
  weLayerDetachMediaListeners(node)
  try {
    if (typeof media.pause === 'function') {
      media.pause()
    }
  } catch (error) {
    // ignore
  }
  try {
    if (weLayerTagOf(media) === 'iframe') {
      // A scene render page: navigating it away stops the WebGL loop and the
      // page's own timers. `src=''` would re-load the *current* document, so
      // about:blank is the deliberate park.
      media.setAttribute('src', 'about:blank')
    } else {
      media.removeAttribute('src')
      media.src = ''
    }
  } catch (error) {
    // ignore
  }
  if (weLayerTagOf(media) === 'video' && typeof media.load === 'function') {
    try {
      media.load()
    } catch (error) {
      // jsdom and some engines throw "not implemented"; nothing to recover
    }
  }
  node.media = media
}

/**
 * Destroy a live layer: release its media, unmount it, drop it from the stack.
 *
 * @param {Object} rt
 * @param {Object} node
 * @param {string} reason  diagnostic only
 */
function weLayerDestroyNode(rt, node, reason) {
  if (!node) {
    return
  }
  weLayerReleaseMedia(node)
  if (node.el && node.el.parentNode) {
    node.el.parentNode.removeChild(node.el)
  }
  rt.nodes = rt.nodes.filter(function keep(candidate) {
    return candidate !== node
  })
  if (rt.pending === node) {
    rt.pending = null
  }
  weLayerNote(rt, 'destroy:' + node.id + ':' + reason)
}

/** @param {Object} rt @returns {Object|null} newest (topmost) layer */
function weLayerTop(rt) {
  return rt.nodes.length > 0 ? rt.nodes[rt.nodes.length - 1] : null
}

// --------------------------------------------------------------------------- //
// playback
// --------------------------------------------------------------------------- //

/** @param {Object} rt @param {Object} node */
function weLayerPlay(rt, node) {
  const media = node && node.media
  if (!media || typeof media.play !== 'function' || rt.paused) {
    return
  }
  try {
    const result = media.play()
    if (result && typeof result.then === 'function') {
      result.then(null, function onRejected(error) {
        weLayerNote(rt, 'play-rejected:' + (error && error.message ? error.message : String(error)))
      })
    }
  } catch (error) {
    weLayerNote(rt, 'play-threw:' + (error && error.message ? error.message : String(error)))
  }
}

/** @param {Object} node */
function weLayerPause(rt, node, reason) {
  const media = node && node.media
  rt.paused = true
  rt.pauseReason = reason || 'paused'
  if (!media || typeof media.pause !== 'function') {
    return
  }
  try {
    media.pause()
  } catch (error) {
    // ignore
  }
}

// --------------------------------------------------------------------------- //
// content-reveal gate (§7.4, F22 timers)
// --------------------------------------------------------------------------- //

/**
 * Schedule through `ctx.setTimeout` and hand back a disposer-shaped function.
 * There is no timer object on ctx (F22) and a bare global timer would survive
 * plugin unload, so this is the only scheduling path in this file.
 *
 * @param {Object} rt
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function} disposer (never throws)
 */
function weLayerSetTimeout(rt, fn, ms) {
  const ctx = rt.ctx
  if (!ctx || typeof ctx.setTimeout !== 'function') {
    weLayerNote(rt, 'timer-unavailable')
    return function noop() {}
  }
  try {
    const dispose = ctx.setTimeout(fn, ms)
    return typeof dispose === 'function' ? dispose : function noop() {}
  } catch (error) {
    weLayerNote(rt, 'timer-failed:' + (error && error.message ? error.message : String(error)))
    return function noop() {}
  }
}

/** @param {Object} rt */
function weLayerClearGate(rt) {
  const gate = rt.gate
  rt.gate = null
  if (gate && typeof gate.dispose === 'function') {
    try {
      gate.dispose()
    } catch (error) {
      // ignore
    }
  }
}

/**
 * How long this node gets before "not on screen in time" counts as a failure.
 * A still or a video signals readiness itself and quickly; a scene/web iframe
 * has to boot a renderer document first and is measured in seconds.
 *
 * @param {Object} node
 * @returns {number} milliseconds
 */
function weLayerGateMs(node) {
  return node && (node.kind === 'scene' || node.kind === 'web')
    ? WE_LAYER_HEAVY_TIMEOUT_MS
    : WE_LAYER_CONTENT_TIMEOUT_MS
}

/**
 * Drop the armed auto-retry. `resetCount` also forgets the attempts, which is
 * what a new user selection and a successful live activation both want.
 *
 * @param {Object} rt
 * @param {boolean} [resetCount]
 */
function weLayerClearRetry(rt, resetCount) {
  const dispose = rt.retryTimer
  rt.retryTimer = null
  if (typeof dispose === 'function') {
    try {
      dispose()
    } catch (error) {
      // ignore
    }
  }
  if (resetCount) {
    rt.retryCount = 0
    rt.retryItemId = null
  }
}

/**
 * Arm one bounded retry of the live layer after it degraded to the still
 * preview. Without this the fallback is permanent: `currentId` is kept on
 * purpose (so a store notification cannot loop on a broken wallpaper), which
 * also means nothing ever rebuilds the live layer — that is why a cold-start
 * miss left the preview (a square thumbnail, cropped by `cover`) on screen
 * until the user re-picked the wallpaper by hand.
 *
 * @param {Object} rt
 * @param {*} item
 * @param {string} reason
 */
function weLayerArmRetry(rt, item, reason) {
  weLayerClearRetry(rt, false)
  if (!rt.mounted || rt.disposed || !item || typeof item.id !== 'string' || !item.id) {
    return
  }
  if (rt.retryItemId !== item.id) {
    rt.retryItemId = item.id
    rt.retryCount = 0
  }
  if (rt.retryCount >= WE_LAYER_RETRY_MAX) {
    weLayerNote(rt, 'retry-exhausted:' + item.id + ':' + reason)
    return
  }
  rt.retryTimer = weLayerSetTimeout(
    rt,
    function onFallbackRetry() {
      rt.retryTimer = null
      if (!rt.mounted || rt.disposed) {
        return
      }
      // The selection moved on, or a live load is already in flight: not our race.
      if (rt.currentId !== item.id) {
        return
      }
      if (rt.pending && !rt.pending.fallback) {
        return
      }
      const top = weLayerTop(rt)
      if (top && !top.fallback && top.state === 'active') {
        return
      }
      rt.retryCount += 1
      weLayerNote(rt, 'retry:' + item.id + ':' + rt.retryCount)
      weLayerReload(rt.ctx)
    },
    WE_LAYER_RETRY_DELAY_MS,
  )
}

/**
 * Arm the 2s content gate for one node. Expiry means "not on screen in time",
 * which is the same event as a load error: both go to `fallback`.
 *
 * @param {Object} rt
 * @param {Object} node
 */
function weLayerArmReveal(rt, node) {
  weLayerClearGate(rt)
  const gate = { node, generation: rt.generation, dispose: null }
  rt.gate = gate
  gate.dispose = weLayerSetTimeout(
    rt,
    function onContentGateTimeout() {
      if (rt.gate !== gate) {
        return
      }
      rt.gate = null
      weLayerNote(rt, 'gate-timeout:' + node.id)
      weLayerContentFailed(rt, node, 'timeout')
    },
    weLayerGateMs(node),
  )
}

// --------------------------------------------------------------------------- //
// state machine (§7.4) — these are the only writers of store.layer
// --------------------------------------------------------------------------- //

/**
 * `loaded` for the pending node.
 *
 * @param {Object} rt
 * @param {Object} node
 */
function weLayerContentReady(rt, node) {
  if (!rt.mounted || rt.disposed || !node) {
    return
  }
  if (rt.nodes.indexOf(node) === -1 || node !== rt.pending) {
    // A late event from a superseded node: it is already out of the stack.
    return
  }
  if (node.fallback) {
    weLayerActivateStatic(rt, node)
    return
  }
  weLayerActivate(rt, node)
}

/**
 * loading --loaded--> active, and the old layer's funeral.
 *
 * The incoming layer is snapped to `opacity:1` (its fade-in class is removed)
 * *before* the outgoing layer is destroyed, in the same turn: if the underlay
 * disappeared while the new layer was still translucent the glass
 * `backdrop-filter` would briefly sample the bare page background — the exact
 * breakthrough F24 exists to prevent. Consequence: the fade is visible only
 * while the content is still loading; a slow load ends in a cut, not a flash.
 *
 * @param {Object} rt
 * @param {Object} node
 */
function weLayerActivate(rt, node) {
  weLayerClearGate(rt)
  // The live layer is on screen: forget the attempts, so a later failure of a
  // different wallpaper gets the full budget again.
  weLayerClearRetry(rt, true)
  rt.pending = null
  node.state = 'active'
  node.retired = false
  node.el.classList.remove(WE_LAYER_IN_CLASS)
  node.el.setAttribute('data-we-state', 'active')
  for (const other of rt.nodes.slice()) {
    if (other !== node) {
      weLayerDestroyNode(rt, other, 'activated')
    }
  }
  rt.mode = 'live'
  if (weGetState().layer !== WE_LAYER.ACTIVE) {
    weSet({ layer: WE_LAYER.ACTIVE })
  }
  weLayerPlay(rt, node)
  weLayerNote(rt, 'active:' + node.id)
  // Only once the store carries the live backend's answer: before that, a
  // "load" can be the dead snapshot port's chrome-error page (see the poster
  // block) and the still must stay.
  if (rt.bootstrapDone) {
    weLayerPosterRetire(rt)
  }
}

/**
 * `fallback --preview loaded--> active-static`. The accepted layer enum has no
 * `active-static` value, so an active still is reported as `fallback` and
 * flagged by `weLayerState().mode === 'static'` (documented deviation).
 *
 * @param {Object} rt
 * @param {Object} node
 */
function weLayerActivateStatic(rt, node) {
  weLayerClearGate(rt)
  rt.pending = null
  node.state = 'active'
  node.retired = false
  node.el.setAttribute('data-we-state', 'static')
  for (const other of rt.nodes.slice()) {
    if (other !== node) {
      weLayerDestroyNode(rt, other, 'static-activated')
    }
  }
  rt.mode = 'static'
  if (weGetState().layer !== WE_LAYER.FALLBACK) {
    weSet({ layer: WE_LAYER.FALLBACK })
  }
  weLayerNote(rt, 'static-active:' + node.id)
  if (rt.bootstrapDone) {
    weLayerPosterRetire(rt)
  }
}

/**
 * `loading --timeout/error--> fallback` and `fallback --preview failed--> idle`.
 * One entry point for both, because a preview that never loads and a media that
 * never loads differ only in which branch runs afterwards.
 *
 * @param {Object} rt
 * @param {Object} node
 * @param {string} reason
 */
function weLayerContentFailed(rt, node, reason) {
  if (!node || node !== rt.pending) {
    return
  }
  weLayerClearGate(rt)
  rt.pending = null

  if (node.fallback) {
    // fallback --preview failed--> idle (+ toast)
    weLayerNote(rt, 'preview-failed:' + reason)
    weLayerDestroyNode(rt, node, 'preview-failed')
    weLayerStop(rt, WE_LAYER.IDLE, true)
    weSet({ toast: weToast('壁纸预览图加载失败', WE_TOAST.ERROR) })
    return
  }

  weLayerNote(rt, 'media-failed:' + node.id + ':' + reason)
  // The still preview is not on screen yet, so the old layer keeps the pixels
  // until it is (same glass argument as the fade branch).
  weLayerDestroyNode(rt, node, 'media-' + reason)
  weLayerFallback(rt, node.item, reason)
}

/**
 * Build the still-preview layer. `currentId` survives a failed wallpaper: the
 * selection is still valid, only its live rendering failed, and keeping the id
 * stops the next store notification from retrying the same failing item.
 *
 * @param {Object} rt
 * @param {*} item
 * @param {string} reason
 */
function weLayerFallback(rt, item, reason) {
  // The fallback node IS the preview; drop the cached still so the two do not
  // stack (and so a stale poster never outlives the wallpaper it belonged to).
  weLayerPosterClear(rt)
  const state = weGetState()
  const url = weLayerPreviewUrl(state, item)
  if (!url) {
    weLayerNote(rt, 'fallback-none:' + reason)
    weLayerStop(rt, WE_LAYER.IDLE, true)
    weSet({ toast: weToast('壁纸加载失败：' + weLayerReasonText(reason), WE_TOAST.ERROR) })
    return
  }
  const keep = weLayerTop(rt)
  for (const other of rt.nodes.slice()) {
    if (other !== keep) {
      weLayerDestroyNode(rt, other, 'fallback-superseded')
    }
  }
  if (keep) {
    // never faded out (F24): it stays opaque under the preview until that loads
    keep.retired = true
    keep.el.setAttribute('data-we-state', 'retired')
  }
  const node = weLayerCreateNode(item, true)
  if (!node || !rt.root) {
    weLayerNote(rt, 'no-root:fallback')
    weLayerStop(rt, WE_LAYER.IDLE, true)
    return
  }
  node.generation = rt.generation
  weLayerApplySettings(node, weLayerSettings(state))
  rt.nodes.push(node)
  rt.pending = node
  weLayerAttachMediaListeners(rt, node)
  rt.root.appendChild(node.el)
  weLayerArmReveal(rt, node)
  node.media.src = url
  if (weGetState().layer !== WE_LAYER.FALLBACK) {
    weSet({ layer: WE_LAYER.FALLBACK })
  }
  weLayerNote(rt, 'fallback:' + reason)
  weLayerArmRetry(rt, item, reason)
}

/**
 * Tear everything down and land on a terminal layer value. `keepId` preserves
 * `currentId` for the "the selection is fine, its rendering is not" cases.
 *
 * @param {Object} rt
 * @param {string} nextLayer one of WE_LAYER
 * @param {boolean} [keepId]
 */
function weLayerStop(rt, nextLayer, keepId) {
  rt.generation += 1
  weLayerClearGate(rt)
  weLayerPosterClear(rt)
  rt.pending = null
  for (const node of rt.nodes.slice()) {
    weLayerDestroyNode(rt, node, 'stop')
  }
  rt.nodes = []
  if (!keepId) {
    rt.currentId = null
    rt.skippedId = null
    rt.originUsed = ''
  }
  rt.mode = 'idle'
  rt.paused = false
  rt.pauseReason = null
  if (nextLayer && weGetState().layer !== nextLayer) {
    weSet({ layer: nextLayer })
  }
  weLayerNote(rt, 'stop:' + nextLayer + (keepId ? ':keep-id' : ''))
}

/**
 * The `setCurrent` event (§7.4). Guards, URL, then the cut/fade fork.
 *
 * @param {*} ctx
 * @param {*} item  WallpaperItem or null
 */
function weLayerSetCurrent(ctx, item) {
  const rt = weLayerRuntime
  if (rt.disposed) {
    return
  }
  if (ctx && !rt.ctx) {
    rt.ctx = ctx
  }
  const state = weGetState()
  const settings = weLayerSettings(state)

  // any --disabled--> idle (the guard that outranks every other row)
  if (!settings.enabled) {
    weLayerStop(rt, WE_LAYER.IDLE)
    return
  }

  if (!item || typeof item.id !== 'string' || !item.id) {
    weLayerStop(rt, WE_LAYER.IDLE)
    return
  }

  const playable = weIsPlayable(item)
  const renderable = playable && WE_LAYER_RENDERED_KINDS.indexOf(item.kind) !== -1

  // A store notification for the wallpaper that is already on screen, already
  // failing, or already refused must not restart anything — only re-apply its
  // settings. This guard sits above every branch that writes the store,
  // otherwise a refusal/diagnostic write would re-enter here and loop.
  if (item.id === rt.currentId || item.id === rt.skippedId) {
    const top = weLayerTop(rt)
    if (top) {
      weLayerApplySettings(top, settings)
    }
    return
  }

  if (!renderable) {
    // `application` is not playable at all (needs an external process), and
    // `web`/`scene` need the WebWallGL host, which is not this module. Either
    // way: no layer is built and `layer` stays idle — never a fake `active`.
    weLayerNote(rt, 'skip:' + String(item.kind) + (playable ? ':deferred' : ':unsupported'))
    weLayerStop(rt, WE_LAYER.IDLE)
    rt.skippedId = item.id
    if (playable) {
      weSet({ toast: weToast('该壁纸类型暂不支持实时渲染：' + String(item.kind), WE_TOAST.INFO) })
    }
    return
  }

  rt.skippedId = null
  // Remember which media-server origin this mount's URLs come from; a cold
  // start hydrates a stale one and `weLayerSync` re-mounts when the live one
  // arrives (see weLayerRuntime.originUsed).
  rt.originUsed = weMediaOrigin(state)

  // Refresh the launch poster for the next start (cheap, off the critical path;
  // silently skipped when the origin is still the dead snapshot port).
  weLayerPosterCapture(rt.ctx || ctx, item, weLayerPreviewUrl(state, item))

  const url = weLayerPlayUrl(state, item)
  if (!url) {
    // No media origin (server down) or no play URL: degrade exactly like a load
    // failure — preview if we have one, otherwise idle + toast.
    const hasPlayUrl = !!(item.play && typeof item.play.url === 'string' && item.play.url)
    const reason = hasPlayUrl ? 'no-media-origin' : 'no-url'
    weLayerNote(rt, reason + ':' + item.id)
    rt.currentId = item.id
    weLayerFallback(rt, item, reason)
    return
  }

  if (!rt.root) {
    const doc = weLayerDocument()
    if (doc) {
      weLayerEnsureStyle(doc)
      weLayerEnsureRoot(doc)
    }
  }
  if (!rt.root) {
    weLayerNote(rt, 'no-root:set-current')
    return
  }

  // Under the live node: last session's still, so the screen is never empty
  // while this mount is still fetching/decoding.
  weLayerPosterShow(rt, item)

  const transition = settings.switchTransition
  // Cold start: nothing of ours is on screen yet (first mount of this session,
  // or the origin-changed rebuild after the dead-port nodes were dropped). With
  // no underlay to cross-fade from, the 1800ms base is pure delay — use the
  // short cold fade instead. Checked BEFORE the retire loop below, which pins
  // the outgoing layer for a real switch.
  const coldStart = rt.nodes.length === 0
  const fadeMs = coldStart ? WE_LAYER_COLD_FADE_MS : settings.fadeMs
  rt.generation += 1
  rt.currentId = item.id
  rt.mode = 'live'
  rt.transition = transition
  weLayerClearGate(rt)
  rt.pending = null

  if (transition === 'cut') {
    // T16d: hard cut — every existing layer is retired *now*, before the new
    // content is ready, and no transition class is involved at any point.
    for (const node of rt.nodes.slice()) {
      weLayerDestroyNode(rt, node, 'cut')
    }
  } else {
    // F24: the outgoing layer is pinned at opacity:1 and stays in the DOM. It
    // is marked retired (no longer the source of truth) but keeps its pixels so
    // the glass keeps sampling a real wallpaper, and it is never faded out.
    const keep = weLayerTop(rt)
    for (const node of rt.nodes.slice()) {
      if (node !== keep) {
        weLayerDestroyNode(rt, node, 'fade-superseded')
      }
    }
    if (keep) {
      keep.retired = true
      keep.el.setAttribute('data-we-state', 'retired')
      keep.el.style.opacity = '1'
    }
  }

  if (weGetState().layer !== WE_LAYER.LOADING) {
    weSet({ layer: WE_LAYER.LOADING })
  }

  const node = weLayerCreateNode(item, false)
  if (!node) {
    weLayerNote(rt, 'no-node')
    weSet({ layer: WE_LAYER.ERROR })
    return
  }
  node.generation = rt.generation
  weLayerApplySettings(node, settings)
  if (transition === 'fade') {
    node.el.classList.add(WE_LAYER_IN_CLASS)
    node.el.style.animationDuration = fadeMs + 'ms'
    // Belt to the class removal in weLayerActivate: `animation-fill-mode: both`
    // pins the element to the animation's CURRENT frame, and a fade that never
    // completes (event lost, tab throttled, animation disabled by the host)
    // leaves it stuck at `from{opacity:0}` — an invisible layer over a live
    // video (readyState 4, no error, nothing on screen). Snapping is idempotent
    // and only ever moves opacity UP, so it cannot fight the real fade.
    weLayerSetTimeout(rt, function snapRevealed() {
      if (rt.nodes.indexOf(node) === -1) {
        return
      }
      if (node.el.classList.contains(WE_LAYER_IN_CLASS)) {
        node.el.classList.remove(WE_LAYER_IN_CLASS)
        node.el.style.animationDuration = ''
        weLayerNote(rt, 'fade-snap:' + node.id)
      }
    }, fadeMs + 80)
    // The snap timer is deliberately NOT registered as a node handler: a node
    // handler is disposed when the node retires, and a retiring node must not
    // cancel its own reveal. The `rt.nodes` guard above is what makes a stray
    // fire harmless after teardown.
  }
  rt.nodes.push(node)
  rt.pending = node
  // Listeners before `src`: a resource that resolves immediately still lands on
  // a node that is already wired.
  weLayerAttachMediaListeners(rt, node)
  rt.root.appendChild(node.el)
  if ((node.kind === 'scene' || node.kind === 'web') && node.hostUrl) {
    // The content gate starts when the frame is actually navigated: on a cold
    // start the frame may wait for the window to get a viewport, and that wait
    // must not eat the scene's 15s budget.
    weLayerBootFrame(rt, node, function armOnFrameBoot() {
      weLayerArmReveal(rt, node)
    })
  } else {
    weLayerArmReveal(rt, node)
  }
  try {
    // A scene/web src is the render-page URL built in weLayerCreateNode; the
    // play URL (`/s/<token>/<entry>`) is NOT a document the iframe can load —
    // assigning it would replace the renderer with a raw asset download.
    if (node.kind !== 'scene' && node.kind !== 'web') {
      node.media.src = url
    }
    if (weLayerTagOf(node.media) === 'video' && typeof node.media.load === 'function') {
      node.media.load()
    }
  } catch (error) {
    weLayerNote(rt, 'src-failed:' + (error && error.message ? error.message : String(error)))
  }
  weLayerNote(rt, 'load:' + item.id + ':' + transition)
}

// --------------------------------------------------------------------------- //
// store reconciliation, mount, dispose
// --------------------------------------------------------------------------- //

/**
 * Reconcile the DOM with the store. Called on every store notification, so it
 * must be idempotent and must not fight the state machine: when the selection
 * is unchanged it only re-applies settings.
 *
 * @param {*} ctx
 */
function weLayerSync(ctx) {
  const rt = weLayerRuntime
  if (!rt.mounted || rt.disposed) {
    return
  }
  const state = weGetState()
  const settings = weLayerSettings(state)

  if (!settings.enabled) {
    if (rt.nodes.length > 0 || rt.currentId !== null) {
      weLayerStop(rt, WE_LAYER.IDLE)
    } else if (state.layer !== WE_LAYER.IDLE) {
      weSet({ layer: WE_LAYER.IDLE })
    }
    return
  }

  const item = state.current
  if (!item) {
    if (rt.nodes.length > 0 || rt.currentId !== null) {
      weLayerStop(rt, WE_LAYER.IDLE)
    } else if (state.layer !== WE_LAYER.IDLE) {
      weSet({ layer: WE_LAYER.IDLE })
    }
    return
  }

  if (item.id !== rt.currentId) {
    weLayerSetCurrent(ctx, item)
    return
  }

  // Cold start: the first mount came from the localStorage snapshot and was
  // built against the PREVIOUS backend process's media-server origin (an
  // ephemeral port that is now dead). That frame loads a chrome-error page —
  // `load` fires anyway, so the layer claimed `active` with nothing on screen,
  // and the same-id guard above kept it there forever. The bootstrap response
  // carries the live origin; rebuild the layer once when it differs.
  const origin = weMediaOrigin(state)
  if (origin && rt.originUsed !== origin) {
    weLayerNote(rt, 'origin-changed:' + rt.originUsed + '->' + origin)
    // The mounted nodes were built against a dead port: their frames hold a
    // chrome-error document that paints nothing, so keeping them as the fade
    // underlay (F24's normal rule) buys nothing and would pin the rebuild to
    // the 1800ms switch fade. Dropping them makes the rebuild a cold start,
    // which gets the short fade and shows the wallpaper ~1.6s sooner.
    for (const node of rt.nodes.slice()) {
      weLayerDestroyNode(rt, node, 'origin-changed')
    }
    rt.currentId = null
    weLayerSetCurrent(ctx, item)
    return
  }

  const top = weLayerTop(rt)
  if (top) {
    weLayerApplySettings(top, settings)
  }
}

/**
 * Explicit retry hook (a "重试" button, or a rotation tick that lands on the
 * already-selected item). A failed or refused selection is *sticky* by design —
 * a store notification must never silently re-attempt a broken wallpaper — so
 * re-applying needs a deliberate call.
 *
 * @param {*} [ctx]
 */
function weLayerReload(ctx) {
  const rt = weLayerRuntime
  if (!rt.mounted || rt.disposed) {
    return
  }
  rt.currentId = null
  rt.skippedId = null
  weLayerSync(ctx || rt.ctx)
}

/** @param {Object} rt */
function weLayerAttachWindowListeners(rt) {
  const doc = weLayerDocument()
  const win = typeof window === 'undefined' ? null : window
  if (doc && typeof doc.addEventListener === 'function') {
    const onVisibility = function onVisibilityChange() {
      weLayerApplyVisibility(rt)
    }
    doc.addEventListener('visibilitychange', onVisibility)
    rt.listeners.push({ target: doc, type: 'visibilitychange', fn: onVisibility })
  }
  if (win && typeof win.addEventListener === 'function') {
    const onBlur = function onWindowBlur() {
      const settings = weLayerSettings(weGetState())
      const top = weLayerTop(rt)
      if (settings.pauseOnBlur && top) {
        weLayerPause(rt, top, 'blur')
      }
    }
    const onFocus = function onWindowFocus() {
      const top = weLayerTop(rt)
      if (rt.pauseReason === 'blur' && top) {
        rt.paused = false
        rt.pauseReason = null
        weLayerPlay(rt, top)
      }
    }
    win.addEventListener('blur', onBlur)
    win.addEventListener('focus', onFocus)
    rt.listeners.push({ target: win, type: 'blur', fn: onBlur })
    rt.listeners.push({ target: win, type: 'focus', fn: onFocus })
  }
}

/** @param {Object} rt */
function weLayerDetachWindowListeners(rt) {
  for (const entry of rt.listeners) {
    try {
      entry.target.removeEventListener(entry.type, entry.fn)
    } catch (error) {
      // ignore
    }
  }
  rt.listeners = []
}

/**
 * `active --visibility hidden--> paused` (§7.4) and back. The accepted layer
 * enum has no `paused` value and `store.layer` must stay inside it, so the
 * pause is a runtime flag plus a `media.pause()`; `store.layer` stays `active`.
 *
 * @param {Object} rt
 */
function weLayerApplyVisibility(rt) {
  const doc = weLayerDocument()
  if (!doc) {
    return
  }
  const settings = weLayerSettings(weGetState())
  const hidden = doc.visibilityState === 'hidden'
  const top = weLayerTop(rt)
  if (hidden && settings.pauseOnHidden) {
    if (top) {
      weLayerPause(rt, top, 'hidden')
    } else {
      rt.paused = true
      rt.pauseReason = 'hidden'
    }
    return
  }
  if (!hidden && rt.pauseReason === 'hidden') {
    rt.paused = false
    rt.pauseReason = null
    if (top) {
      weLayerPlay(rt, top)
    }
  }
}

/**
 * Mount the layer for this plugin load: stylesheet, host box, store
 * subscription, visibility listeners, first reconciliation. Idempotent for the
 * same ctx (a second call is just a sync) and self-healing across a remount.
 *
 * @param {*} ctx
 * @returns {Object} the runtime (inspection handle)
 */
function weLayerMount(ctx) {
  const rt = weLayerRuntime
  if (rt.mounted && !rt.disposed) {
    if (ctx) {
      rt.ctx = ctx
    }
    weLayerSync(rt.ctx)
    return rt
  }
  if (rt.mounted) {
    weLayerDispose()
  }
  const doc = weLayerDocument()
  rt.ctx = ctx || null
  rt.mounted = true
  rt.disposed = false
  rt.nodes = []
  rt.scrim = null
  rt.pending = null
  rt.gate = null
  weLayerClearRetry(rt, true)
  rt.currentId = null
  rt.skippedId = null
  rt.mode = 'idle'
  rt.paused = false
  rt.pauseReason = null
  rt.generation = 0
  rt.notes = []
  if (!doc) {
    weLayerNote(rt, 'no-document')
    return rt
  }
  weLayerEnsureStyle(doc)
  weLayerEnsureRoot(doc)
  weLayerAttachWindowListeners(rt)
  rt.unsubscribe = weSubscribe(function onStoreChange() {
    weLayerSync(rt.ctx)
  })
  weLayerApplyVisibility(rt)
  weLayerSync(rt.ctx)
  return rt
}

/**
 * Full teardown: timers, listeners, subscription, every layer, the host box and
 * the stylesheet. `settings.enabled=false` uses the narrower `weLayerStop`;
 * plugin unload / remount uses this.
 */
function weLayerDispose() {
  const rt = weLayerRuntime
  rt.generation += 1
  weLayerClearGate(rt)
  weLayerClearRetry(rt, true)
  weLayerDetachWindowListeners(rt)
  if (rt.unsubscribe) {
    try {
      rt.unsubscribe()
    } catch (error) {
      // ignore
    }
    rt.unsubscribe = null
  }
  for (const node of rt.nodes.slice()) {
    weLayerDestroyNode(rt, node, 'dispose')
  }
  rt.nodes = []
  rt.pending = null
  if (rt.root && rt.root.parentNode) {
    rt.root.parentNode.removeChild(rt.root)
  }
  rt.root = null
  if (rt.backdrop && rt.backdrop.parentNode) {
    rt.backdrop.parentNode.removeChild(rt.backdrop)
  }
  rt.backdrop = null
  rt.poster = null
  rt.scrim = null
  if (rt.styleEl && rt.styleEl.parentNode) {
    rt.styleEl.parentNode.removeChild(rt.styleEl)
  }
  rt.styleEl = null
  // The card-glass variables are ours; drop them with the layer so the panel
  // falls back to its own defaults and no stale blur outlives the wallpaper.
  {
    const doc = weLayerDocument()
    const html = doc && doc.documentElement
    if (html && html.style && typeof html.style.removeProperty === 'function') {
      html.style.removeProperty('--we-card-pct')
      html.style.removeProperty('--we-card-blur')
      html.style.removeProperty('--we-overlay-pct')
      html.style.removeProperty('--we-overlay-blur')
    }
    if (html && typeof html.removeAttribute === 'function') {
      html.removeAttribute('data-we-card')
    }
  }
  // Put `<html>`'s background back exactly as we found it. Empty means the
  // property was never set inline, so it is REMOVED rather than set to '' —
  // leaving an empty inline value is not the same as having none.
  if (rt.htmlBaseline !== null) {
    const html = rt.htmlOwner
    if (html && html.style) {
      if (rt.htmlBaseline) {
        html.style.setProperty('background-color', rt.htmlBaseline)
      } else {
        html.style.removeProperty('background-color')
      }
    }
    rt.htmlBaseline = null
    rt.htmlOwner = null
    if (rt.bodyBaseline !== null && rt.bodyOwner && rt.bodyOwner.style) {
      if (rt.bodyBaseline) {
        rt.bodyOwner.style.setProperty('background', rt.bodyBaseline)
      } else {
        rt.bodyOwner.style.removeProperty('background')
      }
    }
    rt.bodyBaseline = null
    rt.bodyOwner = null
    const owners = rt.shellOwner || []
    const baselines = rt.shellBaseline || []
    for (let i = 0; i < owners.length; i += 1) {
      const painter = owners[i]
      if (!painter || !painter.style) {
        continue
      }
      if (baselines[i]) {
        painter.style.setProperty('background-color', baselines[i])
      } else {
        painter.style.removeProperty('background-color')
      }
    }
    rt.shellBaseline = null
    rt.shellOwner = null
  }
  rt.currentId = null
  rt.skippedId = null
  rt.mode = 'idle'
  rt.paused = false
  rt.pauseReason = null
  rt.mounted = false
  rt.disposed = true
  rt.ctx = null
  if (weGetState().layer !== WE_LAYER.IDLE) {
    weSet({ layer: WE_LAYER.IDLE })
  }
  weLayerNote(rt, 'dispose')
}

// --------------------------------------------------------------------------- //
// inspection (tests + a future diagnostics panel)
// --------------------------------------------------------------------------- //

/** @returns {*} the host box currently in the document, or null */
function weLayerRoot() {
  return weLayerRuntime.root
}

/**
 * Plain snapshot of the layer's runtime state. Deliberately returns data, not
 * node references, so a test can assert the DOM facts (opacity/classes/src)
 * without reaching into the module.
 *
 * @returns {Object}
 */
function weLayerState() {
  const rt = weLayerRuntime
  return {
    mounted: rt.mounted,
    disposed: rt.disposed,
    currentId: rt.currentId,
    mode: rt.mode,
    paused: rt.paused,
    pauseReason: rt.pauseReason,
    transition: rt.transition,
    generation: rt.generation,
    gated: !!rt.gate,
    pendingId: rt.pending ? rt.pending.id : null,
    notes: rt.notes.slice(),
    nodes: rt.nodes.map(function describe(node) {
      return {
        id: node.id,
        kind: node.kind,
        fallback: node.fallback,
        state: node.state,
        retired: node.retired,
        generation: node.generation,
        tag: weLayerTagOf(node.media),
        src: node.media && typeof node.media.getAttribute === 'function' ? node.media.getAttribute('src') : null,
        paused: node.media ? node.media.paused === true : null,
        opacity: node.el.style.opacity,
        classes: node.el.className,
        attached: !!node.el.parentNode,
      }
    }),
  }
}
