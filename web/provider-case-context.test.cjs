const assert = require("node:assert/strict");
const test = require("node:test");

test("ProviderCase detail uses stored source, verification and evidence provenance", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentProviderCase } = await import("./features/provider-case-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const presentation = createPresentation(i18n);
  const item = presentProviderCase({
    id: 42,
    source_context: "INCIDENT",
    status: "DRAFT",
    delivery_status: "PENDING",
    draft_text: "Проверить линию",
    created_at: "2026-09-20T08:00:00Z",
    evidence_chain: [
      { verification: { verified_at: "2026-09-20T09:00:00Z" }, configuration_provenance: { historical: { policy: { source: "stored_policy_snapshot" } } } },
      { verification: { verified_at: "2026-09-20T10:00:00Z" } },
    ],
  }, { i18n, presentation });

  assert.equal(item.sourceLabel, "Подтверждённые данные инцидента");
  assert.equal(item.statusLabel, "Черновик");
  assert.equal(item.deliveryLabel, "Ожидает отправки");
  assert.equal(item.provenanceLabel, "Сохранённые снимки подтверждённых наблюдений");
  assert.match(item.lastVerifiedLabel, /20 сент\./);
  assert.doesNotMatch(item.statusLabel, /DRAFT|PENDING/);
});

test("ProviderCase actions remain capability- and delivery-state-gated", async () => {
  const { providerCaseActions } = await import("./features/provider-case-presentation.mjs");
  const readOnly = { has: () => false };
  const sender = { has: (name) => name === "provider_case.send" || name === "provider_case.draft" };

  const draft = providerCaseActions({ status: "DRAFT", delivery_status: "PENDING" }, readOnly);
  assert.equal(draft.canPrepare, false);
  assert.equal(draft.canGenerate, false);
  assert.equal(draft.canSend, false);
  assert.equal(draft.operation, "send");

  const failed = providerCaseActions({ status: "FAILED", delivery_status: "FAILED", delivery_retryable: true }, sender);
  assert.equal(failed.canPrepare, true);
  assert.equal(failed.canGenerate, true);
  assert.equal(failed.canInitialSend, false);
  assert.equal(failed.canRetry, true);
  assert.equal(failed.canSend, true);
  assert.equal(failed.isRetry, true);
  assert.equal(failed.operation, "retry");

  const sent = providerCaseActions({ status: "SENT", delivery_status: "SENT" }, sender);
  assert.equal(sent.canPrepare, true);
  assert.equal(sent.canGenerate, false);
  assert.equal(sent.canSend, false);
  assert.equal(sent.isRetry, false);

  const pending = providerCaseActions({ status: "FAILED", delivery_status: "FAILED", delivery_retryable: true }, sender, "retrying");
  assert.equal(pending.canRetry, false);
  assert.equal(pending.disabled, true);
  assert.equal(pending.pendingState, "retrying");
});

test("ProviderCase delivery request selects retry semantics and keeps human review explicit", async () => {
  const { providerCaseDeliveryRequest } = await import("./features/provider-case-presentation.mjs");

  assert.deepEqual(providerCaseDeliveryRequest({ delivery_status: "FAILED", delivery_retryable: true }, {
    finalText: "  Проверка линии  ",
    incidentId: 42,
  }), {
    operation: "retry",
    payload: { reviewed: true, final_text: "Проверка линии", incident_id: 42 },
  });
  assert.deepEqual(providerCaseDeliveryRequest({ delivery_status: "PENDING" }, { reviewed: false }), {
    operation: "send",
    payload: { reviewed: false },
  });
});

test("ProviderCase retry boundary uses the backend retry route and writable delivery fields", async () => {
  const { createProviderCaseBoundary } = await import("./features/provider-case.mjs");
  const calls = [];
  const api = {
    async tryRequest(paths, options) {
      calls.push({ paths, options });
      return { ok: true };
    },
  };
  const boundary = createProviderCaseBoundary(api);

  await boundary.retry(7, { final_text: "Проверено", reviewed: true, unsupported: "drop" });
  assert.equal(calls[0].paths[0], "/api/provider-cases/7/retry");
  assert.deepEqual(JSON.parse(calls[0].options.body), { reviewed: true, final_text: "Проверено" });
  await assert.rejects(() => boundary.send(7, { reviewed: false }), (error) => error.code === "human_review_required");
});

test("ProviderCase wording is localized in Kazakh", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { presentProviderCase } = await import("./features/provider-case-presentation.mjs");
  const i18n = createI18n({ locale: "kk", storage: null, root: null });
  const item = presentProviderCase({ source_context: "LINE", status: "FAILED", delivery_status: "FAILED" }, { i18n, presentation: createPresentation(i18n) });

  assert.equal(item.sourceLabel, "Таңдалған желі деректері");
  assert.equal(item.statusLabel, "Жеткізу қатесі");
  assert.equal(item.deliveryLabel, "Жіберу қатесі");
});
