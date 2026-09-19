import { apiAliases, unwrapCollection } from "../core/api.mjs";
import { createPresentation } from "../core/presentation.mjs";
import { availableMapFilterOptions, filterMapSchools } from "../features/school-search.mjs";

function normalizeLine(raw) {
  const school = raw.school || raw.organization || {};
  const provider = raw.provider || {};
  const latest = raw.latest || raw.latest_measurement || raw.last_measurement || {};
  const lineState = raw.state || raw.line_state || {};
  const dataState = raw.data_state || lineState.data_state || "UNKNOWN";
  const rawStatus = raw.status || raw.connection_state || lineState.connection_state;
  const operationalStatus = dataState === "NO_DATA" ? "NO_DATA" : (rawStatus && !["ACTIVE", "INACTIVE", "RESERVE", "PRIMARY"].includes(String(rawStatus).toUpperCase()) ? rawStatus : "UNKNOWN");
  return {
    ...raw,
    id: raw.id || raw.line_id || `L-${raw.pk}`,
    organization_id: raw.organization_id || school.organization_id || school.id || "—",
    school_id: raw.school_id || school.id || "—",
    school_name: raw.school_name || school.name || raw.organization_name || "—",
    district: raw.district || school.district || "—",
    provider_id: raw.provider_id || provider.id || "—",
    provider: typeof provider === "string" ? provider : raw.provider_name || provider.name || "—",
    technology: raw.technology || raw.connection_type || "—",
    role: raw.role || "UNKNOWN",
    status: operationalStatus,
    linkwatchStatus: operationalStatus,
    line_status: raw.line_status || raw.status || "UNKNOWN",
    data_state: dataState,
    latest: { download: latest.download ?? latest.download_mbps, upload: latest.upload ?? latest.upload_mbps, ping: latest.ping ?? latest.ping_ms, jitter: latest.jitter ?? latest.jitter_ms, loss: latest.loss ?? latest.packet_loss ?? latest.packet_loss_pct, at: latest.at || latest.observed_at || latest.timestamp },
    reason: raw.reason || lineState.reason || null,
  };
}

function historicalByLine(aggregate, analytics) {
  const result = { ...(aggregate?.by_line || aggregate?.data?.by_line || {}) };
  const ranking = analytics?.ranking || analytics?.data?.ranking || [];
  ranking.forEach((item) => {
    if (!item?.line_id) return;
    result[item.line_id] = { ...(result[item.line_id] || {}), ...item, analytics_state: item.state || item.analytics_state };
  });
  return result;
}

export function createMapIntegration({ api, reports, mapApi = globalThis.LinkwatchMap, dataModel = globalThis.LinkwatchDataModel, presentation = createPresentation(), mapPresentation = null } = {}) {
  let activePresentation = presentation;
  let activeMapPresentation = mapPresentation;
  const state = {
    lines: [], model: null, mapMode: "current", coverage: "all", filters: { query: "", district: "", provider: "", status: "" }, view: null, historicalByLine: {},
    registryUnavailable: true, mappingUnavailable: true, registryError: null, operationalError: null,
    registryLoading: false, loading: false,
  };
  let mapDataPromise = null;

  function loadMapData() {
    if (!mapDataPromise) {
      state.registryLoading = true;
      const loader = dataModel?.createDataLoader?.();
      mapDataPromise = (loader ? loader.load() : Promise.reject(new Error("map data model unavailable")))
        .then((result) => {
          state.registryUnavailable = Boolean(result.registryUnavailable);
          state.mappingUnavailable = Boolean(result.mappingUnavailable);
          state.registryError = result.registryError || null;
          state.registryLoading = false;
          return result;
        })
        .catch((error) => {
          state.registryUnavailable = true;
          state.mappingUnavailable = true;
          state.registryError = error;
          state.registryLoading = false;
          return { registryPayload: null, mappingPayload: null, registryUnavailable: true, mappingUnavailable: true, registryError: error };
        });
    }
    return mapDataPromise;
  }
  async function loadCurrent() {
    state.loading = true;
    state.operationalError = null;
    try {
      const [linesPayload, assets] = await Promise.all([api.tryRequest(apiAliases("/lines")), loadMapData()]);
      state.lines = unwrapCollection(linesPayload).map(normalizeLine);
      state.model = dataModel.buildFrontendModel({ ...assets, lines: state.lines });
      state.lines = state.model.linkwatch.lines;
    } catch (error) {
      state.operationalError = error;
      state.lines = [];
      const assets = await loadMapData();
      state.model = dataModel.buildFrontendModel({ ...assets, lines: [] });
    } finally {
      state.loading = false;
    }
    render();
    return state;
  }
  async function loadHistorical(query = "period=week") {
    state.loading = true;
    try {
      const [aggregate, analytics] = await Promise.all([
        reports.aggregate(query),
        reports.analytics(`${query}&limit=50`),
      ]);
      state.historicalByLine = historicalByLine(aggregate, analytics);
      state.mapMode = "historical";
      render();
    } finally {
      state.loading = false;
    }
    return state.historicalByLine;
  }
  function render() {
    if (!state.model || !mapApi) return false;
    state.view = filterMapSchools({
      schools: state.model.registry.schools,
      lines: state.lines,
      filters: { ...state.filters, coverage: state.coverage },
    });
    return mapApi.render({ mode: state.mapMode, registry: { ...state.model.registry, schools: state.view.schools }, lines: state.view.lines, historicalByLine: state.historicalByLine });
  }
  return {
    state,
    init(options = {}) {
      mapApi?.setMapPresentation?.(activeMapPresentation);
      mapApi?.setPresentation?.(activePresentation);
      return mapApi?.init(options);
    },
    loadCurrent,
    loadHistorical,
    render,
    setMode(mode) { state.mapMode = mode === "historical" ? "historical" : "current"; if (state.mapMode === "current") state.historicalByLine = {}; return render(); },
    setCoverage(coverage) { state.coverage = coverage === "monitored" ? "monitored" : "all"; return render(); },
    setFilters(filters = {}) { state.filters = { ...state.filters, ...filters }; return render(); },
    resetFilters() { state.filters = { query: "", district: "", provider: "", status: "" }; state.coverage = "all"; return render(); },
    filterOptions() { return state.model ? availableMapFilterOptions({ schools: state.model.registry.schools, lines: state.lines }) : { districts: [], providers: [], statuses: [] }; },
    searchResults(limit = 8) {
      if (!state.view?.filters.query) return [];
      return state.view.records.slice(0, limit);
    },
    focusSchool(registryId) {
      const layers = mapApi?.getLayers?.();
      const marker = [...(layers?.monitoringMarkers || []), ...(layers?.registryMarkers || [])]
        .find((candidate) => mapApi?.getMarkerContext?.(candidate)?.registryId === registryId);
      const context = marker ? mapApi.getMarkerContext(marker) : null;
      const coordinate = context?.school?.coordinate;
      if (!context || !coordinate) return { ok: false, reason: "missing-coordinate" };
      const focused = mapApi?.fitToCoordinates?.([coordinate], { singleZoom: 14 });
      return focused ? { ok: true, context, marker } : { ok: false, reason: "map-unavailable" };
    },
    getLine(id) { return state.lines.find((line) => line.id === id) || null; },
    registryStatus() {
      const total = state.model?.registry?.total;
      if (state.registryLoading) return { state: "loading", text: activePresentation.t("map.registryLoading") };
      if (state.registryUnavailable) return { state: "unavailable", text: activePresentation.t("map.registryUnavailable") };
      if (state.mappingUnavailable) return { state: "mapping-unavailable", text: activePresentation.t("map.registryMappingUnavailable", { count: total ?? activePresentation.empty() }) };
      return { state: "available", text: activePresentation.t("map.registryAvailable", { count: total ?? activePresentation.empty() }) };
    },
    summary() {
      return {
        lineCount: state.view?.lines.length ?? 0,
        counts: state.registryUnavailable ? null : state.view?.counts ?? null,
        mode: state.mapMode,
        status: state.operationalError ? "unavailable" : "available",
        loading: state.loading,
        modeLabel: state.mapMode === "historical" ? activePresentation.t("map.historical") : activePresentation.t("map.current"),
      };
    },
    linePresentation(line) { return { status: activePresentation.status(line?.linkwatchStatus || line?.status).label, observedAt: activePresentation.formatDate(line?.latest?.at, true) }; },
    setPresentation(nextPresentation) {
      if (!nextPresentation || typeof nextPresentation.t !== "function") return;
      activePresentation = nextPresentation;
      mapApi?.setPresentation?.(activePresentation);
    },
    setMapPresentation(nextMapPresentation) {
      if (!nextMapPresentation || typeof nextMapPresentation.style !== "string") return;
      activeMapPresentation = nextMapPresentation;
      mapApi?.setMapPresentation?.(activeMapPresentation);
    },
  };
}
