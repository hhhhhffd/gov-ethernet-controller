const ADMIN_RESOURCES = Object.freeze([
  { key: "organizations", capability: "admin.manage", mutable: true },
  { key: "providers", capability: "admin.manage", mutable: true },
  { key: "lines", capability: "admin.manage", mutable: true },
  { key: "monitoring-points", capability: "admin.manage", mutable: true },
  { key: "users", capability: "admin.users", mutable: true },
  { key: "devices", capability: "admin.devices", mutable: true },
  { key: "schedule", capability: "admin.manage", mutable: true },
  { key: "policies", capability: "admin.policies", mutable: true },
  { key: "contracts", capability: "admin.policies", mutable: true },
  { key: "districts", capability: "admin.manage", mutable: true },
  { key: "technologies", capability: "admin.manage", mutable: true },
  { key: "agent-versions", capability: "admin.manage", mutable: true },
]);

export function adminResourceDefinitions() {
  return ADMIN_RESOURCES.map((resource) => ({ ...resource }));
}

export function presentNotification(item, { i18n, presentation }) {
  const source = item?.source_type || item?.event_type || item?.type;
  const sourceLabel = source ? humanEventLabel(source, { i18n, presentation }) : i18n.t("empty.noData");
  return {
    id: item?.id,
    message: item?.message || i18n.t("notification.messageUnavailable"),
    sourceLabel,
    deliveryLabel: presentation.deliveryStatus(item?.status),
    generatedLabel: presentation.formatDate(item?.generated_at || item?.created_at, true),
    nextAttemptLabel: item?.next_attempt_at ? presentation.formatDate(item.next_attempt_at, true) : "",
    attempts: item?.delivery_attempts,
    scopeAvailable: Boolean(item?.line_id || item?.organization_id || item?.school_id || item?.incident_id),
    rawSource: source || "",
  };
}

export function presentAuditItem(item, { i18n, presentation }) {
  const action = item?.action || item?.event_type;
  return {
    id: item?.id,
    actionLabel: humanEventLabel(action, { i18n, presentation }),
    objectLabel: item?.object_type || i18n.t("empty.noData"),
    actorLabel: item?.actor_username || item?.actor_id || i18n.t("empty.noData"),
    atLabel: presentation.formatDate(item?.created_at || item?.at, true),
    rawAction: item?.action || item?.event_type || "",
    rawObject: item?.object_id || "",
    payload: item?.metadata || item?.after || item?.before || null,
  };
}

function humanEventLabel(value, { i18n, presentation }) {
  if (!value) return i18n.t("action.unknown");
  const action = presentation.action(value);
  if (action !== i18n.t("action.unknown")) return action;
  const normalized = String(value).trim().toLowerCase().replace(/_/g, ".");
  const suffix = normalized.replace(/^(incident|notification)\./, "");
  if (i18n.has("event." + suffix)) return i18n.t("event." + suffix);
  return presentation.event(value);
}

export function presentAgentVersion(item, { i18n, presentation }) {
  return {
    version: item?.version || i18n.t("empty.noData"),
    deviceCount: item?.device_count ?? i18n.t("empty.noData"),
    lastSeenLabel: presentation.formatDate(item?.last_seen, true),
    sourceLabel: item?.source === "observed_telemetry" ? i18n.t("audit.source") : i18n.t("empty.noData"),
  };
}
