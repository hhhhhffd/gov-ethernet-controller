#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node --check web/map.js
node --check web/app.js
node --check web/vendor/leaflet/leaflet.js

node - <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const index = fs.readFileSync("web/index.html", "utf8");
assert.match(index, /\/static\/vendor\/leaflet\/leaflet\.css/);
assert.match(index, /\/static\/vendor\/leaflet\/leaflet\.js/);
assert.match(index, /\/static\/map\.js/);
assert.doesNotMatch(index, /unpkg\.com|cdnjs\.cloudflare\.com/);

const calls = { map: 0, tiles: 0, invalidations: 0 };
const map = {
  setView(center, zoom) { this.center = center; this.zoom = zoom; return this; },
  invalidateSize() { calls.invalidations += 1; },
  zoomIn() { this.zoom += 1; },
  zoomOut() { this.zoom -= 1; },
};
const window = {
  L: {
    map(container, options) { calls.map += 1; map.container = container; map.options = options; return map; },
    tileLayer(url, options) { calls.tiles += 1; map.tile = { url, options }; return { addTo() { return this; } }; },
  },
  setTimeout(callback) { callback(); },
  LINKWATCH_MAP_CONFIG: { tileTemplate: "https://tiles.example/{z}/{x}/{y}.png" },
};
const context = vm.createContext({ window, document: { getElementById: (id) => ({ id }) } });
vm.runInContext(fs.readFileSync("web/map.js", "utf8"), context);

const foundation = window.LinkwatchMap;
assert.ok(foundation);
assert.equal(foundation.DEFAULT_CONFIG.tileUrl, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
assert.equal(foundation.init({ containerId: "leafletMap" }), map);
assert.equal(foundation.init({ containerId: "leafletMap" }), map);
assert.equal(calls.map, 1, "map must be initialized once");
assert.equal(calls.tiles, 1, "tile layer must be created once");
assert.equal(map.tile.url, "https://tiles.example/{z}/{x}/{y}.png");
foundation.render({ mode: "historical", lineCount: 3 });
assert.equal(calls.invalidations, 1);
console.log("web foundation stub: PASS");
NODE

printf 'web foundation checks: PASS\n'
