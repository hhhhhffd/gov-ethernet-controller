/* LINKWATCH map foundation and registry/monitoring marker layers. */
(function (window) {
  "use strict";

  const MAP_FIT_PADDING_PIXELS = 24;
  const POPUP_VIEWPORT_MARGIN_PIXELS = 16;
  const DEFAULT_CLUSTER_MAX_MEMBERS = 12;
  const DEFAULT_CLUSTER_DISABLE_ZOOM = 14;
  const LIGHT_TILE_URL = "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png";
  const MARKER_POSITION_EVENT = "linkwatch:map-marker-position";
  const DEFAULT_MAP_CONFIG = Object.freeze({
    tileUrl: "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png",
    lightTileUrl: LIGHT_TILE_URL,
    attribution: '&copy; <a href="https://stadiamaps.com/attribution/" target="_blank" rel="noopener">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    center: [49.95, 82.62], zoom: 7, minZoom: 3, maxZoom: 18, fitMaxZoom: 13, clusterRadiusPixels: 44, clusterMaxMembers: DEFAULT_CLUSTER_MAX_MEMBERS, clusterDisableZoom: DEFAULT_CLUSTER_DISABLE_ZOOM,
  });
  const STATUS_PRIORITY = Object.freeze(["NO_INTERNET", "DEGRADED", "NO_DATA", "OK", "UNKNOWN"]);
  const STATUS_SET = new Set(STATUS_PRIORITY);
  const state = {
    map: null, tileLayer: null, tileUrl: null, config: null, layers: null, lastRender: null, resizeObserver: null, onMarkerClick: null, onMarkerPosition: null, tileError: false,
    presentation: { t: () => "", schoolName: (school) => school?.officialName ?? school?.name ?? "" },
    mapPresentation: { theme: "dark", locale: "ru", style: "alidade-smooth-dark", fallback: null, labels: "application-presentation" },
    activeMarker: null, activeDescriptor: null, popupFocusDescriptor: null, pendingFocusMarker: null,
    popupElement: null, popupObserver: null, popupOpen: false, popupCloseSequence: 0,
  };
  function mapText(key, values) { return state.presentation?.t?.(key, values) || ""; }
  function schoolName(school, fallback) { return state.presentation?.schoolName?.(school, fallback) || fallback || ""; }

  function markerCoordinate(marker) {
    const raw = marker?.getLatLng?.() || marker?.latLng || marker?._latlng;
    return validCoordinate(raw);
  }

  function pointCoordinates(point) {
    const x = Number(point?.x ?? point?.[0]);
    const y = Number(point?.y ?? point?.[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function markerScreenPosition(marker) {
    const coordinate = markerCoordinate(marker);
    const map = state.map;
    if (!coordinate || !map) return null;
    const containerPoint = pointCoordinates(map.latLngToContainerPoint?.([coordinate.latitude, coordinate.longitude]) || map.latLngToLayerPoint?.([coordinate.latitude, coordinate.longitude]));
    if (!containerPoint) return null;
    const container = map.getContainer?.() || document.getElementById?.("leafletMap");
    const rect = container?.getBoundingClientRect?.();
    const left = Number(rect?.left);
    const top = Number(rect?.top);
    const hasViewportRect = Number.isFinite(left) && Number.isFinite(top);
    const viewportX = containerPoint.x + (hasViewportRect ? left : 0);
    const viewportY = containerPoint.y + (hasViewportRect ? top : 0);
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    return {
      x: viewportX,
      y: viewportY,
      viewportX,
      viewportY,
      containerX: containerPoint.x,
      containerY: containerPoint.y,
      visible: !Number.isFinite(width) || !Number.isFinite(height) || (containerPoint.x >= 0 && containerPoint.y >= 0 && containerPoint.x <= width && containerPoint.y <= height),
      coordinate: { ...coordinate },
    };
  }

  function notifyMarkerPosition(marker = state.activeMarker, reason = "viewport") {
    const position = markerScreenPosition(marker);
    if (!marker || !position) return null;
    const detail = { marker, context: markerContext(marker), position, reason };
    if (typeof state.onMarkerPosition === "function") state.onMarkerPosition(detail);
    if (typeof window.CustomEvent === "function" && typeof window.dispatchEvent === "function") window.dispatchEvent(new window.CustomEvent(MARKER_POSITION_EVENT, { detail }));
    return position;
  }

  function notifyActiveMarkerPosition(reason) {
    return state.activeMarker ? notifyMarkerPosition(state.activeMarker, reason) : null;
  }

  function markerElement(marker) {
    return marker?.getElement?.() || marker?._icon || null;
  }
  function markerAccessibleName(context) {
    return String(context?.label || context?.school?.officialName || context?.school?.name || (context?.kind === "registry-cluster" ? mapText("map.clusterTitle", { count: context.count }) : mapText("school.registry")) || "Map location");
  }
  function memberRegistryIds(context) {
    return (Array.isArray(context?.members) ? context.members : [])
      .map((member) => member?.registryId ?? member?.registry_id ?? member?.school?.registryId ?? member?.school?.registry_id)
      .filter((registryId) => registryId !== undefined && registryId !== null)
      .map(String);
  }
  function markerDescriptor(context) {
    if (!context) return null;
    const registryId = context.registryId ?? context.school?.registryId ?? context.school?.registry_id;
    return {
      kind: context.kind || "",
      registryId: registryId === undefined || registryId === null ? null : String(registryId),
      memberIds: memberRegistryIds(context),
    };
  }
  function markerContext(marker) { return marker?.__linkwatchContext || null; }
  function markerMatchesId(marker, registryId) {
    const context = markerContext(marker);
    const markerId = context?.registryId ?? context?.school?.registryId ?? context?.school?.registry_id;
    return markerId !== undefined && markerId !== null && String(markerId) === String(registryId);
  }
  function layerItems(layer) {
    if (typeof layer?.getLayers === "function") return layer.getLayers();
    return Array.isArray(layer?.items) ? layer.items : [];
  }
  function renderedMarkers() {
    const registry = layerItems(state.layers?.registryClusters);
    const monitoring = layerItems(state.layers?.monitoring);
    return [...monitoring, ...registry];
  }
  function allKnownMarkers() {
    return [...new Set([
      ...(state.layers?.registryMarkers || []),
      ...(state.layers?.monitoringMarkers || []),
      ...renderedMarkers(),
      state.activeMarker,
      state.pendingFocusMarker,
    ].filter(Boolean))];
  }
  function markerOverlap(marker, memberIds) {
    const context = markerContext(marker);
    if (context?.kind !== "registry-cluster") return 0;
    const ids = new Set(memberRegistryIds(context));
    return memberIds.reduce((count, registryId) => count + (ids.has(String(registryId)) ? 1 : 0), 0);
  }
  function resolveMarker(descriptor) {
    if (!descriptor) return null;
    const candidates = renderedMarkers();
    const exactKind = candidates.find((marker) => {
      const context = markerContext(marker);
      if (context?.kind !== descriptor.kind) return false;
      if (descriptor.registryId) return markerMatchesId(marker, descriptor.registryId);
      return descriptor.kind !== "registry-cluster" || !descriptor.memberIds.length || markerOverlap(marker, descriptor.memberIds) > 0;
    });
    if (exactKind) return exactKind;
    if (descriptor.registryId) {
      const direct = candidates.find((marker) => markerMatchesId(marker, descriptor.registryId));
      if (direct) return direct;
      const containing = candidates.find((marker) => markerOverlap(marker, [descriptor.registryId]) > 0);
      if (containing) return containing;
    }
    if (descriptor.memberIds.length) {
      const containing = candidates
        .map((marker) => ({ marker, overlap: markerOverlap(marker, descriptor.memberIds) }))
        .filter((item) => item.overlap > 0)
        .sort((left, right) => right.overlap - left.overlap)[0];
      if (containing) return containing.marker;
      const directMember = candidates.find((marker) => descriptor.memberIds.some((registryId) => markerMatchesId(marker, registryId)));
      if (directMember) return directMember;
    }
    return allKnownMarkers().find((marker) => marker === state.activeMarker) || null;
  }
  function setMarkerExpanded(marker, expanded) {
    if (!marker) return;
    marker.__linkwatchExpanded = Boolean(expanded);
    const element = markerElement(marker);
    if (!element?.setAttribute) return;
    const context = markerContext(marker);
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", markerAccessibleName(context));
    element.setAttribute("aria-expanded", String(Boolean(expanded)));
  }
  function applyMarkerAccessibility(marker) {
    if (!marker) return;
    const context = markerContext(marker);
    marker.__linkwatchAriaLabel = markerAccessibleName(context);
    setMarkerExpanded(marker, Boolean(marker.__linkwatchExpanded));
  }
  function focusMarker(marker) {
    const element = markerElement(marker);
    if (!element || element.isConnected === false || typeof element.focus !== "function") return false;
    element.focus({ preventScroll: true });
    return true;
  }
  function setActiveMarker(marker, context = markerContext(marker)) {
    if (state.activeMarker && state.activeMarker !== marker) setMarkerExpanded(state.activeMarker, false);
    state.activeMarker = marker || null;
    state.activeDescriptor = markerDescriptor(context);
    state.popupFocusDescriptor = state.activeDescriptor;
    state.pendingFocusMarker = marker || null;
    setMarkerExpanded(marker, true);
    notifyMarkerPosition(marker, "activate");
  }
  function syncOpenPopupMarker() {
    if (!state.popupOpen) return;
    const marker = resolveMarker(state.popupFocusDescriptor || state.activeDescriptor) || state.pendingFocusMarker || state.activeMarker;
    if (!marker) return;
    const descriptor = state.popupFocusDescriptor || state.activeDescriptor;
    if (descriptor?.kind === "registry-cluster" && markerContext(marker)?.kind !== "registry-cluster") return;
    if (state.activeMarker && state.activeMarker !== marker) setMarkerExpanded(state.activeMarker, false);
    state.activeMarker = marker;
    setMarkerExpanded(marker, true);
    notifyMarkerPosition(marker, "sync");
  }
  function closeKnownMarkerStates() {
    allKnownMarkers().forEach((marker) => setMarkerExpanded(marker, false));
  }
  function restorePopupFocus(descriptor, sequence) {
    const restore = () => {
      if (state.popupOpen || sequence !== state.popupCloseSequence) return;
      const marker = resolveMarker(descriptor);
      if (marker) {
        setMarkerExpanded(marker, false);
        focusMarker(marker);
      }
    };
    if (typeof window.setTimeout === "function") window.setTimeout(restore, 0);
    else restore();
  }
  function popupIsOpen(popup) {
    return Boolean(popup && popup.hidden !== true && !popup.classList?.contains?.("hidden"));
  }
  function constrainPopupToViewport() {
    const popup = state.popupElement;
    if (!popupIsOpen(popup) || !popup?.style) return;
    const container = document.getElementById?.("mapWrap") || document.getElementById?.("leafletMap");
    // The fixed map workspace must not become a scroll container when focus moves into the popup.
    if (container && Number(container.scrollTop) !== 0) container.scrollTop = 0;
    const popupRect = popup.getBoundingClientRect?.();
    const popupTop = Number(popupRect?.top);
    if (!Number.isFinite(popupTop)) return;
    const containerRect = container?.getBoundingClientRect?.();
    const containerBottom = Number(containerRect?.bottom);
    const viewportBottom = Number.isFinite(containerBottom) ? containerBottom : Number(window.innerHeight);
    if (!Number.isFinite(viewportBottom)) return;
    const availableHeight = Math.max(0, Math.floor(viewportBottom - popupTop - POPUP_VIEWPORT_MARGIN_PIXELS));
    popup.style.boxSizing = "border-box";
    popup.style.maxHeight = `${availableHeight}px`;
    popup.style.overflowY = "auto";
  }
  function registryMarkerForId(registryId) {
    return allKnownMarkers().find((marker) => markerMatchesId(marker, registryId)) || null;
  }
  function handlePopupMemberClick(event) {
    const target = event?.target;
    const button = target?.closest?.("[data-popup-registry-id]") || (target?.dataset?.popupRegistryId ? target : null);
    const registryId = button?.dataset?.popupRegistryId;
    if (!registryId) return;
    const marker = registryMarkerForId(registryId);
    const context = markerContext(marker) || { kind: "registry", registryId };
    setActiveMarker(marker, context);
    state.popupFocusDescriptor = { kind: "registry", registryId: String(registryId), memberIds: [] };
  }
  function syncPopupVisibility() {
    const popup = state.popupElement;
    if (!popup) return;
    const open = popupIsOpen(popup);
    if (open) {
      state.popupOpen = true;
      syncOpenPopupMarker();
      constrainPopupToViewport();
      return;
    }
    if (!state.popupOpen && !state.activeMarker && !state.popupFocusDescriptor) return;
    state.popupOpen = false;
    const descriptor = state.popupFocusDescriptor || state.activeDescriptor;
    state.popupCloseSequence += 1;
    closeKnownMarkerStates();
    state.activeMarker = null;
    state.activeDescriptor = null;
    state.pendingFocusMarker = null;
    state.popupFocusDescriptor = null;
    restorePopupFocus(descriptor, state.popupCloseSequence);
  }
  function observePopup() {
    const popup = document.getElementById?.("mapPopup");
    if (!popup || popup === state.popupElement) return;
    state.popupElement = popup;
    popup.addEventListener?.("click", handlePopupMemberClick, true);
    if (typeof window.MutationObserver === "function") {
      state.popupObserver = new window.MutationObserver(syncPopupVisibility);
      state.popupObserver.observe(popup, { attributes: true, attributeFilter: ["hidden", "class"], childList: true, subtree: true });
    }
    syncPopupVisibility();
  }

  function mapConfig() {
    const overrides = window.LINKWATCH_MAP_CONFIG || {};
    return {
      ...DEFAULT_MAP_CONFIG,
      ...overrides,
      tileUrl: overrides.tileUrl || overrides.tileTemplate || DEFAULT_MAP_CONFIG.tileUrl,
      lightTileUrl: overrides.lightTileUrl || overrides.lightTileTemplate || DEFAULT_MAP_CONFIG.lightTileUrl,
    };
  }
  function setTileAvailability(unavailable) {
    state.tileError = unavailable;
    const status = document.getElementById("mapTileStatus");
    if (!status) return;
    status.hidden = !unavailable;
    status.textContent = unavailable ? mapText("map.tileUnavailable") : "";
  }
  function tileUrlForTheme(theme) {
    const config = state.config || mapConfig();
    return theme === "light" ? config.lightTileUrl : config.tileUrl;
  }

  function bindTileAvailability(tileLayer) {
    if (typeof tileLayer?.on !== "function") return;
    tileLayer.on("tileerror", () => {
      if (state.tileLayer === tileLayer) setTileAvailability(true);
    });
    tileLayer.on("tileload", () => {
      if (state.tileLayer === tileLayer) setTileAvailability(false);
    });
  }

  function replaceTileLayer() {
    if (!state.map || !state.config || typeof window.L?.tileLayer !== "function") return;
    const nextUrl = tileUrlForTheme(state.mapPresentation.theme);
    if (state.tileLayer && state.tileUrl === nextUrl) return;
    if (state.tileLayer && typeof state.map.removeLayer === "function") state.map.removeLayer(state.tileLayer);
    state.tileLayer = window.L.tileLayer(nextUrl, { attribution: state.config.attribution, maxZoom: state.config.maxZoom });
    state.tileUrl = nextUrl;
    state.tileError = false;
    setTileAvailability(false);
    bindTileAvailability(state.tileLayer);
    state.tileLayer.addTo?.(state.map);
  }

  function applyMapPresentation(nextPresentation) {
    const requestedStyle = nextPresentation?.style || "alidade-smooth-dark";
    if (!nextPresentation || !["alidade-smooth-dark", "alidade-smooth"].includes(requestedStyle)) return false;
    state.mapPresentation = {
      theme: nextPresentation.theme === "light" ? "light" : "dark",
      locale: nextPresentation.locale === "kk" ? "kk" : "ru",
      style: requestedStyle,
      fallback: nextPresentation.fallback || null,
      labels: nextPresentation.labels || "application-presentation",
    };
    const container = document.getElementById("leafletMap");
    if (container?.setAttribute) {
      container.setAttribute("data-map-theme", state.mapPresentation.theme);
      container.setAttribute("data-map-style", state.mapPresentation.style);
      container.setAttribute("data-map-basemap", state.mapPresentation.theme === "light" ? "alidade-smooth" : "alidade-smooth-dark");
      container.setAttribute("data-map-locale", state.mapPresentation.locale);
    }
    replaceTileLayer();
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

  function registryMarkerMarkup() {
    return '<span aria-hidden="true" style="display:block;width:10px;height:10px;border:2px solid rgba(245,248,252,.95);border-radius:50%;background:#63758b;box-shadow:0 1px 4px rgba(9,14,22,.55)"></span>';
  }

  function monitoringMarkerMarkup(status) {
    const colors = { NO_INTERNET: "#b96d6b", DEGRADED: "#ae8b58", NO_DATA: "#76879c", OK: "#609176", UNKNOWN: "#6e7d8d" };
    const color = colors[status] || colors.UNKNOWN;
    return `<span aria-hidden="true" style="display:grid;place-items:center;width:18px;height:18px;border:2px solid rgba(248,250,252,.96);border-radius:50%;background:${color};box-shadow:0 1px 5px rgba(9,14,22,.62)"><span style="display:block;width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.92)"></span></span>`;
  }

  function clusterMarkup(count) {
    return `<span aria-hidden="true" style="display:grid;place-items:center;width:34px;height:34px;border:2px solid rgba(229,236,245,.96);border-radius:50%;background:rgba(30,42,57,.95);color:#f7fafc;box-shadow:0 2px 8px rgba(8,13,20,.48),0 0 0 3px rgba(120,145,170,.22);font:700 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em">${count}</span>`;
  }
  function bindMarker(marker, context) {
    marker.__linkwatchContext = context;
    marker.__linkwatchExpanded = false;
    applyMarkerAccessibility(marker);
    if (typeof marker.bindTooltip === "function") marker.bindTooltip(context.label, { direction: "top", offset: [0, -7] });
    const activate = () => {
      setActiveMarker(marker, context);
      if (typeof state.onMarkerClick === "function") state.onMarkerClick(context, marker);
      if (typeof window.CustomEvent === "function" && typeof window.dispatchEvent === "function") window.dispatchEvent(new window.CustomEvent("linkwatch:map-marker", { detail: { context, marker } }));
    };
    if (typeof marker.on === "function") {
      marker.on("add", () => applyMarkerAccessibility(marker));
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
      markers.push(createMarker(coordinate, { icon: icon("linkwatch-registry-marker", registryMarkerMarkup(), [16, 16]), keyboard: true, title: context.label }, context));
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
    return groups.map((group) => createMarker(group.coordinate, { icon: icon(`linkwatch-monitoring-marker linkwatch-status-${group.status.toLowerCase()}${group.mode === "historical" ? " linkwatch-historical-marker" : ""}`, monitoringMarkerMarkup(group.status), [26, 26]), keyboard: true, title: group.label, pane: "linkwatch-monitoring-pane", zIndexOffset: 1000 }, { kind: "monitoring", registryId: group.registryId, school: group.school, lines: group.lines, status: group.status, mode: group.mode, evidence: group.evidence, label: group.label }));
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
    const configuredUnclusteredZoom = Number(state.config.clusterDisableZoom);
    const unclusteredZoom = Number.isFinite(configuredUnclusteredZoom) ? configuredUnclusteredZoom : DEFAULT_CLUSTER_DISABLE_ZOOM;
    const minimumExpansionZoom = Math.max(Math.ceil(currentZoom) + 1, Math.min(maxZoom, unclusteredZoom));
    return Math.min(maxZoom, Math.max(Math.min(targetZoom, maxZoom), minimumExpansionZoom));
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
    if (typeof window.CustomEvent === "function" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new window.CustomEvent("linkwatch:map-cluster-expanded"));
    }
    return true;
  }
  function rebuildRegistryClusters() {
    if (!state.layers?.registryClusters) return;
    state.layers.registryClusters.clearLayers();
    const zoom = Number(state.map?.getZoom?.() ?? state.config.zoom);
    const disableClustering = Number.isFinite(zoom) && zoom >= Number(state.config.clusterDisableZoom);
    const groups = disableClustering ? state.layers.registryMarkers.map((marker) => ({ markers: [marker] })) : clusterGroups(state.layers.registryMarkers);
    groups.forEach((group) => {
      if (group.markers.length === 1) { state.layers.registryClusters.addLayer(group.markers[0]); return; }
      const displayCoordinate = clusterDisplayCoordinate(group);
      const label = mapText("map.clusterTitle", { count: group.markers.length }) || `${group.markers.length} schools`;
      const marker = createMarker(displayCoordinate, { icon: icon("linkwatch-registry-cluster", clusterMarkup(group.markers.length), [40, 40]), keyboard: true, title: label }, { kind: "registry-cluster", count: group.markers.length, members: group.markers.map((item) => item.__linkwatchContext), lines: [], mode: "registry", label });
      if (typeof marker.on === "function") marker.on("click", () => expandRegistryCluster(group));
      state.layers.registryClusters.addLayer(marker);
    });
    syncOpenPopupMarker();
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
      const marker = allKnownMarkers().find((candidate) => {
        const coordinate = coordinateForSchool(markerContext(candidate)?.school);
        return coordinate && coordinate.latitude === valid[0].latitude && coordinate.longitude === valid[0].longitude;
      });
      if (marker) state.pendingFocusMarker = marker;
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
    replaceTileLayer();
    state.layers = { registryMarkers: [], registryClusters: layerGroup(), monitoringMarkers: [], monitoring: layerGroup() };
    observePopup();
    window.addEventListener?.("resize", () => { constrainPopupToViewport(); notifyActiveMarkerPosition("resize"); });
    if (typeof state.map.on === "function") {
      state.map.on("zoomend", rebuildRegistryClusters);
      ["move", "moveend", "zoom", "resize", "viewreset"].forEach((eventName) => state.map.on(eventName, () => notifyActiveMarkerPosition(eventName)));
    }
    if (typeof window.ResizeObserver === "function") { state.resizeObserver = new window.ResizeObserver(refreshSize); state.resizeObserver.observe(container); }
    return state.map;
  }
  function refreshSize() {
    if (!state.map) return; const refresh = () => { state.map.invalidateSize({ pan: false }); constrainPopupToViewport(); notifyActiveMarkerPosition("resize"); };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(refresh); else window.setTimeout(refresh, 0);
  }
  function render(context = {}) {
    const map = init(context); if (!map) return false; clearLayers();
    const mode = context.mode || "current"; const registry = context.registry ?? context.model?.registry; const registryMarkers = createRegistryMarkers(registry); const monitoringGroups = monitoringRows(context.lines, mode, context.historicalByLine); const monitoringMarkers = createMonitoringMarkers(monitoringGroups);
    state.layers.registryMarkers = registryMarkers; state.layers.monitoringMarkers = monitoringMarkers; state.layers.registryClusters = state.layers.registryClusters || layerGroup(); state.layers.monitoring = state.layers.monitoring || layerGroup(); addLayer(state.layers.registryClusters); addLayer(state.layers.monitoring); monitoringMarkers.forEach((marker) => state.layers.monitoring.addLayer(marker));
    state.lastRender = { mode, registryMarkerCount: registryMarkers.length, monitoringMarkerCount: monitoringMarkers.length, monitoringLineCount: monitoringGroups.reduce((count, group) => count + group.lines.length, 0), statuses: monitoringGroups.map((group) => group.status), context };
    if (!context.preserveViewport) {
      fitToCoordinates([...registryMarkers.map((marker) => coordinateForSchool(marker.__linkwatchContext.school)), ...monitoringGroups.map((group) => group.coordinate)], { maxZoom: state.config.fitMaxZoom });
    }
    // Cluster against the viewport established for this render. The zoomend
    // listener keeps the same invariant after user-driven map movement.
    rebuildRegistryClusters();
    updateRegistryHitTargets(monitoringGroups); refreshSize(); return true;
  }
  function resetView() { if (state.map && state.config) { state.map.stop?.(); state.map.setView(state.config.center, state.config.zoom, { animate: false }); } }
  window.LinkwatchMap = {
    DEFAULT_CONFIG: DEFAULT_MAP_CONFIG, STATUS_PRIORITY, init, render, refreshSize, resetView, fitToCoordinates,
    getMap: () => state.map, getConfig: () => state.config || mapConfig(), getLastRender: () => state.lastRender, getLayers: () => state.layers,
    getMarkerContext: (marker) => marker?.__linkwatchContext ?? null,
    setMarkerClickHandler: (handler) => { state.onMarkerClick = typeof handler === "function" ? handler : null; },
    setMarkerPositionHandler: (handler) => { state.onMarkerPosition = typeof handler === "function" ? handler : null; },
    getMarkerScreenPosition: (marker) => markerScreenPosition(marker),
    MARKER_POSITION_EVENT,
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
