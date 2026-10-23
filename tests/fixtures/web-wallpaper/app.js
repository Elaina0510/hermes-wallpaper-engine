/* author script — the shim must be installed before this file runs. */
(function () {
  "use strict";
  window.AUTHOR_APP_LOADED = true;
  // Typical workshop pattern: the author registers the listener at top level.
  // The seed runs before this file (it is injected ahead of the author scripts),
  // so the shim replays its pending props through this setter.
  window.wallpaperPropertyListener = {
    applyUserProperties: function (props) {
      window.__SEED_SEEN = props;
    },
    applyGeneralProperties: function (props) {
      window.__GEN_SEEN = props;
    }
  };
})();
