import { adminResourceDefinition, adminResourceDefinitions } from "./admin.mjs";
import { notificationActions } from "./notifications.mjs";

export { adminResourceDefinitions };

const OBJECT_LABEL_KEYS = Object.freeze({
  incident: "nav.incidents",
  incidents: "nav.incidents",
  notification: "notification.title",
  notifications: "notification.title",
  line: "field.line",
  organization: "admin.resources.organizations",
  provider: "admin.resources.providers",
  provider_case: "field.providerCase",
  providercase: "field.providerCase",
  device: "admin.resources.devices",
  monitoring_point: "admin.resources.monitoring-points",
  monitoringpoint: "admin.resources.monitoring-points",
  situation: "situation.detailTitle",
  user: "admin.resources.users",
  measurement: "field.metrics",
  measurement_verification: "field.metrics",
  threshold_policy: "admin.resources.policies",
  contract_version: "admin.resources.contracts",
  agent_version: "admin.resources.agent-versions",
});

const NOTIFICATION_SOURCE_KEYS = Object.freeze({
  INCIDENT: "nav.incidents",
  PROVIDER_CASE: "field.providerCase",
  LINE: "field.line",
  MEASUREMENT: "field.metrics",
});

const ADMIN_FIELD_LABEL_KEYS = Object.freeze({
  name: "field.officialIdentity",
  district: "field.district",
  address: "field.address",
  active: "admin.status",
  support_contact: "admin.supportContact",
  organization_name: "field.school",
  provider_name: "field.provider",
  role: "field.lineRole",
  technology: "field.connectionType",
  status: "field.status",
  location: "field.address",
  is_primary: "admin.status",
  username: "field.username",
  disabled: "admin.status",
  display_name: "admin.identity",
  agent_version: "audit.version",
  last_seen: "audit.lastSeen",
  blocked: "admin.status",
  tests_per_day: "admin.testsPerDay",
  performance_tests_per_day: "admin.performanceTestsPerDay",
  jitter_minutes: "field.jitter",
  light_checks_between: "admin.lightChecksBetween",
  scope_type: "field.registryProvenance",
  version: "audit.version",
  valid_from: "audit.at",
  valid_to: "audit.at",
  contract_no: "field.contract",
  contract_date: "audit.at",
  download_min: "field.download",
  upload_min: "field.upload",
  ping_max: "field.ping",
  jitter_max: "field.jitter",
  packet_loss_max: "field.loss",
  availability_min: "field.metrics",
  recommended: "admin.recommended",
  minimum_supported: "admin.minimumSupported",
  release_at: "audit.at",
});

const SCOPE_LABEL_KEYS = Object.freeze({
  ADMIN: "app.workspace",
  GLOBAL: "app.workspace",
  OBLAST: "app.regionMap",
  DISTRICT: "field.district",
  PROVIDER: "field.provider",
  SCHOOL: "field.school",
  ORGANIZATION: "field.school",
  LINE: "field.line",
});

function code(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[.\s-]+/g, "_");
}

function humanEventLabel(value, { i18n, presentation }) {
  if (!value) return i18n.t("action.unknown");
  const action = presentation.action(value);
  if (action !== i18n.t("action.unknown")) return action;
  const normalized = String(value).trim().toLowerCase().replace(/_/g, ".");
  const aliases = { "incident.created.manual": "event.manual.created", "provider.case.draft.updated": "event.provider.draft.created" };
  if (aliases[normalized] && i18n.has(aliases[normalized])) return i18n.t(aliases[normalized]);
  const suffix = normalized.replace(/^(incident|notification)\./, "");
  if (i18n.has(`event.${suffix}`)) return i18n.t(`event.${suffix}`);
  return presentation.event(value);
}

function humanObjectLabel(value, i18n) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[.\s-]+/g, "_");
  const key = OBJECT_LABEL_KEYS[normalized];
  return key ? i18n.t(key) : i18n.t("empty.noData");
}

function humanNotificationSource(value, i18n) {
  const key = NOTIFICATION_SOURCE_KEYS[code(value)];
  return key ? i18n.t(key) : i18n.t("notification.source");
}

function humanScopeLabel(value, i18n) {
  const key = SCOPE_LABEL_KEYS[code(value)];
  return key ? i18n.t(key) : i18n.t("empty.noData");
}

function localizedMessage(item, { i18n }) {
  const localized = item?.message_by_locale || item?.messageByLocale;
  if (localized && typeof localized === "object") {
    const selected = localized[i18n.locale] || localized[i18n.locale === "kk" ? "kk-KZ" : "ru-RU"];
    if (typeof selected === "string" && selected.trim()) return { value: selected.trim(), localized: true };
  }
  const messageKey = typeof item?.message_key === "string" ? item.message_key.trim() : "";
  if (messageKey && i18n.has(messageKey)) return { value: i18n.t(messageKey), localized: true };
  const source = code(item?.source_type || item?.event_type || item?.type);
  const fallbackKey = source === "INCIDENT" ? "incidentType.UNKNOWN" : source === "PROVIDER_CASE" ? "field.providerCase" : "notification.messageUnavailable";
  return { value: i18n.t(fallbackKey), localized: true };
}

function adminFieldLabel(key, i18n) {
  return i18n.t(ADMIN_FIELD_LABEL_KEYS[key] || "admin.details");
}

function adminFieldValue(key, value, { i18n, presentation }) {
  if (value === null || value === undefined || value === "") return i18n.t("empty.noData");
  if (typeof value === "boolean") {
    if (key === "active") return presentation.lineState(value ? "ACTIVE" : "INACTIVE");
    if (key === "disabled") return i18n.t(value ? "admin.disabled" : "admin.enabled");
    if (key === "blocked") return i18n.t(value ? "admin.blocked" : "admin.unblocked");
    return i18n.t(value ? "admin.yes" : "admin.no");
  }
  if (key === "technology") return presentation.connectionType(value);
  if (key === "scope_type") return humanScopeLabel(value, i18n);
  if (key === "status" && i18n.has("lineState." + code(value))) return presentation.lineState(value);
  if (/status|state|active|blocked|recommended|supported|disabled|primary/i.test(key)) return presentation.status(value).label;
  if (key === "role") return presentation.role(value);
  if (/created_at|updated_at|last_seen|release_at|valid_from|valid_to|contract_date/i.test(key)) return presentation.formatDate(value, true);
  if (typeof value === "object") return i18n.t("admin.details");
  return String(value);
}

export function presentAdminRecord(resource, item, { i18n, presentation }) {
  const definition = adminResourceDefinition(resource);
  const fields = definition.displayFields
    .filter((key) => Object.prototype.hasOwnProperty.call(item || {}, key))
    .map((key) => ({ key, label: adminFieldLabel(key, i18n), value: adminFieldValue(key, item[key], { i18n, presentation }) }));
  return {
    id: item?.id ?? item?.version ?? item?.line_id ?? item?.device_id ?? "",
    fields,
    technical: item || {},
  };
}

export function presentNotification(item, { i18n, presentation, capabilities, pending = false }) {
  const source = item?.source_type || item?.event_type || item?.type;
  const message = localizedMessage(item, { i18n });
  const rawMessage = typeof item?.message === "string" ? item.message : "";
  const status = code(item?.status);
  const deliveryFailed = status === "FAILED" || status === "DELIVERY_FAILED" || item?.delivery_retryable === true;
  const incidentID = item?.incident_id || (code(source) === "INCIDENT" && /^\d+$/.test(String(item?.source_id || "")) ? item.source_id : "");
  const place = item?.school_name || item?.organization_name || item?.line_name || item?.provider_name || "";
  return {
    id: item?.id,
    status,
    message: message.value,
    messageIsLocalized: message.localized,
    sourceLabel: humanNotificationSource(source, i18n),
    deliveryLabel: presentation.deliveryStatus(item?.status),
    generatedLabel: presentation.formatDate(item?.generated_at || item?.created_at, true),
    nextAttemptLabel: deliveryFailed && item?.next_attempt_at ? presentation.formatDate(item.next_attempt_at, true) : "",
    attempts: item?.delivery_attempts,
    incidentId: incidentID,
    placeLabel: place,
    scopeAvailable: Boolean(item?.line_id || item?.organization_id || item?.school_id || item?.incident_id),
    actions: capabilities ? notificationActions(item, capabilities, pending) : null,
    rawSource: source || "",
    rawMessage,
    technical: rawMessage ? { source_type: source || "", message: rawMessage } : null,
  };
}

export function presentAuditItem(item, { i18n, presentation }) {
  const action = item?.action || item?.event_type;
  const actorName = [item?.actor_username, item?.actor_name, item?.actor_label]
    .find((value) => typeof value === "string" && value.trim());
  const actorType = code(item?.actor_type);
  return {
    id: item?.id,
    actionLabel: humanEventLabel(action, { i18n, presentation }),
    objectLabel: humanObjectLabel(item?.object_type, i18n),
    actorLabel: actorName?.trim() || (actorType === "SYSTEM" ? i18n.t("audit.systemActor") : i18n.t("empty.noData")),
    atLabel: presentation.formatDate(item?.created_at || item?.at, true),
    rawAction: item?.action || item?.event_type || "",
    rawObjectType: item?.object_type || "",
    rawObject: item?.object_id || "",
    rawActorType: item?.actor_type || "",
    rawActor: item?.actor_id || "",
    description: [humanEventLabel(action, { i18n, presentation }), humanObjectLabel(item?.object_type, i18n)].filter(Boolean).join(" · "),
    payload: item?.metadata || item?.after || item?.before || null,
  };
}

export function presentAgentVersion(item, { i18n, presentation }) {
  return {
    version: item?.version || i18n.t("empty.noData"),
    deviceCount: item?.device_count ?? i18n.t("empty.noData"),
    lastSeenLabel: presentation.formatDate(item?.last_seen, true),
    sourceLabel: item?.source === "observed_telemetry" ? i18n.t("audit.source") : i18n.t("empty.noData"),
  };
}
