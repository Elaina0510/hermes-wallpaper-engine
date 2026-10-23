// fixtures/build-src/99-register.js — build-input fixture (MOD-014 / T10-T12)
// Sorts last and holds the single `export default` (rule 3).
function weRegister(ctx) {
  const el = weMountLayer(document);
  el.setAttribute("data-fixture", "build");

  const stop = ctx.setInterval(() => {
    weSetState({ boot: true });
  }, 1000);

  ctx.onDispose(() => {
    stop();
    weUnmountLayer();
  });

  return { id: "wallpaper-engine-fixture", layer: el, api: weCoreApi, ids: weLayerIds };
}

export default {
  id: "wallpaper-engine-fixture",
  name: "Wallpaper Engine (build fixture)",
  description: "Build-input fixture; never loaded by the Desktop shell.",
  defaultEnabled: false,
  register: weRegister,
};
