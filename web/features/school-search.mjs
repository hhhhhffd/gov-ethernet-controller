const STATUS_PRIORITY = Object.freeze(["NO_INTERNET", "DEGRADED", "NO_DATA", "OK", "UNKNOWN"]);
const ATTENTION_STATUSES = new Set(["NO_INTERNET", "DEGRADED", "NO_DATA"]);
const EMPTY_VALUE = "—";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizedStatus(value) {
  const status = text(value).toUpperCase();
  return status === "UNSTABLE" ? "DEGRADED" : status || "UNKNOWN";
}

export function normalizeSearchText(value) {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/№/g, " номер ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function schoolSearchFields(school) {
  return [
    school?.officialName,
    school?.officialNameRu,
    school?.officialNameKk,
    school?.name,
    school?.nameRu,
    school?.nameKk,
    school?.district,
    school?.locality,
    school?.address,
  ].filter(Boolean);
}

export function matchesSchoolSearch(school, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return schoolSearchFields(school).some((field) => normalizeSearchText(field).includes(normalizedQuery));
}

function aggregateStatus(lines) {
  return STATUS_PRIORITY.find((status) => lines.some((line) => normalizedStatus(line.linkwatchStatus ?? line.status) === status)) || "UNKNOWN";
}

function groupLinesByRegistry(lines) {
  const groups = new Map();
  (Array.isArray(lines) ? lines : []).forEach((line) => {
    const registryId = text(line?.registryId ?? line?.registry_id ?? line?.registrySchool?.registryId);
    if (!registryId) return;
    if (!groups.has(registryId)) groups.set(registryId, []);
    groups.get(registryId).push(line);
  });
  return groups;
}

function uniqueOptions(values) {
  return [...new Set(values.map(text).filter((value) => value && value !== EMPTY_VALUE))]
    .sort((left, right) => left.localeCompare(right, "ru"));
}

function visibleSchoolRecord(school, lines) {
  const monitored = lines.length > 0;
  return { school, lines, status: monitored ? aggregateStatus(lines) : "NOT_MONITORED", monitored };
}

export function availableMapFilterOptions({ schools = [], lines = [] } = {}) {
  const byRegistry = groupLinesByRegistry(lines);
  const records = schools.map((school) => visibleSchoolRecord(school, byRegistry.get(text(school?.registryId)) || []));
  return {
    districts: uniqueOptions(schools.map((school) => school?.district)),
    providers: uniqueOptions(lines.map((line) => line?.provider)),
    statuses: uniqueOptions(records.map((record) => record.status)),
  };
}

export function filterMapSchools({ schools = [], lines = [], filters = {} } = {}) {
  const normalizedFilters = {
    query: text(filters.query),
    district: text(filters.district),
    provider: text(filters.provider),
    status: normalizedStatus(filters.status),
    coverage: filters.coverage === "monitored" ? "monitored" : "all",
  };
  if (!text(filters.status)) normalizedFilters.status = "";

  const byRegistry = groupLinesByRegistry(lines);
  const visible = schools
    .map((school) => visibleSchoolRecord(school, byRegistry.get(text(school?.registryId)) || []))
    .filter((record) => matchesSchoolSearch(record.school, normalizedFilters.query))
    .filter((record) => !normalizedFilters.district || text(record.school.district) === normalizedFilters.district)
    .filter((record) => normalizedFilters.coverage !== "monitored" || record.monitored)
    .map((record) => {
      let visibleLines = record.lines;
      if (normalizedFilters.provider) visibleLines = visibleLines.filter((line) => text(line.provider) === normalizedFilters.provider);
      if (normalizedFilters.status === "NOT_MONITORED") visibleLines = [];
      else if (normalizedFilters.status) visibleLines = visibleLines.filter((line) => normalizedStatus(line.linkwatchStatus ?? line.status) === normalizedFilters.status);
      return { ...record, lines: visibleLines, status: visibleLines.length ? aggregateStatus(visibleLines) : record.monitored ? "UNKNOWN" : "NOT_MONITORED" };
    })
    .filter((record) => {
      if (normalizedFilters.provider) return record.lines.length > 0;
      if (normalizedFilters.status === "NOT_MONITORED") return !record.monitored;
      return !normalizedFilters.status || record.lines.length > 0;
    });

  const visibleLines = visible.flatMap((record) => record.lines);
  const attentionSchoolCount = visible.filter((record) => ATTENTION_STATUSES.has(record.status)).length;
  return {
    filters: normalizedFilters,
    schools: visible.map((record) => record.school),
    lines: visibleLines,
    records: visible,
    counts: {
      visibleSchoolCount: visible.length,
      monitoredSchoolCount: visible.filter((record) => record.lines.length > 0).length,
      attentionSchoolCount,
    },
  };
}
