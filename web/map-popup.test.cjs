const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function layerGroup() {
  return { items: [], addLayer(item) { this.items.push(item); return this; }, clearLayers() { this.items = []; return this; }, getLayers() { return this.items.slice(); } };
}

function marker(latLng, options) {
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
  zoom: 7,
  setView(center, zoom) { this.center = center; this.zoom = zoom ?? this.zoom; return this; },
  getZoom() { return this.zoom; },
  fitBounds() { return this; },
  stop() { this.stopCalls = (this.stopCalls || 0) + 1; return this; },
  addLayer() { return this; },
  removeLayer() { return this; },
  on() { return this; },
  invalidateSize() {},
};
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
    tileLayer() { return { addTo() { return this; } }; },
    layerGroup,
    marker,
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
  getElementById(id) { return id === "mapPopup" ? popup : { id: "leafletMap" }; },
};
const context = vm.createContext({ window, document });
vm.runInContext(fs.readFileSync("web/map.js", "utf8"), context);

const registrySchool = {
  registryId: "vko-1",
  officialName: "Школа <безопасная>",
  district: "Уланский район",
  locality: "с. Примерное",
  address: "ул. Тестовая, 1",
  coordinate: { latitude: 49.9, longitude: 82.5 },
  coordinateSource: "official-registry",
};
const lineOne = { id: "line-1", registryId: "vko-1", registrySchool, registryCoordinate: registrySchool.coordinate, linkwatchStatus: "NO_DATA" };
const lineTwo = { id: "line-2", registryId: "vko-1", registrySchool, registryCoordinate: registrySchool.coordinate, linkwatchStatus: "OK" };
const received = [];
function setPopupOpen(open) {
  popup.hidden = !open;
  if (open) popup.classList.remove("hidden");
  else popup.classList.add("hidden");
  popupObserverCallback?.();
}
window.LinkwatchMap.setMarkerClickHandler((markerContext) => { received.push(markerContext); setPopupOpen(true); });
window.LinkwatchMap.init({ containerId: "leafletMap" });
window.LinkwatchMap.render({ registry: { schools: [registrySchool] }, lines: [lineOne, lineTwo] });

const layers = window.LinkwatchMap.getLayers();
const registryMarker = layers.registryMarkers[0];
registryMarker.trigger("click");
assert.equal(received.at(-1).kind, "registry");
assert.equal(received.at(-1).lines.length, 0, "registry-only context must not contain monitoring lines");
assert.equal(registryMarker._icon.getAttribute("role"), "button");
assert.equal(registryMarker._icon.getAttribute("aria-label"), registrySchool.officialName);
assert.equal(registryMarker._icon.getAttribute("aria-expanded"), "true", "opening a school context must expand its marker");
setPopupOpen(false);
assert.equal(document.activeElement, registryMarker._icon, "closing a school context must restore focus to its marker");
assert.equal(registryMarker._icon.getAttribute("aria-expanded"), "false", "closing a school context must collapse its marker");

const monitoringMarker = layers.monitoring.items[0];
monitoringMarker.trigger("keypress", { originalEvent: { key: "Enter", preventDefault() {} } });
assert.equal(received.at(-1).kind, "monitoring");
assert.deepEqual(Array.from(received.at(-1).lines, (line) => line.id), ["line-1", "line-2"]);
assert.equal(monitoringMarker._icon.getAttribute("aria-expanded"), "true", "keyboard activation must expand the monitoring marker");
setPopupOpen(false);
assert.equal(document.activeElement, monitoringMarker._icon, "keyboard popup close must restore focus to the monitoring marker");

window.LinkwatchMap.render({
  mode: "historical",
  registry: { schools: [registrySchool] },
  lines: [lineOne, lineTwo],
  historicalByLine: {
    "line-1": { measurement_count: 3, analytics_state: "OK" },
    "line-2": { measurement_count: 0 },
  },
});
const historicalContext = window.LinkwatchMap.getLayers().monitoring.items[0].__linkwatchContext;
assert.equal(historicalContext.mode, "historical");
assert.equal(historicalContext.status, "NO_DATA", "historical marker must aggregate historical evidence, not current line state");
assert.deepEqual(Array.from(historicalContext.evidence, (item) => item.status), ["OK", "NO_DATA"]);

const secondSchool = { ...registrySchool, registryId: "vko-2", officialName: "Школа 2", coordinate: { latitude: 49.901, longitude: 82.501 } };
window.LinkwatchMap.render({ registry: { schools: [registrySchool, secondSchool] }, lines: [] });
const clusterMarker = window.LinkwatchMap.getLayers().registryClusters.items.find((candidate) => window.LinkwatchMap.getMarkerContext(candidate)?.kind === "registry-cluster");
assert.ok(clusterMarker, "nearby schools must expose a cluster context");
assert.equal(clusterMarker._icon.getAttribute("aria-label"), window.LinkwatchMap.getMarkerContext(clusterMarker).label);
clusterMarker.trigger("click");
const expandedCluster = window.LinkwatchMap.getLayers().registryClusters.items.find((candidate) => window.LinkwatchMap.getMarkerContext(candidate)?.kind === "registry-cluster");
assert.ok(expandedCluster, "cluster expansion must retain a visible cluster context");
assert.equal(expandedCluster._icon.getAttribute("aria-expanded"), "true", "opening a cluster context must expand its outer marker");
const memberButton = { dataset: { popupRegistryId: "vko-1" }, closest() { return this; } };
popup.dispatchEvent({ type: "click", target: memberButton });
setPopupOpen(false);
assert.equal(document.activeElement, expandedCluster._icon, "selecting a cluster member must restore focus to the visible cluster");
assert.equal(expandedCluster._icon.getAttribute("aria-expanded"), "false", "cluster must collapse after member popup closes");

console.log("web popup context checks: PASS");
