const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("NOTIFICATION-001 presents delivery and omits unread semantics", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentNotification } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const item = presentNotification({ source_type: "PROVIDER_CASE", message: "evaluator_code=PROVIDER_CASE_PENDING", message_by_locale: { ru: "Проверка" }, channel: "WEB", school_name: "Школа №1", status: "PENDING", generated_at: "2026-09-20T10:00:00Z", delivery_attempts: 2 }, { i18n, presentation: createPresentation(i18n) });
  assert.equal(item.message, "Проверка");
  assert.equal(item.rawMessage, "evaluator_code=PROVIDER_CASE_PENDING");
  assert.doesNotMatch(item.message, /evaluator_code|PROVIDER_CASE_PENDING/);
  assert.equal(item.deliveryLabel, "Ожидает отправки");
  assert.equal(item.channelLabel, "В приложении");
  assert.equal(item.recipientLabel, "Школа №1");
  assert.equal(item.attempts, 2);
  assert.equal(item.scopeAvailable, false);
  assert.doesNotMatch(fs.readFileSync("web/index.html", "utf8"), /notification.*badge|unread/i);
});

test("Notification dispatch is a real admin action and respects pending state", async () => {
  const { createNotificationsBoundary, notificationActions } = await import("./features/notifications.mjs");
  const calls = [];
  const api = {
    async tryRequest(paths, options) {
      calls.push({ paths, options });
      return { items: [] };
    },
  };
  const boundary = createNotificationsBoundary(api);
  await boundary.dispatch(12);

  assert.equal(calls[0].paths[0], "/api/admin/notifications/12/dispatch");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(notificationActions({ status: "FAILED" }, { has: (name) => name === "notification.dispatch" }).canDispatch, true);
  assert.equal(notificationActions({ status: "FAILED" }, { has: () => true }, true).canDispatch, false);
  await assert.rejects(() => boundary.dispatch("bad"), (error) => error.code === "invalid_notification_id");
});

test("Notification messages do not cross the locale boundary as untranslated raw copy", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentNotification } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "kk", storage: null, root: null });
  const item = presentNotification({ source_type: "INCIDENT", message: "Russian backend message" }, { i18n, presentation: createPresentation(i18n) });

  assert.equal(item.message, "Желідегі бұзушылық расталды");
  assert.doesNotMatch(item.message, /Russian|backend message/);
  assert.equal(item.sourceLabel, "Оқиғалар");
  assert.equal(item.rawMessage, "Russian backend message");
});

test("NOTIFICATION-003 raw evaluator messages stay in technical disclosure", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentNotification } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const item = presentNotification({ source_type: "INCIDENT", message: "evaluator failure: rule_id=42" }, { i18n, presentation: createPresentation(i18n) });

  assert.equal(item.message, "Подтверждённое нарушение линии");
  assert.doesNotMatch(item.message, /evaluator|rule_id|42/);
  assert.deepEqual(item.technical, { source_type: "INCIDENT", message: "evaluator failure: rule_id=42" });
});

test("NOTIFICATION-002 utility is capability-gated and has real loading/error/empty paths", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.match(html, /id="notificationsButton"[^>]*data-capability="notification\.read"/);
  assert.match(app, /boundaries\.notifications\.list/);
  assert.match(app, /notification\.empty/);
  assert.match(app, /notification\.unavailable/);
});

test("ADMIN-001 and AUDIT-001 keep secondary routes capability-gated", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.doesNotMatch(html, /id="adminMenuButton"|id="auditMenuButton"/);
  assert.match(html, /data-route="admin"[^>]*data-capability="admin\.manage"/);
  assert.match(html, /data-route="audit"[^>]*data-capability="audit\.read"/);
  assert.match(app, /boundaries\.admin\.save/);
  assert.match(app, /boundaries\.audit\.agentVersions/);
  assert.match(app, /presentAuditItem/);
  assert.match(app, /<details class="audit-technical-card"><summary.*audit\.systemEvent/);
  assert.match(app, /object\.objectLabel/);
  assert.doesNotMatch(app, /function auditObjectLabel\(/);
  assert.match(app, /object_type: entry\.rawObjectType/);
  assert.match(app, /actor_id: entry\.rawActor/);
  assert.doesNotMatch(app, /notification\.technical/);
  assert.match(app, /data-audit-select/);
  assert.match(app, /loadMoreAudit/);
  assert.match(app, /audit\.selectHint/);
});

test("REPORT-003 invalid numeric values use human fallback and retain technical diagnostics", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.match(app, /Number\.isFinite\(number\)/);
  assert.match(app, /return i18n\.t\("reports\.valueUnavailable"\);/);
  assert.match(app, /reportTechnicalDetails\(reportDiagnostics\)/);
  assert.doesNotMatch(app, /Number\.isFinite\(number\) \? presentation\.formatNumber\(number, suffix\) : String\(value\)/);
});

test("ADMIN-002 resource inventory covers real admin API families", async () => {
  const { adminResourceDefinitions } = await import("./features/secondary-presentation.mjs");
  const { adminResourceDefinition } = await import("./features/admin.mjs");
  const definitions = adminResourceDefinitions();
  const keys = definitions.map((item) => item.key);
  for (const required of ["organizations", "providers", "lines", "monitoring-points", "users", "devices", "schedule", "policies", "contracts", "districts", "technologies", "agent-versions"]) assert.ok(keys.includes(required), required);
  assert.equal(adminResourceDefinition("policies").supportsUpdate, false);
  assert.equal(adminResourceDefinition("contracts").supportsUpdate, false);
  assert.deepEqual(adminResourceDefinition("devices").registrationFields, ["device_id", "monitoring_point_id", "agent_version", "display_name"]);
});

test("Admin boundary sends only writable fields and rejects unsupported updates", async () => {
  const { createAdminBoundary, writableAdminPayload } = await import("./features/admin.mjs");
  const calls = [];
  const api = {
    async tryRequest(paths, options) {
      calls.push({ paths, options });
      return { ok: true };
    },
  };
  const boundary = createAdminBoundary(api);

  assert.deepEqual(writableAdminPayload("organizations", { id: "wrong", name: "Школа", created_at: "secret", internal: true }, { id: "org-1" }), {
    id: "org-1",
    name: "Школа",
  });
  await boundary.update("organizations", "org-1", { name: "Школа", created_at: "secret", internal: true });
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: "org-1", name: "Школа" });
  await assert.rejects(() => boundary.update("policies", "policy-1", { version: 2 }), (error) => error.code === "unsupported_admin_operation");

  await boundary.registerDevice({ device_id: "device-1", monitoring_point_id: "point-1", display_name: "Agent", secret: "drop" });
  assert.deepEqual(JSON.parse(calls[1].options.body), { device_id: "device-1", monitoring_point_id: "point-1", display_name: "Agent" });
});

test("Admin presentation exposes a localized display subset and keeps technical data separate", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentAdminRecord } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const item = presentAdminRecord("organizations", {
    id: "org-1",
    name: "Школа 32",
    district: "Район",
    created_at: "technical-only",
    private_value: "technical-only",
  }, { i18n, presentation: createPresentation(i18n) });

  assert.deepEqual(item.fields.map((field) => field.key), ["name", "district"]);
  assert.doesNotMatch(JSON.stringify(item.fields), /created_at|private_value/);
  assert.equal(item.technical.private_value, "technical-only");
});

test("ADMIN-003 enum fields use human dictionaries and keep raw values technical", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentAdminRecord } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const presentation = createPresentation(i18n);
  const line = presentAdminRecord("lines", {
    id: "line-raw-1",
    organization_name: "Школа 32",
    provider_name: "Провайдер",
    role: "PRIMARY",
    technology: "FIBER",
    status: "ACTIVE",
  }, { i18n, presentation });
  const policy = presentAdminRecord("policies", {
    id: "policy-raw-1",
    scope_type: "LINE",
    version: 3,
  }, { i18n, presentation });

  assert.equal(line.fields.find((field) => field.key === "technology").value, "Оптоволокно");
  assert.equal(line.fields.find((field) => field.key === "role").value, "Основная");
  assert.doesNotMatch(JSON.stringify(line.fields), /FIBER|PRIMARY|ACTIVE/);
  assert.equal(line.technical.technology, "FIBER");
  assert.equal(policy.fields.find((field) => field.key === "scope_type").value, "Линия");
  assert.doesNotMatch(JSON.stringify(policy.fields), /LINE/);
  assert.equal(policy.technical.scope_type, "LINE");
});

test("AUDIT-002 raw audit values are only available in technical details", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentAuditItem } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "kk", storage: null, root: null });
  const item = presentAuditItem({ id: 1, action: "incident.status.changed", object_type: "incident", object_id: "i-1", actor_type: "USER", actor_id: "user-1", actor_username: "operator", created_at: "2026-09-20T10:00:00Z" }, { i18n, presentation: createPresentation(i18n) });
  assert.equal(item.actionLabel, "Оқиға күйі өзгертілді");
  assert.equal(item.objectLabel, "Оқиғалар");
  assert.equal(item.actorLabel, "operator");
  assert.equal(item.rawAction, "incident.status.changed");
  assert.equal(item.rawObjectType, "incident");
  assert.equal(item.rawObject, "i-1");
  assert.equal(item.rawActorType, "USER");
  assert.equal(item.rawActor, "user-1");
});

test("AUDIT-003 does not present raw object or actor identifiers as human copy", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentAuditItem } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const item = presentAuditItem({ action: "line.unknown", object_type: "unknown_object", object_id: "secret-object", actor_id: "secret-actor" }, { i18n, presentation: createPresentation(i18n) });

  assert.equal(item.objectLabel, "Нет данных");
  assert.equal(item.actorLabel, "Нет данных");
  assert.doesNotMatch(`${item.objectLabel} ${item.actorLabel}`, /unknown_object|secret-object|secret-actor/);
  assert.equal(item.rawObjectType, "unknown_object");
  assert.equal(item.rawObject, "secret-object");
  assert.equal(item.rawActorType, "");
  assert.equal(item.rawActor, "secret-actor");
});
