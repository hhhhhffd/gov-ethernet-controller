const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createLayer() {
  return {
    items: [],
    addLayer(layer) { this.items.push(layer); return this; },
    clearLayers() { this.items = []; return this; },
  };
}

function createMarker(latLng, options = {}) {
  const handlers = {};
  return {
    latLng,
    options,
    handlers,
    on(name, callback) { handlers[name] = callback; return this; },
    bindTooltip() { return this; },
  };
}

const map = {
  center: null,
  zoom: 7,
  layers: [],
  bounds: null,
  setView(center, zoom) { this.center = center; this.zoom = zoom; return this; },
  getZoom() { return this.zoom; },
  fitBounds(bounds, options) { this.bounds = { bounds, options }; return this; },
  addLayer(layer) { this.layers.push(layer); return this; },
  removeLayer(layer) { this.layers = this.layers.filter((candidate) => candidate !== layer); return this; },
  on() { return this; },
  invalidateSize() {},
};
const container = { id: "leafletMap" };
const tileLayer = {
  handlers: {},
  on(name, callback) { this.handlers[name] = callback; return this; },
  addTo() { return this; },
};
const tileStatus = { hidden: true, textContent: "" };
const window = {
  L: {
    map() { return map; },
    tileLayer() { return tileLayer; },
    layerGroup: createLayer,
    marker: createMarker,
    divIcon(options) { return options; },
  },
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  dispatchEvent() {},
  setTimeout(callback) { callback(); },
};
const document = { getElementById(id) { return id === "mapTileStatus" ? tileStatus : container; } };
const context = vm.createContext({ window, document });
vm.runInContext(fs.readFileSync("web/map.js", "utf8"), context);

const registry = {
  schools: [
    { registryId: "school-1", officialName: "Школа 1", coordinate: { latitude: 49.90, longitude: 82.50 } },
    { registryId: "school-2", officialName: "Школа 2", coordinate: { latitude: 49.91, longitude: 82.51 } },
    { registryId: "school-3", officialName: "Школа 3", coordinate: { latitude: 50.30, longitude: 83.40 } },
    { registryId: "school-invalid", officialName: "Без координат", coordinate: { latitude: 191, longitude: 82 } },
  ],
};
const lines = [
  { id: "line-ok", registryId: "school-1", registrySchool: registry.schools[0], registryCoordinate: registry.schools[0].coordinate, linkwatchStatus: "OK", latest: { download: 0 } },
  { id: "line-data", registryId: "school-1", registrySchool: registry.schools[0], registryCoordinate: registry.schools[0].coordinate, linkwatchStatus: "NO_DATA", latest: { download: 999 } },
  { id: "line-degraded", registryId: "school-1", registrySchool: registry.schools[0], registryCoordinate: registry.schools[0].coordinate, linkwatchStatus: "DEGRADED" },
  { id: "line-down", registryId: "school-1", registrySchool: registry.schools[0], registryCoordinate: registry.schools[0].coordinate, linkwatchStatus: "NO_INTERNET" },
  { id: "line-no-coordinate", registryId: "school-3", school_name: "legacy coordinates", map_x: 350, map_y: 170, status: "NO_INTERNET" },
];

const mapApi = window.LinkwatchMap;
assert.equal(mapApi.init({ containerId: "leafletMap" }), map);
tileLayer.handlers.tileerror();
assert.equal(tileStatus.hidden, false, "tile failure must be visible without disabling the map");
assert.equal(tileStatus.textContent, "Подложка карты временно недоступна");
tileLayer.handlers.tileload();
assert.equal(tileStatus.hidden, true, "tile status must clear after recovery");
assert.equal(mapApi.render({ mode: "current", registry, lines }), true);
const current = mapApi.getLastRender();
assert.equal(current.registryMarkerCount, 3, "invalid registry coordinates must not render markers");
assert.equal(current.monitoringMarkerCount, 1, "unmapped/coordinate-less lines must not render monitoring markers");
assert.equal(current.statuses[0], "NO_INTERNET", "monitoring priority must use NO_INTERNET first");
assert.equal(current.registryVisibleMarkerCount, 2, "nearby registry schools must use a deterministic cluster");
assert.ok(map.bounds, "render must fit the map to actual registry/monitoring coordinates");
assert.ok(map.bounds.bounds.some(([latitude, longitude]) => latitude === 50.30 && longitude === 83.40));

const monitoringLayer = mapApi.getLayers().monitoring;
assert.equal(monitoringLayer.items.length, 1);
const monitoringContext = mapApi.getMarkerContext(monitoringLayer.items[0]);
assert.equal(monitoringContext.lines.length, 4, "multiple lines stay available on the monitoring context");
assert.equal(monitoringContext.status, "NO_INTERNET");

mapApi.render({ mode: "historical", registry, lines: lines.slice(0, 1), historicalByLine: { "line-ok": { measurement_count: 2 } } });
const historicalContext = mapApi.getMarkerContext(mapApi.getLayers().monitoring.items[0]);
assert.equal(historicalContext.status, "UNKNOWN", "historical mode must not reuse current state");
assert.equal(historicalContext.evidence[0].status, "UNKNOWN", "historical marker evidence must come from the historical summary");

const appSource = fs.readFileSync("web/app.js", "utf8");
const indexSource = fs.readFileSync("web/index.html", "utf8");
const mapSource = fs.readFileSync("web/map.js", "utf8");
assert.doesNotMatch(appSource, /map_x|map_y|index \* 59|index \* 37/, "production app must not synthesize map coordinates");
assert.doesNotMatch(indexSource, /<svg[^>]*class=\"vko-map\"|class=\"map-gridlines\"|id=\"mapMarkers\"/, "Leaflet must be the only production map");
assert.doesNotMatch(mapSource, /fetch\s*\(/, "markers must not issue per-school API calls");
assert.doesNotMatch(mapSource, /permanent\s*:\s*true/, "schools must not receive permanent labels");
assert.match(appSource, /demoMode.*URLSearchParams\(window\.location\.search\)\.get\("demo"\) === "1"/, "demo mode must be explicit");
assert.match(appSource, /state\.lines = state\.demoMode \? sampleLines\.map\(normalizeLine\) : \[\]/, "API failure must not silently use demo lines");

console.log("web map marker checks: PASS");
