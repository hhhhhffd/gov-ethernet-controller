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
    on(name, callback) { (handlers[name] ||= []).push(callback); return this; },
    trigger(name, event = {}) { (handlers[name] || []).forEach((callback) => callback(event)); return this; },
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
  project([latitude, longitude], zoom) { const scale = 256 * 2 ** zoom / 360; return { x: longitude * scale, y: latitude * scale }; },
  unproject([x, y], zoom) { const scale = 256 * 2 ** zoom / 360; return { lat: y / scale, lng: x / scale }; },
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
    { registryId: "18383", officialName: "Средняя школа №32", address: "ул. Школьная, 32", coordinate: { latitude: 49.988825, longitude: 82.575407 } },
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
assert.equal(current.registryMarkerCount, 4, "invalid registry coordinates must not render markers");
assert.equal(current.monitoringMarkerCount, 1, "unmapped/coordinate-less lines must not render monitoring markers");
assert.equal(current.statuses[0], "NO_INTERNET", "monitoring priority must use NO_INTERNET first");
assert.equal(current.registryVisibleMarkerCount, 2, "nearby registry schools must use a deterministic cluster");
const registryCluster = mapApi.getLayers().registryClusters.items.find((marker) => mapApi.getMarkerContext(marker)?.kind === "registry-cluster");
assert.ok(registryCluster, "nearby registry schools must render a real cluster marker");
const clusterContext = mapApi.getMarkerContext(registryCluster);
assert.equal(clusterContext.lines.length, 0, "registry cluster must not expose operational lines");
assert.ok(clusterContext.members.some((member) => member.registryId === "18383"), "school 32 must remain a cluster member");
assert.ok(map.bounds, "render must fit the map to actual registry/monitoring coordinates");
assert.ok(map.bounds.bounds.some(([latitude, longitude]) => latitude === 50.30 && longitude === 83.40));
registryCluster.trigger("click");
assert.equal(map.bounds.options.maxZoom, 18, "cluster click must fit members through the configured maximum zoom");

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
const browserHarnessSource = fs.readFileSync("scripts/browser-e2e.mjs", "utf8");
assert.doesNotMatch(appSource, /map_x|map_y|index \* 59|index \* 37/, "production app must not synthesize map coordinates");
assert.doesNotMatch(indexSource, /<svg[^>]*class=\"vko-map\"|class=\"map-gridlines\"|id=\"mapMarkers\"/, "Leaflet must be the only production map");
assert.doesNotMatch(mapSource, /fetch\s*\(/, "markers must not issue per-school API calls");
assert.doesNotMatch(mapSource, /permanent\s*:\s*true/, "schools must not receive permanent labels");
assert.doesNotMatch(mapSource, /clusterCellDegrees/, "registry clustering must not use a fixed degree grid");
assert.match(appSource, /registry-cluster/, "cluster popup must have a dedicated neutral path");
assert.match(appSource, /data-popup-registry-id/, "cluster popup must expose selectable registry members");
assert.match(appSource, /operationalError/, "API failure must be represented explicitly");
assert.match(fs.readFileSync("web/integration/map-integration.mjs", "utf8"), /state\.lines = \[\]/, "API failure must clear operational rows");
assert.doesNotMatch(appSource, /sampleLines|sampleIncidents|sampleSituations|demoMode|demoCapabilities|createReplay/, "production app must not contain synthetic/demo operational paths");
assert.doesNotMatch(indexSource, /demoButton|Запустить replay|Айдана К\.|Областной уровень|Policy v14|fixture|synthetic|demo/i, "production scaffold must not contain demo placeholders");
assert.match(indexSource, /id="authenticatedWorkspace"/, "authenticated scaffold is required");
assert.match(indexSource, /id="authBackdrop"/, "login seam is required");
assert.match(indexSource, /id="leafletMap"/, "real Leaflet map container is required");
assert.doesNotMatch(indexSource, /class="(rail|topbar|kpi-grid|notice-bar|activity-panel|situations-panel)/, "deleted legacy composition must not return");
assert.match(indexSource, /class="map-workspace"/, "full-screen map workspace is required");
assert.match(indexSource, /class="primary-nav"/, "primary navigation island is required");
assert.match(indexSource, /id="mapFilter"/, "compact map filter hook is required");
assert.match(indexSource, /id="mapZoomIn"[\s\S]*id="mapZoomOut"[\s\S]*id="mapReset"/, "single custom map tool stack is required");
assert.doesNotMatch(indexSource, /class="(session-bar|map-controls|sidebar|dashboard-grid|kpi-grid|activity-panel|rail)"/, "legacy full-width shell surfaces must stay deleted");
assert.match(fs.readFileSync("web/styles.css", "utf8"), /--ref-canvas-0:\s*#111111/, "Appendix A canvas palette must be applied");
assert.match(browserHarnessSource, /task006-shell-1355x880\.png/, "canonical TASK-006 shell screenshot must be captured");
for (const boundary of ["core/api.mjs", "core/session.mjs", "core/capabilities.mjs", "core/i18n.mjs", "core/theme.mjs", "core/router.mjs", "core/presentation.mjs", "integration/map-integration.mjs", "features/lines.mjs", "features/incidents.mjs", "features/reports.mjs", "features/notifications.mjs", "features/admin.mjs", "features/audit.mjs", "features/provider-case.mjs"]) {
  assert.match(appSource + fs.readFileSync(`web/${boundary}`, "utf8"), new RegExp(boundary.replace(".", "\\.")), `${boundary} must remain part of the frontend boundary`);
}
assert.match(browserHarnessSource, /BROWSER_MAP_FIXTURE/, "explicit browser fixture must remain in acceptance harness");
assert.match(browserHarnessSource, /browser-e2e-test-fixture/, "browser fixture provenance must be explicit");

console.log("web map marker checks: PASS");
