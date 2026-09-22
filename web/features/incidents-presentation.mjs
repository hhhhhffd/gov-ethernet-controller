function code(value, fallback = "UNKNOWN") {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[.\s-]+/g, "_");
  return normalized || fallback;
}

function label(i18n, prefix, value) {
  const normalized = code(value);
  return i18n.has(`${prefix}.${normalized}`) ? i18n.t(`${prefix}.${normalized}`) : i18n.t(`${prefix}.UNKNOWN`);
}

function capability(capabilities, name) {
  return capabilities?.has?.(name) === true;
}

function actionCapability(capabilities, explicit, fallback) {
  // Older development servers only expose incident.update. Keep that contract
  // readable while preferring the server's per-action capabilities whenever
  // they are available.
  return capability(capabilities, explicit) || (!capabilities?.has?.(explicit) && capability(capabilities, fallback));
}

function pending(actionState) {
  return Boolean(actionState && actionState !== "idle");
}

export function incidentActions(incident, capabilities, actionState = "idle") {
  const closed = code(incident?.status) === "CLOSED";
  const isPending = pending(actionState);
  const canComment = actionCapability(capabilities, "incident.comment", "incident.update");
  const canAssign = actionCapability(capabilities, "incident.assign", "incident.update");
  const canChangeStatus = actionCapability(capabilities, "incident.status", "incident.update");
  const canMarkProviderFixed = actionCapability(capabilities, "incident.provider_fixed", "incident.update");
  const canSendToProvider = actionCapability(capabilities, "incident.send_to_provider", "incident.update");
  return {
    canComment: canComment && !closed && !isPending,
    canMarkProviderFixed: canMarkProviderFixed && !closed && !isPending,
    canSendToProvider: canSendToProvider && !closed && !isPending,
    canAssign: canAssign && !closed && !isPending,
    canChangeStatus: canChangeStatus && !closed && !isPending,
    closed,
    isPending,
    pendingState: actionState,
  };
}

export function situationActions(situation, capabilities, actionState = "idle") {
  const canManage = capability(capabilities, "situation.manage");
  const isOpen = code(situation?.status || "OPEN") === "OPEN";
  const isPending = pending(actionState);
  return {
    canLiveVerify: canManage && !isPending,
    canMerge: canManage && isOpen && !isPending,
    canSplit: canManage && isOpen && !isPending,
    hasMutation: canManage,
    readOnly: !canManage,
    isPending,
    pendingState: actionState,
  };
}

export function incidentStatusValues(items) {
  return [...new Set(items.map((item) => code(item?.status)).filter(Boolean))].sort();
}

export function incidentSeverityValues(items) {
  return [...new Set(items.map((item) => code(item?.severity)).filter(Boolean))].sort();
}

export function filterIncidents(items, filters = {}) {
  const status = code(filters.status, "");
  const severity = code(filters.severity, "");
  return items.filter((item) => (!status || code(item?.status) === status) && (!severity || code(item?.severity) === severity));
}

export function formatIncidentDuration(minutes, i18n) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) return i18n.t("empty.noData");
  const rounded = Math.round(value);
  if (rounded < 60) return i18n.t("incident.durationMinutes", { count: rounded });
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? i18n.t("incident.durationHoursMinutes", { hours, minutes: remainder }) : i18n.t("incident.durationHours", { count: hours });
}

const TECHNICAL_REASON_PATTERN = /required\s+metric\s+unavailable|no\s+threshold\s+violation|\bNO_INTERNET\b|\b(?:download|upload|ping|jitter|packet_loss|availability)\s+[-+\d.,]+\s*\(\s*[<>]/i;
const METRIC_VIOLATION_PATTERN = /\b(download|upload|ping|jitter|packet_loss|availability)\s+([-+\d.,]+)\s*\(\s*([<>])\s*([-+\d.,]+)\s*\)/gi;

const METRIC_PRESENTATION = Object.freeze({
  download: { label: "field.download", unit: "unit.mbps" },
  upload: { label: "field.upload", unit: "unit.mbps" },
  ping: { label: "field.ping", unit: "unit.ms" },
  jitter: { label: "field.jitter", unit: "unit.ms" },
  packet_loss: { label: "field.loss", unit: "unit.percent" },
  availability: { label: "reports.availability", unit: "unit.percent" },
});

function parseReasonNumber(value) {
  const normalized = String(value ?? "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function presentMetricViolation(match, { i18n, presentation }) {
  const metric = String(match[1]).toLowerCase();
  const config = METRIC_PRESENTATION[metric];
  const actual = parseReasonNumber(match[2]);
  const threshold = parseReasonNumber(match[4]);
  if (!config || actual == null || threshold == null) return null;
  const values = {
    metric: i18n.t(config.label),
    actual: presentation.formatNumber(actual, i18n.t(config.unit)),
    threshold: presentation.formatNumber(threshold, i18n.t(config.unit)),
  };
  return {
    key: `${metric}|${actual}|${match[3]}|${threshold}`,
    text: i18n.t(match[3] === "<" ? "incident.metricBelowMinimum" : "incident.metricAboveMaximum", values),
  };
}

function humanTechnicalIncidentDescription(raw, { i18n, presentation }) {
  const parts = [];
  if (/required\s+metric\s+unavailable/i.test(raw)) parts.push(i18n.t("incident.requiredMetricsUnavailable"));
  if (/\bNO_INTERNET\b/i.test(raw)) parts.push(i18n.t("incident.noInternetDetected"));

  const violations = [];
  const seen = new Set();
  for (const match of raw.matchAll(METRIC_VIOLATION_PATTERN)) {
    const violation = presentMetricViolation(match, { i18n, presentation });
    if (!violation || seen.has(violation.key)) continue;
    seen.add(violation.key);
    violations.push(violation.text);
  }
  if (violations.length) parts.push(i18n.t("incident.metricViolations", { details: violations.join("; ") }));
  return parts.join(" ") || i18n.t("incident.technicalDescription");
}

function humanIncidentDescription(item, { i18n, presentation }) {
  const raw = String(item?.description || item?.summary || "").trim();
  if (!raw) return "";
  if (TECHNICAL_REASON_PATTERN.test(raw)) return humanTechnicalIncidentDescription(raw, { i18n, presentation });
  return raw;
}

export function presentIncident(item, { i18n, presentation, now = Date.now() }) {
  const status = code(item?.status);
  const severity = code(item?.severity);
  const type = code(item?.violation_type);
  const events = Array.isArray(item?.events) ? item.events : [];
  const lastEvent = events.at(-1);
  const lastMeaningfulAt = lastEvent?.created_at || lastEvent?.at || item?.resolved_at || item?.confirmed_at || item?.started_at;
  return {
    id: item?.id,
    number: item?.incident_no || item?.number || String(item?.id ?? ""),
    status,
    statusLabel: presentation.incidentStatus(status),
    severity,
    severityLabel: label(i18n, "severity", severity),
    type,
    typeLabel: label(i18n, "incidentType", type),
    description: humanIncidentDescription(item, { i18n, presentation }),
    school: item?.school_name || item?.organization_name || i18n.t("school.noOfficialName"),
    line: item?.line_name || item?.line_label || (item?.line_id ? i18n.t("field.line") : i18n.t("empty.value")),
    lineId: item?.line_id || "",
    startedAt: item?.started_at,
    startedLabel: presentation.formatDate(item?.started_at, true),
    durationLabel: formatIncidentDuration(item?.duration_minutes, i18n),
    lastMeaningfulAt,
    lastUpdateLabel: presentation.formatRelative(lastMeaningfulAt, now),
  };
}

export function presentRecovery(item, { i18n }) {
  const recovery = code(item?.recovery_state, "NONE");
  return { code: recovery, label: label(i18n, "recovery", recovery) };
}

export function presentTimeline(events, { i18n, presentation }) {
  return (Array.isArray(events) ? events : []).map((event) => {
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const status = payload.status ? presentation.incidentStatus(payload.status) : "";
    const note = typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : "";
    const actor = [event?.actor_name, event?.actor_username, event?.actor_label]
      .find((value) => typeof value === "string" && value.trim())?.trim() || "";
    return {
      id: event?.id,
      label: presentation.event(event?.event_type),
      note,
      status,
      actor,
      rawActor: event?.actor || "",
      at: event?.created_at || event?.at,
      atLabel: presentation.formatDate(event?.created_at || event?.at, true),
    };
  });
}

export function relatedSituations(situations, incidentId) {
  const target = String(incidentId);
  return (Array.isArray(situations) ? situations : []).filter((situation) =>
    (Array.isArray(situation?.incident_ids) ? situation.incident_ids : []).some((id) => String(id) === target),
  );
}

export function presentSituation(situation, { i18n, presentation, capabilities, actionState = "idle" }) {
  const type = code(situation?.violation_type);
  const actions = situationActions(situation, capabilities, actionState);
  return {
    id: situation?.id,
    title: i18n.t("situation.untitled") + " #" + String(situation?.id ?? ""),
    typeLabel: label(i18n, "incidentType", type),
    severity: code(situation?.severity),
    severityLabel: label(i18n, "severity", situation?.severity),
    affectedCount: Number(situation?.affected_count) || 0,
    startedLabel: presentation.formatDate(situation?.started_at || situation?.start_at, true),
    actions,
  };
}
