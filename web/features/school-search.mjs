const STATUS_PRIORITY = Object.freeze(["NO_INTERNET", "DEGRADED", "NO_DATA", "OK", "UNKNOWN"]);
const ATTENTION_STATUSES = new Set(["NO_INTERNET", "DEGRADED", "NO_DATA"]);
const EMPTY_VALUE = "—";
const SCHOOL_NAME_FIELDS = Object.freeze(["officialName", "officialNameRu", "officialNameKk", "name", "nameRu", "nameKk"]);
const SCHOOL_CONTEXT_FIELDS = Object.freeze(["district", "locality", "address"]);
const SCHOOL_NUMBER_PATTERN = /(?:^|\s)(?:(?:номер|number|нөмір)\s+|(?:школа|мектеп|school|лицей|гимназия)\s+)(\d+)(?=\s|$)/gu;
const SCHOOL_NUMBER_QUERY_PATTERN = /^(?:(?:школа|мектеп|school|лицей|гимназия)\s+)?(?:(?:номер|number|нөмір)\s+)?(\d+)$/u;

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

function normalizedFields(school, fields) {
  return fields.map((field) => normalizeSearchText(school?.[field])).filter(Boolean);
}

function schoolNameSearchFields(school) {
  return normalizedFields(school, SCHOOL_NAME_FIELDS);
}

export function schoolSearchFields(school) {
  return [...SCHOOL_NAME_FIELDS, ...SCHOOL_CONTEXT_FIELDS]
    .map((field) => school?.[field])
    .filter(Boolean);
}

function canonicalSchoolNumber(value) {
  return value.replace(/^0+(?=\d)/u, "");
}

function schoolNumbers(school) {
  const numbers = new Set();
  schoolNameSearchFields(school).forEach((field) => {
    for (const match of field.matchAll(SCHOOL_NUMBER_PATTERN)) numbers.add(canonicalSchoolNumber(match[1]));
  });
  return numbers;
}

function querySchoolNumber(query) {
  const match = normalizeSearchText(query).match(SCHOOL_NUMBER_QUERY_PATTERN);
  return match ? canonicalSchoolNumber(match[1]) : "";
}

function searchMatchRank(school, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  // A standalone numeric query is an operator's school-number lookup. Restrict
  // number extraction to name fields so an address such as "132" stays a
  // lower-priority text match instead of stealing the exact school result.
  const number = querySchoolNumber(normalizedQuery);
  if (number && schoolNumbers(school).has(number)) return 0;

  const nameFields = schoolNameSearchFields(school);
  if (nameFields.some((field) => field === normalizedQuery)) return 1;
  if (nameFields.some((field) => field.includes(normalizedQuery))) return 2;

  const contextFields = normalizedFields(school, SCHOOL_CONTEXT_FIELDS);
  if (contextFields.some((field) => field.includes(normalizedQuery))) return 3;
  return null;
}

export function matchesSchoolSearch(school, query) {
  return searchMatchRank(school, query) !== null;
}

function compareSearchRecords(left, right, query) {
  const rankDifference = searchMatchRank(left.school, query) - searchMatchRank(right.school, query);
  if (rankDifference !== 0) return rankDifference;

  const nameDifference = normalizeSearchText(left.school?.officialName ?? left.school?.name)
    .localeCompare(normalizeSearchText(right.school?.officialName ?? right.school?.name), "ru");
  if (nameDifference !== 0) return nameDifference;

  const idDifference = text(left.school?.registryId).localeCompare(text(right.school?.registryId), "en", { numeric: true });
  return idDifference || left.sourceIndex - right.sourceIndex;
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
    .map((school, sourceIndex) => ({ ...visibleSchoolRecord(school, byRegistry.get(text(school?.registryId)) || []), sourceIndex }))
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

  const ordered = normalizedFilters.query
    ? visible.slice().sort((left, right) => compareSearchRecords(left, right, normalizedFilters.query))
    : visible;
  const records = ordered.map(({ sourceIndex, ...record }) => record);
  const visibleLines = records.flatMap((record) => record.lines);
  const attentionSchoolCount = records.filter((record) => ATTENTION_STATUSES.has(record.status)).length;
  return {
    filters: normalizedFilters,
    schools: records.map((record) => record.school),
    lines: visibleLines,
    records,
    counts: {
      visibleSchoolCount: records.length,
      monitoredSchoolCount: records.filter((record) => record.lines.length > 0).length,
      attentionSchoolCount,
    },
  };
}
