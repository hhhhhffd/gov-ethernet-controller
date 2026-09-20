/* LINKWATCH map foundation and registry/monitoring marker layers. */
(function (window) {
  "use strict";

  const MAP_FIT_PADDING_PIXELS = 24;
  const DEFAULT_CLUSTER_MAX_MEMBERS = 12;
  const DEFAULT_MAP_CONFIG = Object.freeze({
    tileUrl: "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://stadiamaps.com/attribution/" target="_blank" rel="noopener">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    center: [49.95, 82.62], zoom: 7, minZoom: 3, maxZoom: 18, fitMaxZoom: 13, clusterRadiusPixels: 44, clusterMaxMembers: DEFAULT_CLUSTER_MAX_MEMBERS,
  });
  const STATUS_PRIORITY = Object.freeze(["NO_INTERNET", "DEGRADED", "NO_DATA", "OK", "UNKNOWN"]);
  const STATUS_SET = new Set(STATUS_PRIORITY);
  const state = {
    map: null, tileLayer: null, config: null, layers: null, lastRender: null, resizeObserver: null, onMarkerClick: null, tileError: false,
    presentation: { t: () => "", schoolName: (school) => school?.officialName ?? school?.name ?? "" },
    mapPresentation: { theme: "dark", locale: "ru", style: "alidade-smooth-dark", fallback: null, labels: "application-presentation" },
  };
  function mapText(key, values) { return state.presentation?.t?.(key, values) || ""; }
  function schoolName(school, fallback) { return state.presentation?.schoolName?.(school, fallback) || fallback || ""; }

  function mapConfig() {
    const overrides = window.LINKWATCH_MAP_CONFIG || {};
    return { ...DEFAULT_MAP_CONFIG, ...overrides, tileUrl: overrides.tileUrl || overrides.tileTemplate || DEFAULT_MAP_CONFIG.tileUrl };
  }
  function setTileAvailability(unavailable) {
    state.tileError = unavailable;
    const status = document.getElementById("mapTileStatus");
    if (!status) return;
    status.hidden = !unavailable;
    status.textContent = unavailable ? mapText("map.tileUnavailable") : "";
  }
  function applyMapPresentation(nextPresentation) {
    if (!nextPresentation || nextPresentation.style !== "alidade-smooth-dark") return false;
    state.mapPresentation = {
      theme: nextPresentation.theme === "light" ? "light" : "dark",
      locale: nextPresentation.locale === "kk" ? "kk" : "ru",
      style: "alidade-smooth-dark",
      fallback: nextPresentation.fallback || null,
      labels: nextPresentation.labels || "application-presentation",
    };
    const container = document.getElementById("leafletMap");
    if (container?.setAttribute) {
      container.setAttribute("data-map-theme", state.mapPresentation.theme);
      container.setAttribute("data-map-style", state.mapPresentation.style);
      container.setAttribute("data-map-locale", state.mapPresentation.locale);
    }
    return true;
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
      const context = { kind: "registry", registryId: school.registryId ?? school.registry_id ?? school.id ?? null, school, lines: [], status: "UNKNOWN", mode: "registry", label: schoolName(school, mapText("school.registry")) };
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
      return { ...group, school, status, mode, evidence, label: schoolName(school, group.lines[0]?.school_name || mapText("school.monitoring")) };
    });
  }
  function createMonitoringMarkers(groups) {
    return groups.map((group) => createMarker(group.coordinate, { icon: icon(`linkwatch-monitoring-marker linkwatch-status-${group.status.toLowerCase()}${group.mode === "historical" ? " linkwatch-historical-marker" : ""}`, '<span aria-hidden="true"></span>', [22, 22]), keyboard: true, title: group.label, pane: "linkwatch-monitoring-pane", zIndexOffset: 1000 }, { kind: "monitoring", registryId: group.registryId, school: group.school, lines: group.lines, status: group.status, mode: group.mode, evidence: group.evidence, label: group.label }));
  }
  function projectedPoint(coordinate, zoom) {
    const point = state.map?.project?.([coordinate.latitude, coordinate.longitude], zoom);
    if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) return { x: Number(point.x), y: Number(point.y) };
    const scale = 256 * 2 ** zoom / 360;
    return { x: coordinate.longitude * scale, y: coordinate.latitude * scale };
  }
  function registryMarkerId(marker) { return String(marker.__linkwatchContext?.registryId ?? ""); }
  function clusterGroups(markers) {
    const zoom = state.map?.getZoom?.() ?? state.config.zoom;
    const radius = Number(state.config.clusterRadiusPixels) > 0 ? Number(state.config.clusterRadiusPixels) : 44;
    const maxMembers = Number.isInteger(Number(state.config.clusterMaxMembers)) && Number(state.config.clusterMaxMembers) > 1 ? Number(state.config.clusterMaxMembers) : DEFAULT_CLUSTER_MAX_MEMBERS;
    const points = markers.map((marker) => {
      const context = marker.__linkwatchContext; const coordinate = coordinateForSchool(context.school); if (!coordinate) return;
      return { marker, coordinate, point: projectedPoint(coordinate, zoom) };
    }).filter(Boolean);
    points.sort((left, right) => left.point.y - right.point.y || left.point.x - right.point.x || registryMarkerId(left.marker).localeCompare(registryMarkerId(right.marker)));
    const groups = [];
    points.forEach((item) => {
      let selected = null; let selectedDistance = Number.POSITIVE_INFINITY;
      groups.forEach((group) => {
        if (group.markers.length >= maxMembers) return;
        const distance = Math.hypot(item.point.x - group.anchor.x, item.point.y - group.anchor.y);
        if (distance <= radius && distance < selectedDistance) { selected = group; selectedDistance = distance; }
      });
      if (!selected) {
        groups.push({ markers: [item.marker], anchor: item.point, latitude: item.coordinate.latitude, longitude: item.coordinate.longitude });
        return;
      }
      selected.markers.push(item.marker); selected.latitude += item.coordinate.latitude; selected.longitude += item.coordinate.longitude;
    });
    return groups.map((group) => ({ ...group, latitude: group.latitude / group.markers.length, longitude: group.longitude / group.markers.length }));
  }
  function clusterDisplayCoordinate(group) {
    const center = { latitude: group.latitude, longitude: group.longitude };
    const monitoringCoordinates = (state.layers?.monitoringMarkers || []).map((marker) => coordinateForSchool(marker.__linkwatchContext?.school)).filter(Boolean);
    if (!monitoringCoordinates.length) return center;
    const centerPoint = projectedPoint(center, state.map?.getZoom?.() ?? state.config.zoom);
    const monitoringPoints = monitoringCoordinates.map((coordinate) => projectedPoint(coordinate, state.map?.getZoom?.() ?? state.config.zoom));
    const centerDistance = Math.min(...monitoringPoints.map((point) => Math.hypot(centerPoint.x - point.x, centerPoint.y - point.y)));
    if (centerDistance > 32) return center;
    const candidates = group.markers.map((marker) => coordinateForSchool(marker.__linkwatchContext?.school)).filter(Boolean);
    const selected = candidates.sort((left, right) => {
      const leftPoint = projectedPoint(left, state.map?.getZoom?.() ?? state.config.zoom);
      const rightPoint = projectedPoint(right, state.map?.getZoom?.() ?? state.config.zoom);
      const leftDistance = Math.min(...monitoringPoints.map((point) => Math.hypot(leftPoint.x - point.x, leftPoint.y - point.y)));
      const rightDistance = Math.min(...monitoringPoints.map((point) => Math.hypot(rightPoint.x - point.x, rightPoint.y - point.y)));
      return rightDistance - leftDistance;
    })[0] || center;
    const selectedPoint = projectedPoint(selected, state.map?.getZoom?.() ?? state.config.zoom);
    const nearestMonitoringPoint = monitoringPoints.reduce((nearest, point) => Math.hypot(selectedPoint.x - point.x, selectedPoint.y - point.y) < Math.hypot(selectedPoint.x - nearest.x, selectedPoint.y - nearest.y) ? point : nearest);
    const distance = Math.hypot(selectedPoint.x - nearestMonitoringPoint.x, selectedPoint.y - nearestMonitoringPoint.y);
    if (distance >= 42 || typeof state.map?.unproject !== "function") return selected;
    const directionX = distance ? (selectedPoint.x - nearestMonitoringPoint.x) / distance : 1;
    const directionY = distance ? (selectedPoint.y - nearestMonitoringPoint.y) / distance : 0;
    const separated = state.map.unproject([nearestMonitoringPoint.x + directionX * 42, nearestMonitoringPoint.y + directionY * 42], state.map?.getZoom?.() ?? state.config.zoom);
    return validCoordinate(separated) || selected;
  }
  function mapViewportSize() {
    const size = state.map?.getSize?.();
    const width = Number(Array.isArray(size) ? size[0] : size?.x);
    const height = Number(Array.isArray(size) ? size[1] : size?.y);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
  }
  function coordinateBounds(coordinates) {
    return coordinates.reduce((bounds, coordinate) => ({
      minLatitude: Math.min(bounds.minLatitude, coordinate.latitude),
      maxLatitude: Math.max(bounds.maxLatitude, coordinate.latitude),
      minLongitude: Math.min(bounds.minLongitude, coordinate.longitude),
      maxLongitude: Math.max(bounds.maxLongitude, coordinate.longitude),
    }), { minLatitude: Number.POSITIVE_INFINITY, maxLatitude: Number.NEGATIVE_INFINITY, minLongitude: Number.POSITIVE_INFINITY, maxLongitude: Number.NEGATIVE_INFINITY });
  }
  function clusterExpansionZoom(coordinates) {
    const currentZoom = Number(state.map?.getZoom?.() ?? state.config.zoom);
    const maxZoom = Number(state.config.maxZoom);
    if (!Number.isFinite(currentZoom) || !Number.isFinite(maxZoom) || currentZoom >= maxZoom) return maxZoom;
    const viewport = mapViewportSize();
    if (!viewport) return Math.min(maxZoom, currentZoom + 1);
    const padding = MAP_FIT_PADDING_PIXELS * 2;
    let targetZoom = currentZoom;
    for (let zoom = Math.ceil(currentZoom) + 1; zoom <= maxZoom; zoom += 1) {
      const points = coordinates.map((coordinate) => projectedPoint(coordinate, zoom));
      const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
      const height = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
      if (width + padding > viewport.width || height + padding > viewport.height) break;
      targetZoom = zoom;
    }
    return Math.max(Math.min(targetZoom, maxZoom), Math.min(maxZoom, Math.ceil(currentZoom) + 1));
  }
  function expandRegistryCluster(group) {
    const coordinates = group.markers.map((marker) => coordinateForSchool(marker.__linkwatchContext?.school)).filter(Boolean);
    if (!state.map || !coordinates.length) return false;
    const currentZoom = Number(state.map.getZoom?.() ?? state.config.zoom);
    const targetZoom = clusterExpansionZoom(coordinates);
    const points = coordinates.map((coordinate) => [coordinate.latitude, coordinate.longitude]);
    const bounds = coordinateBounds(coordinates);
    const center = [(bounds.minLatitude + bounds.maxLatitude) / 2, (bounds.minLongitude + bounds.maxLongitude) / 2];
    state.map.stop?.();
    if (typeof state.map.fitBounds === "function") state.map.fitBounds(points, { padding: [MAP_FIT_PADDING_PIXELS, MAP_FIT_PADDING_PIXELS], maxZoom: targetZoom, animate: false });
    const fittedZoom = Number(state.map.getZoom?.());
    if (typeof state.map.setView === "function" && (!Number.isFinite(fittedZoom) || fittedZoom < targetZoom || fittedZoom <= currentZoom)) state.map.setView(center, targetZoom, { animate: false });
    rebuildRegistryClusters();
    return true;
  }
  function rebuildRegistryClusters() {
    if (!state.layers?.registryClusters) return;
    state.layers.registryClusters.clearLayers(); const groups = clusterGroups(state.layers.registryMarkers);
    groups.forEach((group) => {
      if (group.markers.length === 1) { state.layers.registryClusters.addLayer(group.markers[0]); return; }
      const displayCoordinate = clusterDisplayCoordinate(group);
      const label = mapText("map.clusterTitle", { count: group.markers.length });
      const marker = createMarker(displayCoordinate, { icon: icon("linkwatch-registry-cluster", '<span aria-label="' + label + '">' + group.markers.length + "</span>", [28, 28]), keyboard: true, title: label }, { kind: "registry-cluster", count: group.markers.length, members: group.markers.map((item) => item.__linkwatchContext), lines: [], mode: "registry", label });
      if (typeof marker.on === "function") marker.on("click", () => expandRegistryCluster(group));
      state.layers.registryClusters.addLayer(marker);
    });
    state.lastRender = state.lastRender ? { ...state.lastRender, registryClusterCount: groups.length, registryVisibleMarkerCount: groups.length } : state.lastRender;
  }
  function coordinateKey(coordinate) {
    return coordinate ? `${coordinate.latitude.toFixed(7)}:${coordinate.longitude.toFixed(7)}` : null;
  }
  function updateRegistryHitTargets(monitoringGroups) {
    const monitoredCoordinates = new Set(monitoringGroups.map((group) => coordinateKey(group.coordinate)).filter(Boolean));
    state.layers?.registryMarkers?.forEach((marker) => {
      const coordinate = coordinateForSchool(marker.__linkwatchContext?.school);
      const iconElement = marker.getElement?.() || marker._icon;
      if (!iconElement) return;
      // A monitored marker owns the shared coordinate; keep the registry marker
      // visible but prevent it from intercepting the canonical monitoring target.
      iconElement.style.pointerEvents = monitoredCoordinates.has(coordinateKey(coordinate)) ? "none" : "";
    });
  }
  function addLayer(layer) { if (layer && state.map && typeof state.map.addLayer === "function") state.map.addLayer(layer); }
  function fitToCoordinates(coordinates, options = {}) {
    const valid = coordinates.map(validCoordinate).filter(Boolean); state.lastRender = state.lastRender ? { ...state.lastRender, fitCoordinateCount: valid.length } : state.lastRender;
    if (!state.map || !valid.length) return false;
    const points = valid.map((coordinate) => [coordinate.latitude, coordinate.longitude]);
    if (points.length === 1) {
      // A previous fit animation can otherwise finish after a search selection
      // and put the viewport back at the old zoom level.
      state.map.stop?.();
      state.map.setView(points[0], Math.min(options.singleZoom ?? 12, state.config.maxZoom), { animate: false });
      return true;
    }
    if (typeof state.map.fitBounds !== "function") return false;
    state.map.stop?.();
    state.map.fitBounds(points, { padding: [MAP_FIT_PADDING_PIXELS, MAP_FIT_PADDING_PIXELS], maxZoom: options.maxZoom ?? state.config.fitMaxZoom }); return true;
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
      container = document.createElement("div"); container.id = options.containerId || "leafletMap"; container.className = "leaflet-map"; container.setAttribute("role", "application"); container.setAttribute("aria-label", mapText("app.regionMap")); mapWrap.insertBefore(container, mapWrap.firstChild);
    }
    if (!container || !window.L) return null;
    state.config = mapConfig(); state.map = window.L.map(container, { attributionControl: true, zoomControl: false, minZoom: state.config.minZoom, maxZoom: state.config.maxZoom }).setView(state.config.center, state.config.zoom);
    if (typeof state.map.createPane === "function") {
      const monitoringPane = state.map.createPane("linkwatch-monitoring-pane");
      monitoringPane.style.zIndex = "620";
    }
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
    state.lastRender = { mode, registryMarkerCount: registryMarkers.length, monitoringMarkerCount: monitoringMarkers.length, monitoringLineCount: monitoringGroups.reduce((count, group) => count + group.lines.length, 0), statuses: monitoringGroups.map((group) => group.status), context };
    fitToCoordinates([...registryMarkers.map((marker) => coordinateForSchool(marker.__linkwatchContext.school)), ...monitoringGroups.map((group) => group.coordinate)], { maxZoom: state.config.fitMaxZoom });
    // Cluster against the viewport established for this render. The zoomend
    // listener keeps the same invariant after user-driven map movement.
    rebuildRegistryClusters();
    updateRegistryHitTargets(monitoringGroups); refreshSize(); return true;
  }
  function resetView() { if (state.map && state.config) { state.map.stop?.(); state.map.setView(state.config.center, state.config.zoom); } }
  window.LinkwatchMap = {
    DEFAULT_CONFIG: DEFAULT_MAP_CONFIG, STATUS_PRIORITY, init, render, refreshSize, resetView, fitToCoordinates,
    getMap: () => state.map, getConfig: () => state.config || mapConfig(), getLastRender: () => state.lastRender, getLayers: () => state.layers,
    getMarkerContext: (marker) => marker?.__linkwatchContext ?? null,
    setMarkerClickHandler: (handler) => { state.onMarkerClick = typeof handler === "function" ? handler : null; },
    setPresentation: (presentation) => {
      state.presentation = presentation && typeof presentation.t === "function" ? presentation : state.presentation;
      const container = document.getElementById("leafletMap");
      if (container?.setAttribute) container.setAttribute("aria-label", mapText("app.regionMap"));
      if (state.tileError) setTileAvailability(true);
      if (state.lastRender?.context) render(state.lastRender.context);
    },
    setMapPresentation: applyMapPresentation,
    getMapPresentation: () => ({ ...state.mapPresentation }),
  };
})(window);
