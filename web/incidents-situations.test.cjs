const assert = require("node:assert/strict");
const test = require("node:test");

test("incident filters and counts are derived only from returned incidents", async () => {
  const { filterIncidents, incidentSeverityValues, incidentStatusValues } = await import("./features/incidents-presentation.mjs");
  const items = [
    { id: 1, status: "NEW", severity: "CRITICAL" },
    { id: 2, status: "IN_PROGRESS", severity: "ATTENTION" },
    { id: 3, status: "NEW", severity: "CRITICAL" },
  ];

  assert.deepEqual(incidentStatusValues(items), ["IN_PROGRESS", "NEW"]);
  assert.deepEqual(incidentSeverityValues(items), ["ATTENTION", "CRITICAL"]);
  assert.deepEqual(filterIncidents(items, { status: "NEW", severity: "CRITICAL" }).map((item) => item.id), [1, 3]);
  assert.deepEqual(filterIncidents(items, { status: "CLOSED" }), []);
});

test("incident detail presents types, recovery, duration, and timeline without raw backend codes", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { formatIncidentDuration, presentIncident, presentRecovery, presentTimeline } = await import("./features/incidents-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const presentation = createPresentation(i18n);
  const incident = presentIncident({ id: 12, incident_no: "INC-000012", status: "IN_PROGRESS", severity: "CRITICAL", violation_type: "NO_INTERNET", school_name: "Школа", line_id: "L-12", started_at: "2026-09-20T09:00:00Z", duration_minutes: 125, events: [{ event_type: "STATUS_CHANGED", created_at: "2026-09-20T10:00:00Z" }] }, { i18n, presentation, now: Date.parse("2026-09-20T10:20:00Z") });

  assert.equal(incident.typeLabel, "Подтверждённое отсутствие интернета");
  assert.equal(incident.severityLabel, "Критический");
  assert.equal(incident.durationLabel, "2 ч 5 мин");
  assert.equal(incident.line, "Линия");
  assert.doesNotMatch(incident.typeLabel, /NO_INTERNET|CRITICAL/);
  assert.equal(formatIncidentDuration(15, i18n), "15 мин");
  assert.equal(presentRecovery({ recovery_state: "OBSERVED" }, { i18n }).label, "Восстановление наблюдается; ждём подтверждения");
  const timeline = presentTimeline([{ id: 9, event_type: "PROVIDER_REPORTED_FIXED", actor: "system", payload: { status: "RESOLVED", note: "Проверяем связь" }, created_at: "2026-09-20T10:00:00Z" }], { i18n, presentation });
  assert.equal(timeline[0].label, "Провайдер сообщил об устранении");
  assert.equal(timeline[0].status, "Устранён; ожидает проверки");
  assert.equal(timeline[0].actor, "");
  assert.doesNotMatch(timeline[0].label, /PROVIDER_REPORTED_FIXED/);
});

test("incident reason turns evaluation codes into a localized human explanation", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentIncident } = await import("./features/incidents-presentation.mjs");
  const reason = "Required metric unavailable; NO_INTERNET; packet_loss 100 (> 2); availability 0 (< 99); packet_loss 100 (> 2); availability 0 (< 99)";

  const ruI18n = createI18n({ locale: "ru", storage: null, root: null });
  const ru = presentIncident({ description: reason }, { i18n: ruI18n, presentation: createPresentation(ruI18n) });
  assert.equal(ru.description, "Часть обязательных показателей не получена. Мониторинг подтвердил отсутствие доступа в интернет. Зафиксированы показатели вне допустимого диапазона: Потеря пакетов: 100 % (максимум 2 %); Доступность: 0 % (минимум 99 %).");
  assert.doesNotMatch(ru.description, /Required|NO_INTERNET|packet_loss|availability|\(>/);

  const kkI18n = createI18n({ locale: "kk", storage: null, root: null });
  const kk = presentIncident({ description: reason }, { i18n: kkI18n, presentation: createPresentation(kkI18n) });
  assert.equal(kk.description, "Қажетті көрсеткіштердің бір бөлігі алынбады. Мониторинг интернетке қолжетімділіктің жоқ екенін растады. Рұқсат етілген шектен тыс көрсеткіштер анықталды: Пакет жоғалту: 100 % (ең жоғары шек — 2 %); Қолжетімділік: 0 % (ең төменгі шек — 99 %).");
  assert.doesNotMatch(kk.description, /Required|NO_INTERNET|packet_loss|availability|\(>/);
});

test("incident and situation actions are capability-gated and pending-aware", async () => {
  const { incidentActions, situationActions } = await import("./features/incidents-presentation.mjs");
  const manager = { has: (name) => name === "incident.update" || name === "situation.manage" };

  assert.equal(incidentActions({ status: "IN_PROGRESS" }, manager).canMarkProviderFixed, true);
  assert.equal(incidentActions({ status: "CLOSED" }, manager).canMarkProviderFixed, false);
  assert.equal(incidentActions({ status: "IN_PROGRESS" }, manager, "saving").canComment, false);
  assert.equal(situationActions({ status: "OPEN" }, manager).canLiveVerify, true);
  assert.equal(situationActions({ status: "OPEN" }, manager).canMerge, true);
  assert.equal(situationActions({ status: "OPEN" }, manager, "merging").canMerge, false);
  assert.equal(situationActions({ status: "OPEN" }, { has: () => false }).readOnly, true);
});

test("incident and situation boundaries keep request payloads within backend actions", async () => {
  const { createIncidentsBoundary, incidentEventPayload, situationActionPayload } = await import("./features/incidents.mjs");
  const calls = [];
  const api = {
    async tryRequest(paths, options) {
      calls.push({ paths, options });
      return { ok: true };
    },
  };
  const boundary = createIncidentsBoundary(api);

  assert.deepEqual(incidentEventPayload("comment", { note: "  уточнение  ", internal: "drop" }), {
    event_type: "comment",
    note: "уточнение",
  });
  await boundary.addEvent(12, { event_type: "comment", note: "уточнение", internal: "drop" });
  assert.deepEqual(JSON.parse(calls[0].options.body), { event_type: "comment", note: "уточнение" });

  assert.deepEqual(situationActionPayload("merge", { reason: "  объединение  ", situation_ids: ["5", "5"], idempotencyKey: "req-1", internal: "drop" }), {
    reason: "объединение",
    situation_ids: ["5"],
  });
  await boundary.manageSituation(5, "merge", { reason: "объединение", situation_ids: ["6"], idempotencyKey: "req-1", internal: "drop" });
  assert.equal(calls[1].paths[0], "/api/situations/5/merge");
  assert.equal(calls[1].options.headers["Idempotency-Key"], "req-1");
  assert.deepEqual(JSON.parse(calls[1].options.body), { reason: "объединение", situation_ids: ["6"] });
  await assert.rejects(() => boundary.manageSituation(5, "split", { incident_ids: ["1"] }), (error) => error.code === "situation_reason_required");
});

test("situations stay contextual and localized in Kazakh", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentSituation, relatedSituations } = await import("./features/incidents-presentation.mjs");
  const i18n = createI18n({ locale: "kk", storage: null, root: null });
  const presentation = createPresentation(i18n);
  const situations = [
    { id: 5, title: "Backend-only title", incident_ids: [12, 13], violation_type: "NO_INTERNET", severity: "CRITICAL", affected_count: 2 },
    { id: 6, title: "Other backend title", incident_ids: [99], violation_type: "MANUAL_REVIEW", severity: "ATTENTION", affected_count: 1 },
  ];

  assert.deepEqual(relatedSituations(situations, 12).map((item) => item.id), [5]);
  const result = presentSituation(situations[0], { i18n, presentation });
  assert.equal(result.typeLabel, "Интернеттің жоқтығы расталды");
  assert.equal(result.severityLabel, "Сындарлы");
  assert.equal(result.title, "Байланысты жағдай #5");
  assert.doesNotMatch(result.typeLabel, /NO_INTERNET/);
});
