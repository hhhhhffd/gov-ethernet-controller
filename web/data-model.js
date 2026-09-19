/* LINKWATCH map data model. Registry facts and operational truth stay separate. */
(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  if (root) root.LinkwatchDataModel = model;
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const OPERATIONAL_STATUSES = new Set(["OK", "DEGRADED", "UNSTABLE", "NO_INTERNET", "NO_DATA"]);
  const DEFAULT_REGISTRY_URL = "/static/data/vko-schools.json";
  const DEFAULT_MAPPING_URL = "/static/data/organization-school-map.json";

  function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function text(value, fallback = null) {
    return hasValue(value) ? String(value).trim() : fallback;
  }

  function coordinateOf(value) {
    if (!value || typeof value !== "object") return null;
    const latitude = Number(value.latitude ?? value.lat);
    const longitude = Number(value.longitude ?? value.lon ?? value.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : null;
  }

  function registryRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.schools)) return payload.schools;
    return [];
  }

  function mappingRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.entries)) return payload.entries;
    return [];
  }

  function normalizeRegistryEntry(raw) {
    const registryId = text(raw?.registry_id ?? raw?.id);
    if (!registryId) return null;
    const coordinate = coordinateOf(raw.coordinate ?? raw.coordinates ?? raw);
    return {
      registryId,
      schoolId: text(raw.school_id),
      name: text(raw.official_name ?? raw.name, "Без названия"),
      officialName: text(raw.official_name ?? raw.name, "Без названия"),
      nameRu: text(raw.name_ru),
      nameKk: text(raw.name_kk),
      district: text(raw.district, "—"),
      locality: text(raw.locality),
      address: text(raw.address),
      coordinate,
      coordinateSource: text(raw.coordinate_source, coordinate ? "unknown" : "none"),
      provenance: raw.provenance ?? {
        source: text(raw.source, "official-registry"),
        sourceUrl: text(raw.source_url),
      },
      metadata: raw.metadata ?? {
        matchStatus: text(raw.match_status),
        confidence: raw.confidence ?? null,
        osmId: text(raw.osm_id),
      },
      monitoringStatus: "NOT_MONITORED",
      operationalStatus: null,
      statusSource: "registry-only",
    };
  }

  function normalizedRegistry(payload) {
    const schools = registryRows(payload)
      .map(normalizeRegistryEntry)
      .filter(Boolean)
      .sort((left, right) => left.registryId.localeCompare(right.registryId, "en"));
    return {
      schools,
      total: schools.length,
      provenance: payload && typeof payload === "object" ? (payload.provenance ?? null) : null,
      schemaVersion: payload && typeof payload === "object" ? (payload.schema_version ?? null) : null,
    };
  }

  function normalizedMapping(payload) {
    const entries = mappingRows(payload)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        organizationId: text(entry.organization_id),
        registryId: text(entry.registry_id),
        matchStatus: text(entry.match_status, "UNMAPPED"),
        confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0,
        coordinate: coordinateOf(entry.coordinate),
        coordinateProvenance: text(entry.coordinate_provenance, "none"),
        backendChain: entry.backend_chain ?? null,
        evidence: Array.isArray(entry.evidence) ? entry.evidence.slice() : [],
      }))
      .filter((entry) => entry.organizationId)
      .sort((left, right) => left.organizationId.localeCompare(right.organizationId, "en"));
    return {
      entries,
      provenance: payload && typeof payload === "object" ? (payload.provenance ?? null) : null,
      disclosure: payload && typeof payload === "object" ? (payload.disclosure ?? null) : null,
    };
  }

  function normalizeLineIdentity(line) {
    return text(line?.organization_id ?? line?.organizationId)
      || text(line?.school_id ?? line?.schoolId)
      || text(line?.id ?? line?.line_id);
  }

  function monitoredSchoolKey(line) {
    return text(line?.school_id ?? line?.schoolId)
      || text(line?.organization_id ?? line?.organizationId)
      || text(line?.id ?? line?.line_id);
  }

  function lineStatus(line) {
    const candidate = text(line?.status ?? line?.connection_state ?? line?.state?.connection_state);
    return candidate && OPERATIONAL_STATUSES.has(candidate.toUpperCase()) ? candidate.toUpperCase() : "UNKNOWN";
  }

  function registryOnlyRow(school) {
    return {
      id: `registry:${school.registryId}`,
      registryId: school.registryId,
      registrySchool: school,
      registryOnly: true,
      organization_id: null,
      school_id: school.schoolId || school.registryId,
      school_name: school.officialName,
      district: school.district || "—",
      provider: "—",
      technology: "—",
      role: "—",
      status: "NOT_MONITORED",
      linkwatchStatus: "NOT_MONITORED",
      statusSource: "registry-only",
      data_state: "NOT_MONITORED",
      latest: {},
    };
  }

  function coverageRows(model, coverage = "all") {
    const lines = model?.linkwatch?.lines || [];
    if (coverage === "monitored") return lines.slice();
    const monitoredRegistryIds = new Set(lines.map((line) => line.registryId).filter(Boolean));
    const registryOnly = (model?.registry?.schools || [])
      .filter((school) => !monitoredRegistryIds.has(school.registryId) && school.monitoringStatus === "NOT_MONITORED")
      .map(registryOnlyRow);
    return lines.concat(registryOnly).sort((left, right) => String(left.school_name || "").localeCompare(String(right.school_name || ""), "ru"));
  }

  function buildFrontendModel({ registryPayload, mappingPayload, lines = [], registryUnavailable = false, mappingUnavailable = false } = {}) {
    const registry = normalizedRegistry(registryPayload);
    const mapping = normalizedMapping(mappingPayload);
    const registryById = new Map(registry.schools.map((school) => [school.registryId, school]));
    const mappingByOrganization = new Map(mapping.entries.map((entry) => [entry.organizationId, entry]));
    const joins = [];
    const mappedRegistryIds = new Set();

    const linkwatchLines = (Array.isArray(lines) ? lines : []).map((line) => {
      const organizationId = normalizeLineIdentity(line);
      const mappingEntry = mappingByOrganization.get(organizationId) ?? null;
      const school = mappingEntry?.registryId ? registryById.get(mappingEntry.registryId) ?? null : null;
      const mappingStatus = registryUnavailable
        ? "REGISTRY_UNAVAILABLE"
        : mappingUnavailable
          ? "MAPPING_UNAVAILABLE"
        : !mappingEntry
          ? "MISSING_MAPPING"
          : mappingEntry.registryId && !school
            ? "INVALID_MAPPING"
            : mappingEntry.matchStatus;
      if (school) mappedRegistryIds.add(school.registryId);
      const join = {
        organizationId,
        lineId: text(line?.id ?? line?.line_id),
        registryId: school?.registryId ?? null,
        mappingStatus,
        registrySchool: school,
        status: lineStatus(line),
        statusSource: "backend.line_state",
      };
      joins.push(join);
      return {
        ...line,
        registryId: join.registryId,
        mappingStatus,
        registrySchool: school,
        registryCoordinate: school?.coordinate ?? null,
        registryCoordinateSource: school?.coordinateSource ?? "none",
        linkwatchStatus: join.status,
        linkwatchStatusSource: join.statusSource,
      };
    });

    const registrySchools = registry.schools.map((school) => {
      const monitored = mappedRegistryIds.has(school.registryId);
      return {
        ...school,
        monitoringStatus: monitored ? "MONITORED" : "NOT_MONITORED",
        operationalStatus: null,
        statusSource: monitored ? "backend.line_state" : "registry-only",
      };
    });
    const monitoredSchoolCount = new Set(linkwatchLines.map(monitoredSchoolKey).filter(Boolean)).size;
    return {
      registry: {
        schools: registrySchools,
        total: registryUnavailable ? null : registry.total,
        unavailable: Boolean(registryUnavailable),
        provenance: registry.provenance,
        schemaVersion: registry.schemaVersion,
      },
      linkwatch: {
        lines: linkwatchLines,
        monitoredSchoolCount,
        organizationCount: new Set(linkwatchLines.map(normalizeLineIdentity).filter(Boolean)).size,
      },
      joins,
      registryUnavailable: Boolean(registryUnavailable),
      mappingUnavailable: Boolean(mappingUnavailable),
      registryOnly: registrySchools.filter((school) => school.monitoringStatus === "NOT_MONITORED"),
    };
  }

  function createDataLoader({ fetchImpl, registryUrl = DEFAULT_REGISTRY_URL, mappingUrl = DEFAULT_MAPPING_URL } = {}) {
    const fetcher = fetchImpl || (typeof fetch === "function" ? fetch : null);
    let cachePromise = null;
    const readJson = async (url) => {
      if (!fetcher) throw new Error("fetch is unavailable");
      const response = await fetcher(url, { headers: { Accept: "application/json" } });
      if (!response || !response.ok) throw new Error(`${url} returned HTTP ${response?.status ?? "unknown"}`);
      return response.json();
    };
    const load = () => {
      if (!cachePromise) {
        cachePromise = Promise.allSettled([readJson(registryUrl), readJson(mappingUrl)]).then(([registry, mapping]) => ({
          registryPayload: registry.status === "fulfilled" ? registry.value : null,
          mappingPayload: mapping.status === "fulfilled" ? mapping.value : null,
          registryUnavailable: registry.status !== "fulfilled",
          mappingUnavailable: mapping.status !== "fulfilled",
          registryError: registry.status === "rejected" ? registry.reason : null,
          mappingError: mapping.status === "rejected" ? mapping.reason : null,
        }));
      }
      return cachePromise;
    };
    return { load, urls: { registryUrl, mappingUrl } };
  }

  return {
    DEFAULT_REGISTRY_URL,
    DEFAULT_MAPPING_URL,
    buildFrontendModel,
    coverageRows,
    createDataLoader,
    normalizeRegistryEntry,
  };
}));
