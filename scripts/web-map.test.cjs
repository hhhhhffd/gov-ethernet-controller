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
  const element = {
    attributes: {},
    style: {},
    isConnected: true,
    focusCalls: 0,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() { this.focusCalls += 1; document.activeElement = this; },
  };
  return {
    latLng,
    options,
    handlers,
    _icon: element,
    getElement() { return this._icon; },
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
  handlers: {},
  setView(center, zoom, options) {
    const previousZoom = this.zoom;
    this.center = center; this.zoom = zoom; this.setViewOptions = options;
    if (previousZoom !== zoom) (this.handlers.zoomend || []).forEach((callback) => callback());
    return this;
  },
  getZoom() { return this.zoom; },
  getSize() { return { x: 800, y: 600 }; },
  project([latitude, longitude], zoom) { const scale = 256 * 2 ** zoom / 360; return { x: longitude * scale, y: latitude * scale }; },
  unproject([x, y], zoom) { const scale = 256 * 2 ** zoom / 360; return { lat: y / scale, lng: x / scale }; },
  fitBounds(bounds, options) { this.bounds = { bounds, options }; return this; },
  stop() { this.stopped = true; this.stopCalls = (this.stopCalls || 0) + 1; return this; },
  addLayer(layer) { this.layers.push(layer); return this; },
  removeLayer(layer) { this.layers = this.layers.filter((candidate) => candidate !== layer); return this; },
  on(name, callback) { (this.handlers[name] ||= []).push(callback); return this; },
  invalidateSize() {},
};
const container = { id: "leafletMap" };
const tileLayer = {
  handlers: {},
  on(name, callback) { this.handlers[name] = callback; return this; },
  addTo() { return this; },
};
const tileStatus = { hidden: true, textContent: "" };
const popupListeners = {};
let popupObserverCallback = null;
const popup = {
  hidden: true,
  classList: {
    values: new Set(["hidden"]),
    contains(value) { return this.values.has(value); },
    add(value) { this.values.add(value); },
    remove(value) { this.values.delete(value); },
  },
  addEventListener(name, callback) { (popupListeners[name] ||= []).push(callback); },
  dispatchEvent(event) { (popupListeners[event.type] || []).forEach((callback) => callback(event)); },
};
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
  MutationObserver: class MutationObserver {
    constructor(callback) { popupObserverCallback = callback; }
    observe() {}
    disconnect() {}
  },
};
const document = {
  activeElement: null,
  getElementById(id) {
    if (id === "mapTileStatus") return tileStatus;
    if (id === "mapPopup") return popup;
    return container;
  },
};
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
mapApi.setPresentation({
  t(key) { return key === "map.tileUnavailable" ? "Подложка карты временно недоступна" : key; },
  schoolName(school, fallback) { return school?.officialName || fallback || ""; },
});
assert.equal(mapApi.init({ containerId: "leafletMap" }), map);
function setPopupOpen(open) {
  popup.hidden = !open;
  if (open) popup.classList.remove("hidden");
  else popup.classList.add("hidden");
  popupObserverCallback?.();
}
assert.equal(mapApi.setMapPresentation({ theme: "light", locale: "kk", style: "alidade-smooth-dark", fallback: "preserve-canonical-dark-basemap", labels: "application-presentation" }), true);
assert.equal(JSON.stringify(mapApi.getMapPresentation()), JSON.stringify({ theme: "light", locale: "kk", style: "alidade-smooth-dark", fallback: "preserve-canonical-dark-basemap", labels: "application-presentation" }));
assert.equal(mapApi.getConfig().tileUrl, mapApi.DEFAULT_CONFIG.tileUrl, "light presentation must retain the canonical map URL");
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
assert.equal(registryCluster._icon.getAttribute("role"), "button", "cluster outer element must expose button semantics");
assert.equal(registryCluster._icon.getAttribute("aria-label"), clusterContext.label, "cluster outer element must name the member context");
assert.equal(registryCluster._icon.getAttribute("aria-expanded"), "false", "closed cluster context must be collapsed");
assert.equal(clusterContext.lines.length, 0, "registry cluster must not expose operational lines");
assert.ok(clusterContext.members.some((member) => member.registryId === "18383"), "school 32 must remain a cluster member");
assert.ok(map.bounds, "render must fit the map to actual registry/monitoring coordinates");
assert.ok(map.bounds.bounds.some(([latitude, longitude]) => latitude === 50.30 && longitude === 83.40));
mapApi.setMarkerClickHandler(() => setPopupOpen(true));
registryCluster.trigger("click");
assert.ok(map.zoom > 7, "cluster click must advance the viewport zoom");
assert.equal(map.bounds.bounds.length, clusterContext.members.length, "cluster click must fit exactly the member coordinates");
assert.deepEqual(Array.from(map.bounds.options.padding), [24, 24], "cluster click must retain bounded viewport padding");
assert.ok(map.bounds.options.maxZoom <= mapApi.getConfig().maxZoom, "cluster click must respect the configured maximum zoom");
assert.equal(registryCluster._icon.getAttribute("aria-expanded"), "true", "open cluster context must keep its marker expanded while the context is active");
setPopupOpen(false);
assert.ok(document.activeElement, "closing a cluster context must restore focus to a current marker");
assert.equal(document.activeElement.getAttribute("role"), "button");
assert.equal(document.activeElement.getAttribute("aria-expanded"), "false", "restored marker must be collapsed after popup close");
mapApi.setMarkerClickHandler(null);

const stopCallsBeforeFit = map.stopCalls || 0;
mapApi.fitToCoordinates([registry.schools[3].coordinate], { singleZoom: 14 });
assert.ok(map.stopCalls > stopCallsBeforeFit, "single-point focus must stop prior map movement");
assert.equal(map.setViewOptions.animate, false, "single-point focus must not start a competing animation");
const stopCallsBeforeReset = map.stopCalls;
mapApi.resetView();
assert.ok(map.stopCalls > stopCallsBeforeReset, "reset must stop prior map movement");
assert.equal(map.setViewOptions.animate, false, "reset must not start a competing animation");

const monitoringLayer = mapApi.getLayers().monitoring;
assert.equal(monitoringLayer.items.length, 1);
const monitoringContext = mapApi.getMarkerContext(monitoringLayer.items[0]);
assert.equal(monitoringContext.lines.length, 4, "multiple lines stay available on the monitoring context");
assert.equal(monitoringContext.status, "NO_INTERNET");

mapApi.render({ mode: "historical", registry, lines: lines.slice(0, 1), historicalByLine: { "line-ok": { measurement_count: 2 } } });
const historicalContext = mapApi.getMarkerContext(mapApi.getLayers().monitoring.items[0]);
assert.equal(historicalContext.status, "UNKNOWN", "historical mode must not reuse current state");
assert.equal(historicalContext.evidence[0].status, "UNKNOWN", "historical marker evidence must come from the historical summary");

const realRegistry = JSON.parse(fs.readFileSync("web/data/vko-schools.json", "utf8"));
const realSchools = realRegistry.schools;
assert.equal(realSchools.length, 370, "large-registry coverage must use the authoritative 370-school artifact");
map.setView([49.95, 82.62], 7);
assert.equal(mapApi.render({ mode: "current", registry: realRegistry, lines: [] }), true);
const largeRender = mapApi.getLastRender();
assert.equal(largeRender.registryMarkerCount, 370, "all valid real registry rows must enter map-core clustering");
assert.ok(largeRender.registryClusterCount > 1, "real registry must not collapse into one transitive cluster");
const visibleRegistryContexts = () => mapApi.getLayers().registryClusters.items.map((marker) => mapApi.getMarkerContext(marker)).filter((context) => context?.kind === "registry" || context?.kind === "registry-cluster");
const representedRegistryIds = () => {
  const ids = [];
  visibleRegistryContexts().forEach((context) => {
    if (context.kind === "registry-cluster") context.members.forEach((member) => ids.push(member.registryId));
    else ids.push(context.registryId);
  });
  return ids;
};
const largeClusterContexts = () => visibleRegistryContexts().filter((context) => context.kind === "registry-cluster");
assert.ok(largeClusterContexts().length > 0, "large real registry must retain neutral member clusters");
assert.ok(largeClusterContexts().every((context) => context.members.length <= mapApi.getConfig().clusterMaxMembers), "cluster member lists must remain bounded for the popup surface");
assert.equal(new Set(representedRegistryIds()).size, 370, "every real registry identity must remain represented exactly once");
assert.equal(representedRegistryIds().length, 370, "cluster rebuild must not duplicate or drop registry identities");
assert.ok(representedRegistryIds().includes("18383"), "school 32 must remain in the real registry cluster/member model");

const largestRealCluster = largeClusterContexts().sort((left, right) => right.members.length - left.members.length)[0];
const largestRealClusterMarker = mapApi.getLayers().registryClusters.items.find((marker) => mapApi.getMarkerContext(marker) === largestRealCluster);
const realZoomBeforeExpansion = map.zoom;
const oldVisibleMarkers = mapApi.getLayers().registryClusters.items.slice();
largestRealClusterMarker.trigger("click");
assert.ok(map.zoom > realZoomBeforeExpansion, "real cluster click must move to a deeper viewport zoom");
assert.equal(map.bounds.bounds.length, largestRealCluster.members.length, "real cluster expansion must use only that cluster's members");
assert.ok(map.bounds.options.maxZoom <= mapApi.getConfig().maxZoom, "real cluster expansion must stay within max zoom");
assert.ok(mapApi.getLastRender().registryClusterCount > largeRender.registryClusterCount, "deeper zoom must rebuild the real registry into a finer grouping");
assert.ok(mapApi.getLayers().registryClusters.items.some((marker) => !oldVisibleMarkers.includes(marker)), "cluster expansion must rebuild marker instances for the new viewport");
assert.equal(new Set(representedRegistryIds()).size, 370, "cluster rebuild must preserve every real registry identity");
assert.ok(largeClusterContexts().every((context) => context.members.length <= mapApi.getConfig().clusterMaxMembers), "rebuilt member lists must remain bounded");

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
for (const boundary of ["core/api.mjs", "core/session.mjs", "core/capabilities.mjs", "core/i18n.mjs", "core/theme.mjs", "core/map-presentation.mjs", "core/router.mjs", "core/presentation.mjs", "integration/map-integration.mjs", "features/lines.mjs", "features/incidents.mjs", "features/reports.mjs", "features/notifications.mjs", "features/admin.mjs", "features/audit.mjs", "features/provider-case.mjs"]) {
  assert.match(appSource + fs.readFileSync(`web/${boundary}`, "utf8"), new RegExp(boundary.replace(".", "\\.")), `${boundary} must remain part of the frontend boundary`);
}
assert.match(browserHarnessSource, /BROWSER_MAP_FIXTURE/, "explicit browser fixture must remain in acceptance harness");
assert.match(browserHarnessSource, /browser-e2e-test-fixture/, "browser fixture provenance must be explicit");

console.log("web map marker checks: PASS");
