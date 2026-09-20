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

function pending(actionState) {
  return Boolean(actionState && actionState !== "idle");
}

export function incidentActions(incident, capabilities, actionState = "idle") {
  const canUpdate = capability(capabilities, "incident.update");
  const closed = code(incident?.status) === "CLOSED";
  const isPending = pending(actionState);
  return {
    canComment: canUpdate && !isPending,
    canMarkProviderFixed: canUpdate && !closed && !isPending,
    canSendToProvider: canUpdate && !isPending,
    canAssign: canUpdate && !isPending,
    canChangeStatus: canUpdate && !isPending,
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
