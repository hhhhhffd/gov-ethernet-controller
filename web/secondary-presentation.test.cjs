const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("NOTIFICATION-001 presents delivery and omits unread semantics", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentNotification } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const item = presentNotification({ source_type: "PROVIDER_CASE", message: "Проверка", status: "PENDING", generated_at: "2026-09-20T10:00:00Z", delivery_attempts: 2 }, { i18n, presentation: createPresentation(i18n) });
  assert.equal(item.message, "Проверка");
  assert.equal(item.deliveryLabel, "Ожидает отправки");
  assert.equal(item.attempts, 2);
  assert.equal(item.scopeAvailable, false);
  assert.doesNotMatch(fs.readFileSync("web/index.html", "utf8"), /notification.*badge|unread/i);
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
  assert.match(html, /id="adminMenuButton"[^>]*data-capability="admin\.manage"/);
  assert.match(html, /id="auditMenuButton"[^>]*data-capability="audit\.read"/);
  assert.match(app, /boundaries\.admin\.save/);
  assert.match(app, /boundaries\.audit\.agentVersions/);
  assert.match(app, /presentAuditItem/);
  assert.match(app, /<details><summary.*audit\.technical/);
});

test("ADMIN-002 resource inventory covers real admin API families", async () => {
  const { adminResourceDefinitions } = await import("./features/secondary-presentation.mjs");
  const keys = adminResourceDefinitions().map((item) => item.key);
  for (const required of ["organizations", "providers", "lines", "monitoring-points", "users", "devices", "schedule", "policies", "contracts", "districts", "technologies", "agent-versions"]) assert.ok(keys.includes(required), required);
});

test("AUDIT-002 raw audit values are only available in technical details", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentAuditItem } = await import("./features/secondary-presentation.mjs");
  const i18n = createI18n({ locale: "kk", storage: null, root: null });
  const item = presentAuditItem({ id: 1, action: "incident.status.changed", object_type: "incident", object_id: "i-1", actor_username: "operator", created_at: "2026-09-20T10:00:00Z" }, { i18n, presentation: createPresentation(i18n) });
  assert.equal(item.actionLabel, "Оқиға күйі өзгертілді");
  assert.equal(item.rawAction, "incident.status.changed");
  assert.equal(item.rawObject, "i-1");
});
