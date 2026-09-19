/* LINKWATCH map foundation. Line/registry markers are intentionally owned by a later slice. */
(function (window) {
  "use strict";

  const DEFAULT_MAP_CONFIG = Object.freeze({
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    center: [49.95, 82.62],
    zoom: 7,
    minZoom: 3,
    maxZoom: 18,
  });

  const state = { map: null, tileLayer: null, config: null, lastRender: null };

  function mapConfig() {
    const overrides = window.LINKWATCH_MAP_CONFIG || {};
    return {
      ...DEFAULT_MAP_CONFIG,
      ...overrides,
      tileUrl: overrides.tileUrl || overrides.tileTemplate || DEFAULT_MAP_CONFIG.tileUrl,
    };
  }

  function init(options = {}) {
    if (state.map) return state.map;
    let container = document.getElementById(options.containerId || "leafletMap");
    if (!container) {
      const mapWrap = document.getElementById("mapWrap");
      if (!mapWrap) return null;
      container = document.createElement("div");
      container.id = options.containerId || "leafletMap";
      container.className = "leaflet-map";
      container.setAttribute("role", "application");
      container.setAttribute("aria-label", "Карта Восточно-Казахстанской области");
      mapWrap.insertBefore(container, mapWrap.firstChild);
      const legacyMap = mapWrap.querySelector(".vko-map");
      if (legacyMap) legacyMap.hidden = true;
      const legacyGrid = mapWrap.querySelector(".map-gridlines");
      if (legacyGrid) legacyGrid.hidden = true;
    }
    if (!container || !window.L) return null;

    state.config = mapConfig();
    state.map = window.L.map(container, {
      attributionControl: true,
      zoomControl: false,
      minZoom: state.config.minZoom,
      maxZoom: state.config.maxZoom,
    }).setView(state.config.center, state.config.zoom);
    state.tileLayer = window.L.tileLayer(state.config.tileUrl, {
      attribution: state.config.attribution,
      maxZoom: state.config.maxZoom,
    }).addTo(state.map);
    return state.map;
  }

  function refreshSize() {
    if (!state.map) return;
    const refresh = () => state.map.invalidateSize({ pan: false });
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(refresh);
    else window.setTimeout(refresh, 0);
  }

  function render(context = {}) {
    const map = init(context);
    if (!map) return false;

    // This is the stable hand-off for future line marker work. The foundation
    // deliberately does not turn business rows into map features yet.
    state.lastRender = { mode: context.mode || "current", lineCount: Number(context.lineCount) || 0 };
    refreshSize();
    return true;
  }

  function resetView() {
    if (!state.map || !state.config) return;
    state.map.setView(state.config.center, state.config.zoom);
  }

  window.LinkwatchMap = {
    DEFAULT_CONFIG: DEFAULT_MAP_CONFIG,
    init,
    render,
    refreshSize,
    resetView,
    getMap: () => state.map,
    getConfig: () => state.config || mapConfig(),
  };
})(window);
