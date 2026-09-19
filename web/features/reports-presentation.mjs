const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayValue(date) {
  return date.toISOString().slice(0, 10);
}

export function defaultReportFilters(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: dayValue(new Date(end.getTime() - 6 * DAY_MS)), to: dayValue(end), district: "", provider: "", line_id: "", school_id: "" };
}

// The API treats `to` as exclusive. The UI date range is inclusive, so the
// next UTC midnight is sent to the server rather than silently dropping a day.
export function reportQuery(filters) {
  const from = asDate(filters?.from);
  const to = asDate(filters?.to);
  if (!from || !to || from > to) return { error: "invalid-date-range", query: "" };
  const query = new URLSearchParams({ from: from.toISOString(), to: new Date(to.getTime() + DAY_MS).toISOString() });
  for (const key of ["district", "provider", "line_id", "school_id"]) {
    const value = String(filters?.[key] || "").trim();
    if (value) query.set(key, value);
  }
  return { error: null, query: query.toString() };
}

export function reportContextFilters(filters, { line, incident } = {}) {
  const selectedLine = line?.id || line?.line_id || incident?.line_id;
  const selectedSchool = line?.school_id || incident?.school_id;
  return {
    ...filters,
    line_id: selectedLine || filters.line_id || "",
    school_id: selectedSchool || filters.school_id || "",
  };
}

export function reportFilterOptions(lines = []) {
  const unique = (values) => [...new Set(values.filter((value) => value && value !== "—"))].sort((left, right) => String(left).localeCompare(String(right)));
  return {
    districts: unique(lines.map((line) => line.district)),
    providers: unique(lines.map((line) => line.provider)),
    lines: unique(lines.map((line) => line.id)),
    schools: lines.reduce((result, line) => {
      if (line.school_id && line.school_id !== "—" && !result.some((school) => school.id === line.school_id)) result.push({ id: line.school_id, name: line.school_name || line.school_id });
      return result;
    }, []).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function reportAvailability(value, i18n) {
  if (value === null || value === undefined || value === "") return i18n.t("reports.valueUnavailable");
  return `${Number(value).toLocaleString(i18n.locale, { maximumFractionDigits: 2 })}${i18n.t("unit.percent")}`;
}

export function reportEvidenceSummary(passport, { i18n, presentation }) {
  const chain = Array.isArray(passport?.evidence_chain) ? passport.evidence_chain : [];
  const verifiedAt = chain.map((item) => item?.verification?.verified_at).filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
  const provenance = chain.some((item) => item?.configuration_provenance?.historical)
    ? i18n.t("reports.evidenceStoredSnapshots")
    : i18n.t("reports.valueUnavailable");
  return {
    count: chain.length,
    provenance,
    lastVerified: verifiedAt ? presentation.formatDate(verifiedAt, true) : i18n.t("reports.valueUnavailable"),
  };
}

export function reportState(data, i18n) {
  if (!data) return i18n.t("reports.unavailable");
  if (Number(data.measurement_count ?? data.measurements_received ?? 0) === 0) return i18n.t("reports.empty");
  return "";
}
