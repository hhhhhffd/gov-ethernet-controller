import { apiAliases } from "../core/api.mjs";
import { createPresentation } from "../core/presentation.mjs";
import { availableMapFilterOptions, filterMapSchools } from "../features/school-search.mjs";

function lineCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["items", "data", "results"]) if (Array.isArray(payload[key])) return payload[key];
  }
  throw new Error("LINKWATCH /lines response did not contain a line collection");
}

export function normalizeLine(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const school = source.school && typeof source.school === "object" ? source.school : {};
  const organization = source.organization && typeof source.organization === "object" ? source.organization : {};
  const provider = source.provider || {};
  const latest = source.latest || source.latest_measurement || source.last_measurement || {};
  const lineState = source.state && typeof source.state === "object" ? source.state : (source.line_state && typeof source.line_state === "object" ? source.line_state : {});
  const dataState = source.data_state || lineState.data_state || "UNKNOWN";
  const rawStatus = source.status || source.connection_state || lineState.connection_state;
  const operationalStatus = dataState === "NO_DATA" ? "NO_DATA" : (rawStatus && !["ACTIVE", "INACTIVE", "RESERVE", "PRIMARY"].includes(String(rawStatus).toUpperCase()) ? rawStatus : "UNKNOWN");
  return {
    ...source,
    // The server contract supplies immutable line and organization identifiers.
    // Missing identifiers remain missing so malformed data cannot become a fake entity.
    id: source.id ?? source.line_id ?? null,
    organization_id: source.organization_id ?? source.organizationId ?? organization.organization_id ?? organization.id ?? school.organization_id ?? null,
    school_id: source.school_id ?? source.schoolId ?? school.school_id ?? school.schoolId ?? school.id ?? organization.school_id ?? organization.schoolId ?? null,
    school_name: source.school_name ?? source.organization_name ?? organization.name ?? school.official_name ?? school.name ?? null,
    district: source.district ?? organization.district ?? school.district ?? null,
    provider_id: source.provider_id ?? provider.id ?? null,
    provider: typeof provider === "string" ? provider : source.provider_name ?? provider.name ?? null,
    technology: source.technology ?? source.connection_type ?? null,
    role: source.role ?? null,
    status: operationalStatus,
    linkwatchStatus: operationalStatus,
    line_status: source.line_status ?? source.status ?? null,
    data_state: dataState,
    latest: { download: latest.download ?? latest.download_mbps, upload: latest.upload ?? latest.upload_mbps, ping: latest.ping ?? latest.ping_ms, jitter: latest.jitter ?? latest.jitter_ms, loss: latest.loss ?? latest.packet_loss ?? latest.packet_loss_pct, at: latest.at ?? latest.observed_at ?? latest.timestamp ?? null },
    reason: source.reason ?? lineState.reason ?? null,
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

export function createMapIntegration({ api, reports, session = null, mapApi = globalThis.LinkwatchMap, dataModel = globalThis.LinkwatchDataModel, presentation = createPresentation(), mapPresentation = null } = {}) {
  let activePresentation = presentation;
  let activeMapPresentation = mapPresentation;
  const state = {
    lines: [], model: null, mapMode: "current", coverage: "all", filters: { query: "", district: "", provider: "", status: "" }, view: null, historicalByLine: {},
    registryUnavailable: true, mappingUnavailable: true, registryError: null, operationalError: null,
    registryLoading: false, loading: false,
  };
  let mapDataPromise = null;
  let mapDataKey = null;
  let resetVersion = 0;
  let loadSequence = 0;

  function sessionGeneration() {
    return Number(session?.generation ?? session?.getState?.().generation ?? 0);
  }

  function requestKey() {
    return `${sessionGeneration()}:${resetVersion}`;
  }

  function isCurrent(key) {
    return key === requestKey();
  }

  function loadMapData(key = requestKey()) {
    if (!mapDataPromise || mapDataKey !== key) {
      mapDataKey = key;
      state.registryLoading = true;
      const loader = dataModel?.createDataLoader?.();
      mapDataPromise = (loader ? loader.load() : Promise.reject(new Error("map data model unavailable")))
        .then((result) => {
          if (!isCurrent(key)) return result;
          state.registryUnavailable = Boolean(result.registryUnavailable);
          state.mappingUnavailable = Boolean(result.mappingUnavailable);
          state.registryError = result.registryError || null;
          state.registryLoading = false;
          return result;
        })
        .catch((error) => {
          if (!isCurrent(key)) return { registryPayload: null, mappingPayload: null, registryUnavailable: true, mappingUnavailable: true, registryError: error };
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
    const key = requestKey();
    const operation = ++loadSequence;
    state.loading = true;
    state.operationalError = null;
    try {
      const [linesPayload, assets] = await Promise.all([api.tryRequest(apiAliases("/lines")), loadMapData(key)]);
      if (!isCurrent(key)) return state;
      state.lines = lineCollection(linesPayload).map(normalizeLine);
      state.model = dataModel.buildFrontendModel({ ...assets, lines: state.lines });
      state.lines = state.model.linkwatch.lines;
    } catch (error) {
      if (!isCurrent(key)) return state;
      state.operationalError = error;
      state.lines = [];
      const assets = await loadMapData(key);
      if (!isCurrent(key)) return state;
      state.model = dataModel.buildFrontendModel({ ...assets, lines: [] });
    } finally {
      if (operation === loadSequence) state.loading = false;
    }
    if (!isCurrent(key)) return state;
    render();
    return state;
  }
  async function loadHistorical(query = "period=week") {
    const key = requestKey();
    const operation = ++loadSequence;
    state.loading = true;
    try {
      const [aggregate, analytics] = await Promise.all([
        reports.aggregate(query),
        reports.analytics(`${query}&limit=50`),
      ]);
      if (!isCurrent(key)) return state.historicalByLine;
      state.historicalByLine = historicalByLine(aggregate, analytics);
      state.mapMode = "historical";
      render();
    } finally {
      if (operation === loadSequence) state.loading = false;
    }
    return state.historicalByLine;
  }
  function resetSession() {
    resetVersion += 1;
    loadSequence += 1;
    mapDataPromise = null;
    mapDataKey = null;
    state.lines = [];
    state.model = null;
    state.mapMode = "current";
    state.coverage = "all";
    state.filters = { query: "", district: "", provider: "", status: "" };
    state.view = null;
    state.historicalByLine = {};
    state.registryUnavailable = true;
    state.mappingUnavailable = true;
    state.registryError = null;
    state.operationalError = null;
    state.registryLoading = false;
    state.loading = false;
    if (mapApi?.getMap?.()) mapApi.render?.({ mode: "current", registry: { schools: [] }, lines: [], historicalByLine: {} });
    return state;
  }
  function render() {
    if (!state.model || !mapApi) return false;
    const filtered = filterMapSchools({
      schools: state.model.registry.schools,
      lines: state.lines,
      filters: { ...state.filters, coverage: state.coverage },
    });
    const unmappedLines = state.lines.filter((line) => !line.registryId);
    state.view = {
      ...filtered,
      authoritativeLines: state.lines.slice(),
      unmappedLines,
      mappingDiagnostics: state.model.mappingDiagnostics,
      authoritativeLineCount: state.lines.length,
    };
    // The map deliberately ignores lines without registry coordinates, but the
    // integration keeps them in the render context and diagnostics instead of
    // silently erasing authoritative backend rows at the boundary.
    const renderLines = [...state.view.lines, ...unmappedLines.filter((line) => !state.view.lines.includes(line))];
    return mapApi.render({ mode: state.mapMode, registry: { ...state.model.registry, schools: state.view.schools }, lines: renderLines, historicalByLine: state.historicalByLine });
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
    resetSession,
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
    mappingDiagnostics() { return state.model?.mappingDiagnostics ?? null; },
    registryStatus() {
      const total = state.model?.registry?.total;
      if (state.registryLoading) return { state: "loading", text: activePresentation.t("map.registryLoading") };
      if (state.registryUnavailable) return { state: "unavailable", text: activePresentation.t("map.registryUnavailable") };
      if (state.mappingUnavailable) return { state: "mapping-unavailable", text: activePresentation.t("map.registryMappingUnavailable", { count: total ?? activePresentation.empty() }) };
      const diagnostics = state.model?.mappingDiagnostics;
      if (diagnostics && diagnostics.unmappedLineCount > 0) return { state: "mapping-incomplete", text: activePresentation.t("map.registryMappingUnavailable", { count: total ?? activePresentation.empty() }) };
      if (diagnostics && diagnostics.lineCount === 0 && diagnostics.artifactEntryCount === 0) return { state: "mapping-unavailable", text: activePresentation.t("map.registryMappingUnavailable", { count: total ?? activePresentation.empty() }) };
      return { state: "available", text: activePresentation.t("map.registryAvailable", { count: total ?? activePresentation.empty() }) };
    },
    summary() {
      return {
        lineCount: state.view?.authoritativeLineCount ?? state.lines.length,
        visibleLineCount: state.view?.lines.length ?? 0,
        unmappedLineCount: state.view?.unmappedLines.length ?? state.model?.mappingDiagnostics?.unmappedLineCount ?? 0,
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
