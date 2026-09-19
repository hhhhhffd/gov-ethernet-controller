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

  assert.deepEqual(providerCaseActions({ status: "DRAFT", delivery_status: "PENDING" }, readOnly), {
    canPrepare: false, canGenerate: false, canSend: false, isRetry: false,
  });
  assert.deepEqual(providerCaseActions({ status: "FAILED", delivery_status: "FAILED", delivery_retryable: true }, sender), {
    canPrepare: true, canGenerate: true, canSend: true, isRetry: true,
  });
  assert.deepEqual(providerCaseActions({ status: "SENT", delivery_status: "SENT" }, sender), {
    canPrepare: true, canGenerate: false, canSend: false, isRetry: false,
  });
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
