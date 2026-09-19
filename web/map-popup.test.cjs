const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function layerGroup() {
  return { items: [], addLayer(item) { this.items.push(item); return this; }, clearLayers() { this.items = []; return this; } };
}

function marker(latLng, options) {
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
  zoom: 7,
  setView() { return this; },
  getZoom() { return this.zoom; },
  fitBounds() { return this; },
  addLayer() { return this; },
  removeLayer() { return this; },
  on() { return this; },
  invalidateSize() {},
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
};
const document = { getElementById() { return { id: "leafletMap" }; } };
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
window.LinkwatchMap.setMarkerClickHandler((markerContext) => received.push(markerContext));
window.LinkwatchMap.init({ containerId: "leafletMap" });
window.LinkwatchMap.render({ registry: { schools: [registrySchool] }, lines: [lineOne, lineTwo] });

const layers = window.LinkwatchMap.getLayers();
const registryMarker = layers.registryMarkers[0];
registryMarker.handlers.click();
assert.equal(received.at(-1).kind, "registry");
assert.equal(received.at(-1).lines.length, 0, "registry-only context must not contain monitoring lines");

const monitoringMarker = layers.monitoring.items[0];
monitoringMarker.handlers.keypress({ originalEvent: { key: "Enter", preventDefault() {} } });
assert.equal(received.at(-1).kind, "monitoring");
assert.deepEqual(Array.from(received.at(-1).lines, (line) => line.id), ["line-1", "line-2"]);

console.log("web popup context checks: PASS");
