// fixtures/build-src/10-layer.js — build-input fixture (MOD-014 / T10-T12)
// No import/export here (rule 2): top-level function/const only, all symbols
// we-prefixed, collaborating with 00-core.js through the global scope.
let weLayerEl = null;

function weMountLayer(doc) {
  if (weLayerEl) {
    return weLayerEl;
  }
  const el = doc.createElement("div");
  el.setAttribute("data-wallpaper-layer", "");
  el.style.position = "fixed";
  doc.body.appendChild(el);
  weLayerEl = el;
  return el;
}

function weUnmountLayer() {
  if (!weLayerEl) {
    return false;
  }
  weLayerEl.remove();
  weLayerEl = null;
  return true;
}

function weApplyLayerState(state) {
  const el = weLayerEl;
  if (!el) {
    return "no-layer";
  }
  el.setAttribute("data-layer-state", String(state.layer));
  return weGetState().layer;
}

const weLayerIds = Object.freeze(["idle", "video", "image", "web", "scene"]);
