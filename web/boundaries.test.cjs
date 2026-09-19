const assert = require("node:assert/strict");
const test = require("node:test");

test("presentation boundary exposes human labels and stable status tones", async () => {
  const presentation = await import("./core/presentation.mjs");
  assert.equal(presentation.humanStatus("NO_INTERNET"), "Нет соединения");
  assert.equal(presentation.statusPresentation("DEGRADED").tone, "unstable");
  assert.match(presentation.formatNumber(12.4, " Мбит/с"), /12,4/);
});

test("capability and router boundaries keep restricted destinations explicit", async () => {
  const { createCapabilityState } = await import("./core/capabilities.mjs");
  const { createShellRouter } = await import("./core/router.mjs");
  const capabilities = createCapabilityState({ role: "SCHOOL", capabilities: ["line.read"] });
  const router = createShellRouter({ canAccess: (view) => view !== "admin" });
  assert.equal(capabilities.has("line.read"), true);
  assert.equal(router.navigate("admin"), false);
  assert.equal(router.navigate("incidents"), true);
});

test("provider-case boundary enforces the human review gate before send", async () => {
  const { createProviderCaseBoundary } = await import("./features/provider-case.mjs");
  const calls = [];
  const api = { tryRequest: async (paths, options) => { calls.push({ paths, options }); return { status: "SENT" }; } };
  const providerCases = createProviderCaseBoundary(api);
  await assert.rejects(() => providerCases.send("case-1", { reviewed: false }), (error) => error.status === 409);
  await providerCases.send("case-1", { reviewed: true, final_text: "Проверенный текст" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].paths[0], /provider-cases\/case-1\/send/);
});
