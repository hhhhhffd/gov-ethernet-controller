#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node --check web/map.js
node --check web/app.js
for file in web/core/*.mjs web/features/*.mjs web/integration/*.mjs; do node --check "$file"; done
node --check web/vendor/leaflet/leaflet.js
node scripts/web-map.test.cjs
node --test web/boundaries.test.cjs web/data-model.test.cjs web/map-popup.test.cjs web/session.test.cjs web/i18n.test.cjs web/theme.test.cjs web/school-search.test.cjs web/school-detail.test.cjs

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
    tileLayer(url, options) { calls.tiles += 1; map.tile = { url, options }; return { on(name, callback) { if (name === "tileerror") map.tileError = callback; return this; }, addTo() { return this; } }; },
  },
  setTimeout(callback) { callback(); },
  LINKWATCH_MAP_CONFIG: { tileTemplate: "https://tiles.example/{z}/{x}/{y}.png" },
};
const context = vm.createContext({ window, document: { getElementById: (id) => ({ id }) } });
vm.runInContext(fs.readFileSync("web/map.js", "utf8"), context);

const foundation = window.LinkwatchMap;
assert.ok(foundation);
assert.equal(foundation.DEFAULT_CONFIG.tileUrl, "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png");
assert.match(foundation.DEFAULT_CONFIG.attribution, /Stadia Maps/);
assert.match(foundation.DEFAULT_CONFIG.attribution, /OpenMapTiles/);
assert.match(foundation.DEFAULT_CONFIG.attribution, /OpenStreetMap/);
assert.equal(foundation.init({ containerId: "leafletMap" }), map);
assert.equal(foundation.init({ containerId: "leafletMap" }), map);
assert.equal(calls.map, 1, "map must be initialized once");
assert.equal(calls.tiles, 1, "tile layer must be created once");
assert.equal(map.tile.url, "https://tiles.example/{z}/{x}/{y}.png");
foundation.render({ mode: "historical", lineCount: 3 });
assert.equal(calls.invalidations, 1);
assert.equal(typeof map.tileError, "function", "tile failures must be handled by the map foundation");
console.log("web foundation stub: PASS");
NODE

printf 'web foundation checks: PASS\n'
