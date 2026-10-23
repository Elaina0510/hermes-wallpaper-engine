// fixtures/build-src/00-core.js — build-input fixture (MOD-014 / T10-T12)
// The ONLY file allowed to import: specifiers are restricted to the loader
// whitelist (F2) and must sit at the very top of the file.
import { pluginStorage } from "@hermes/plugin-sdk";
import { useSyncExternalStore } from "react";
import { jsx } from "react/jsx-runtime";

/**
 * @typedef {Object} WeState
 * @property {boolean} boot
 * @property {object|null} config
 * @property {Array<object>} library
 * @property {object|null} current
 * @property {string} layer
 */

/** @type {WeState} */
const weInitialState = Object.freeze({
  boot: false,
  config: null,
  library: [],
  current: null,
  layer: "idle",
});

let weState = weInitialState;
const weListeners = new Set();

function weGetState() {
  return weState;
}

function weSetState(patch) {
  weState = Object.freeze(Object.assign({}, weState, patch));
  weListeners.forEach((listener) => listener(weState));
  return weState;
}

function weSubscribe(listener) {
  weListeners.add(listener);
  return () => weListeners.delete(listener);
}

function weCreateStore() {
  return {
    get: weGetState,
    set: weSetState,
    subscribe: weSubscribe,
    hook: useSyncExternalStore,
    storage: pluginStorage,
    jsx,
  };
}

const weCoreApi = Object.freeze({ store: weCreateStore, version: "fixture" });
