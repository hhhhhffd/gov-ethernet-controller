/* LINKWATCH map foundation and registry/monitoring marker layers. */
(function (window) {
  "use strict";

  const DEFAULT_MAP_CONFIG = Object.freeze({
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    center: [49.95, 82.62], zoom: 7, minZoom: 3, maxZoom: 18, fitMaxZoom: 13, clusterCellDegrees: 0.18,
  });
  const STATUS_PRIORITY = Object.freeze(["NO_INTERNET", "DEGRADED", "NO_DATA", "OK", "UNKNOWN"]);
  const STATUS_SET = new Set(STATUS_PRIORITY);
  const state = { map: null, tileLayer: null, config: null, layers: null, lastRender: null, resizeObserver: null, onMarkerClick: null, tileError: false };

  function mapConfig() {
    const overrides = window.LINKWATCH_MAP_CONFIG || {};
    return { ...DEFAULT_MAP_CONFIG, ...overrides, tileUrl: overrides.tileUrl || overrides.tileTemplate || DEFAULT_MAP_CONFIG.tileUrl };
  }
  function setTileAvailability(unavailable) {
    state.tileError = unavailable;
    const status = document.getElementById("mapTileStatus");
    if (!status) return;
    status.hidden = !unavailable;
    status.textContent = unavailable ? "Подложка карты временно недоступна" : "";
  }

  function validCoordinate(value) {
    if (Array.isArray(value)) {
      const latitude = Number(value[0]); const longitude = Number(value[1]);
      return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : null;
    }
    if (!value || typeof value !== "object") return null;
    const latitude = Number(value.latitude ?? value.lat); const longitude = Number(value.longitude ?? value.lon ?? value.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : null;
  }
  function coordinateForSchool(school) { return validCoordinate(school?.coordinate ?? school?.coordinates ?? school); }
  function coordinateForLine(line) { return coordinateForSchool(line?.registryCoordinate ?? line?.registrySchool?.coordinate); }
  function statusForLine(line) {
    // The data model supplies linkwatchStatus from backend LineState. Metrics are never a local verdict.
    const raw = String(line?.linkwatchStatus ?? line?.status ?? "UNKNOWN").toUpperCase();
    const normalized = raw === "UNSTABLE" ? "DEGRADED" : raw;
    return STATUS_SET.has(normalized) ? normalized : "UNKNOWN";
  }
  function aggregateStatus(lines) { return STATUS_PRIORITY.find((status) => lines.some((line) => statusForLine(line) === status)) || "UNKNOWN"; }
  function historicalStatusForLine(line, historicalByLine) {
    const summary = historicalByLine?.[line.id ?? line.line_id];
    if (!summary || !Number(summary.measurement_count)) return "NO_DATA";
    const raw = String(summary.analytics_state || summary.status || "UNKNOWN").toUpperCase();
    const normalized = raw === "UNSTABLE" ? "DEGRADED" : raw;
    return STATUS_SET.has(normalized) ? normalized : "UNKNOWN";
  }
  function aggregateHistoricalStatus(lines, historicalByLine) { return STATUS_PRIORITY.find((status) => lines.some((line) => historicalStatusForLine(line, historicalByLine) === status)) || "UNKNOWN"; }
  function layerGroup() {
    return typeof window.L.layerGroup === "function" ? window.L.layerGroup() : {
      items: [], addLayer(layer) { this.items.push(layer); return this; }, removeLayer(layer) { this.items = this.items.filter((item) => item !== layer); return this; }, clearLayers() { this.items = []; return this; }, addTo(map) { map.addLayer?.(this); return this; },
    };
  }
  function icon(className, html, size = [18, 18]) {
    if (typeof window.L.divIcon !== "function") return undefined;
    return window.L.divIcon({ className, html, iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] });
  }
  function bindMarker(marker, context) {
    marker.__linkwatchContext = context;
    if (typeof marker.bindTooltip === "function") marker.bindTooltip(context.label, { direction: "top", offset: [0, -7] });
    const activate = () => {
      if (typeof state.onMarkerClick === "function") state.onMarkerClick(context, marker);
      if (typeof window.CustomEvent === "function" && typeof window.dispatchEvent === "function") window.dispatchEvent(new window.CustomEvent("linkwatch:map-marker", { detail: { context, marker } }));
    };
    if (typeof marker.on === "function") {
      marker.on("click", activate);
      marker.on("keypress", (event) => {
        const original = event?.originalEvent || event;
        if (original?.key === "Enter" || original?.key === " " || original?.key === "Spacebar" || original?.keyCode === 13 || original?.keyCode === 32) {
          original.preventDefault?.();
          activate();
        }
      });
    }
    return marker;
  }
  function createMarker(coordinate, options, context) {
    const marker = typeof window.L.marker === "function" ? window.L.marker([coordinate.latitude, coordinate.longitude], options) : window.L.circleMarker([coordinate.latitude, coordinate.longitude], options);
    return bindMarker(marker, context);
  }
  function registryRows(registry) { return Array.isArray(registry) ? registry : (Array.isArray(registry?.schools) ? registry.schools : []); }
  function createRegistryMarkers(registry) {
    const markers = [];
    registryRows(registry).forEach((school) => {
      const coordinate = coordinateForSchool(school); if (!coordinate) return;
      const context = { kind: "registry", registryId: school.registryId ?? school.registry_id ?? school.id ?? null, school, lines: [], status: "UNKNOWN", mode: "registry", label: school.officialName ?? school.name ?? "Школа из реестра" };
      markers.push(createMarker(coordinate, { icon: icon("linkwatch-registry-marker", '<span aria-hidden="true"></span>', [12, 12]), keyboard: true, title: context.label }, context));
    });
    return markers;
  }
  function monitoringRows(lines, mode, historicalByLine) {
    const groups = new Map();
    (Array.isArray(lines) ? lines : []).forEach((line) => {
      const registryId = line?.registryId ?? line?.registrySchool?.registryId; const coordinate = coordinateForLine(line);
      // Legacy screen coordinates are intentionally ignored when a registry join is absent.
      if (!registryId || !coordinate) return;
      if (!groups.has(registryId)) groups.set(registryId, { registryId, coordinate, lines: [] });
      groups.get(registryId).lines.push(line);
    });
    return [...groups.values()].map((group) => {
      const status = mode === "historical" ? aggregateHistoricalStatus(group.lines, historicalByLine) : aggregateStatus(group.lines);
      const evidence = group.lines.map((line) => ({ lineId: line.id ?? line.line_id ?? null, status: mode === "historical" ? historicalStatusForLine(line, historicalByLine) : statusForLine(line), historical: historicalByLine?.[line.id] ?? null }));
      const school = group.lines[0]?.registrySchool ?? null;
      return { ...group, school, status, mode, evidence, label: school?.officialName ?? group.lines[0]?.school_name ?? "Мониторинговая школа" };
    });
  }
  function createMonitoringMarkers(groups) {
    return groups.map((group) => createMarker(group.coordinate, { icon: icon(`linkwatch-monitoring-marker linkwatch-status-${group.status.toLowerCase()}${group.mode === "historical" ? " linkwatch-historical-marker" : ""}`, '<span aria-hidden="true"></span>', [22, 22]), keyboard: true, title: group.label }, { kind: "monitoring", registryId: group.registryId, school: group.school, lines: group.lines, status: group.status, mode: group.mode, evidence: group.evidence, label: group.label }));
  }
  function clusterKey(coordinate, zoom) {
    const cell = Math.max(0.02, state.config.clusterCellDegrees / Math.max(1, 2 ** (zoom - 7)));
    return `${Math.floor((coordinate.latitude + 90) / cell)}:${Math.floor((coordinate.longitude + 180) / cell)}`;
  }
  function clusterGroups(markers) {
    const zoom = state.map?.getZoom?.() ?? state.config.zoom; const groups = new Map();
    markers.forEach((marker) => {
      const context = marker.__linkwatchContext; const coordinate = coordinateForSchool(context.school); if (!coordinate) return;
      const key = clusterKey(coordinate, zoom); if (!groups.has(key)) groups.set(key, { markers: [], latitude: 0, longitude: 0 });
      const group = groups.get(key); group.markers.push(marker); group.latitude += coordinate.latitude; group.longitude += coordinate.longitude;
    });
    return [...groups.values()].map((group) => ({ ...group, latitude: group.latitude / group.markers.length, longitude: group.longitude / group.markers.length }));
  }
  function rebuildRegistryClusters() {
    if (!state.layers?.registryClusters) return;
    state.layers.registryClusters.clearLayers(); const groups = clusterGroups(state.layers.registryMarkers);
    groups.forEach((group) => {
      if (group.markers.length === 1) { state.layers.registryClusters.addLayer(group.markers[0]); return; }
      const marker = createMarker({ latitude: group.latitude, longitude: group.longitude }, { icon: icon("linkwatch-registry-cluster", `<span aria-label="${group.markers.length} школ">${group.markers.length}</span>`, [28, 28]), keyboard: true, title: `${group.markers.length} школ в группе` }, { kind: "registry-cluster", count: group.markers.length, members: group.markers.map((item) => item.__linkwatchContext), mode: "registry", label: `${group.markers.length} школ в группе` });
      if (typeof marker.on === "function") marker.on("click", () => state.map?.setView?.([group.latitude, group.longitude], Math.min((state.map.getZoom?.() ?? 7) + 2, state.config.maxZoom)));
      state.layers.registryClusters.addLayer(marker);
    });
    state.lastRender = state.lastRender ? { ...state.lastRender, registryClusterCount: groups.length, registryVisibleMarkerCount: groups.length } : state.lastRender;
  }
  function addLayer(layer) { if (layer && state.map && typeof state.map.addLayer === "function") state.map.addLayer(layer); }
  function fitToCoordinates(coordinates, options = {}) {
    const valid = coordinates.map(validCoordinate).filter(Boolean); state.lastRender = state.lastRender ? { ...state.lastRender, fitCoordinateCount: valid.length } : state.lastRender;
    if (!state.map || !valid.length) return false;
    const points = valid.map((coordinate) => [coordinate.latitude, coordinate.longitude]);
    if (points.length === 1) { state.map.setView(points[0], Math.min(options.singleZoom ?? 12, state.config.maxZoom)); return true; }
    if (typeof state.map.fitBounds !== "function") return false;
    state.map.fitBounds(points, { padding: [24, 24], maxZoom: options.maxZoom ?? state.config.fitMaxZoom }); return true;
  }
  function clearLayers() {
    if (!state.layers) return;
    [state.layers.registryClusters, state.layers.monitoring].forEach((layer) => { if (layer?.clearLayers) layer.clearLayers(); if (layer && state.map?.removeLayer) state.map.removeLayer(layer); });
    state.layers.registryMarkers = []; state.layers.monitoringMarkers = [];
  }
  function init(options = {}) {
    if (state.map) return state.map;
    let container = document.getElementById(options.containerId || "leafletMap");
    if (!container) {
      const mapWrap = document.getElementById("mapWrap"); if (!mapWrap) return null;
      container = document.createElement("div"); container.id = options.containerId || "leafletMap"; container.className = "leaflet-map"; container.setAttribute("role", "application"); container.setAttribute("aria-label", "Карта Восточно-Казахстанской области"); mapWrap.insertBefore(container, mapWrap.firstChild);
    }
    if (!container || !window.L) return null;
    state.config = mapConfig(); state.map = window.L.map(container, { attributionControl: true, zoomControl: false, minZoom: state.config.minZoom, maxZoom: state.config.maxZoom }).setView(state.config.center, state.config.zoom);
    state.tileLayer = window.L.tileLayer(state.config.tileUrl, { attribution: state.config.attribution, maxZoom: state.config.maxZoom });
    if (typeof state.tileLayer.on === "function") {
      state.tileLayer.on("tileerror", () => setTileAvailability(true));
      state.tileLayer.on("tileload", () => setTileAvailability(false));
    }
    state.tileLayer.addTo(state.map);
    state.layers = { registryMarkers: [], registryClusters: layerGroup(), monitoringMarkers: [], monitoring: layerGroup() };
    if (typeof state.map.on === "function") state.map.on("zoomend", rebuildRegistryClusters);
    if (typeof window.ResizeObserver === "function") { state.resizeObserver = new window.ResizeObserver(refreshSize); state.resizeObserver.observe(container); }
    return state.map;
  }
  function refreshSize() {
    if (!state.map) return; const refresh = () => state.map.invalidateSize({ pan: false });
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(refresh); else window.setTimeout(refresh, 0);
  }
  function render(context = {}) {
    const map = init(context); if (!map) return false; clearLayers();
    const mode = context.mode || "current"; const registry = context.registry ?? context.model?.registry; const registryMarkers = createRegistryMarkers(registry); const monitoringGroups = monitoringRows(context.lines, mode, context.historicalByLine); const monitoringMarkers = createMonitoringMarkers(monitoringGroups);
    state.layers.registryMarkers = registryMarkers; state.layers.monitoringMarkers = monitoringMarkers; state.layers.registryClusters = state.layers.registryClusters || layerGroup(); state.layers.monitoring = state.layers.monitoring || layerGroup(); addLayer(state.layers.registryClusters); addLayer(state.layers.monitoring); monitoringMarkers.forEach((marker) => state.layers.monitoring.addLayer(marker));
    state.lastRender = { mode, registryMarkerCount: registryMarkers.length, monitoringMarkerCount: monitoringMarkers.length, monitoringLineCount: monitoringGroups.reduce((count, group) => count + group.lines.length, 0), statuses: monitoringGroups.map((group) => group.status) };
    rebuildRegistryClusters(); fitToCoordinates([...registryMarkers.map((marker) => coordinateForSchool(marker.__linkwatchContext.school)), ...monitoringGroups.map((group) => group.coordinate)], { maxZoom: state.config.fitMaxZoom }); refreshSize(); return true;
  }
  function resetView() { if (state.map && state.config) state.map.setView(state.config.center, state.config.zoom); }
  window.LinkwatchMap = {
    DEFAULT_CONFIG: DEFAULT_MAP_CONFIG, STATUS_PRIORITY, init, render, refreshSize, resetView, fitToCoordinates,
    getMap: () => state.map, getConfig: () => state.config || mapConfig(), getLastRender: () => state.lastRender, getLayers: () => state.layers,
    getMarkerContext: (marker) => marker?.__linkwatchContext ?? null,
    setMarkerClickHandler: (handler) => { state.onMarkerClick = typeof handler === "function" ? handler : null; },
  };
})(window);
