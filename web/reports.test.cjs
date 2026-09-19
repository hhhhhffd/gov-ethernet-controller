const assert = require("node:assert/strict");
const test = require("node:test");

test("REPORT-001 query uses only supported filters and inclusive date inputs", async () => {
  const { reportQuery } = await import("./features/reports-presentation.mjs");
  const result = reportQuery({ from: "2026-09-01", to: "2026-09-03", district: "Altai", provider: "P-1", line_id: "L-1", school_id: "S-1", invented: "no" });
  const query = new URLSearchParams(result.query);
  assert.equal(result.error, null);
  assert.equal(query.get("from"), "2026-09-01T00:00:00.000Z");
  assert.equal(query.get("to"), "2026-09-04T00:00:00.000Z");
  assert.equal(query.get("line_id"), "L-1");
  assert.equal(query.has("invented"), false);
  assert.equal(reportQuery({ from: "2026-09-04", to: "2026-09-03" }).error, "invalid-date-range");
});

test("REPORT-002 context and filter options only use real selected/map records", async () => {
  const { defaultReportFilters, reportContextFilters, reportFilterOptions } = await import("./features/reports-presentation.mjs");
  const selected = reportContextFilters(defaultReportFilters(new Date("2026-09-20T10:00:00Z")), { line: { id: "L-4", school_id: "S-4" } });
  assert.equal(selected.line_id, "L-4");
  assert.equal(selected.school_id, "S-4");
  assert.deepEqual(reportFilterOptions([{ id: "L-4", school_id: "S-4", school_name: "Школа 4", district: "Altai", provider: "Provider" }]), {
    districts: ["Altai"], providers: ["Provider"], lines: ["L-4"], schools: [{ id: "S-4", name: "Школа 4" }],
  });
});

test("QUALITY-001 evidence provenance and verification never use current configuration", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const { reportEvidenceSummary } = await import("./features/reports-presentation.mjs");
  const i18n = createI18n({ locale: "ru", storage: null, root: null });
  const summary = reportEvidenceSummary({ evidence_chain: [{ verification: { verified_at: "2026-09-20T10:00:00Z" }, configuration_provenance: { historical: {} } }] }, { i18n, presentation: createPresentation(i18n) });
  assert.equal(summary.count, 1);
  assert.equal(summary.provenance, "Сохранённые исторические снимки политики, договора и контекста линии");
  assert.match(summary.lastVerified, /20 сент\./);
});

test("ANALYTICS-001 historical series and rankings are read from the analytics response", async () => {
  const analytics = { historical_only: true, current_state_used: false, trend: [{ key: "2026-09-20", measurements: 4 }], ranking: [{ line_id: "L-4", valid_evidence: 3 }] };
  assert.equal(analytics.historical_only, true);
  assert.equal(analytics.current_state_used, false);
  assert.equal(analytics.trend[0].measurements, 4);
  assert.equal(analytics.ranking[0].line_id, "L-4");
});

test("EVIDENCE-001 and EXPORT-001 use supported endpoints without a PDF promise", async () => {
  const { createReportsBoundary } = await import("./features/reports.mjs");
  const calls = [];
  const api = {
    async tryRequest(paths) { calls.push({ type: "request", paths }); return { count: 2, columns: ["line_id"] }; },
    async download(paths) { calls.push({ type: "download", paths }); return { blob: async () => new Blob(["report"]) }; },
  };
  const reports = createReportsBoundary(api);
  await reports.analytics("period=week");
  await reports.exportPreview("kind=aggregate&format=xlsx");
  await reports.exportData("kind=raw&format=csv");
  await reports.evidenceReport("period=week");
  assert.deepEqual(calls.map((call) => call.paths[0]), [
    "/api/reports/analytics?period=week", "/api/exports/preview?kind=aggregate&format=xlsx", "/api/exports?kind=raw&format=csv", "/api/reports/quality-passport/evidence?period=week",
  ]);
  assert.equal(calls.some((call) => call.paths.some((path) => path.includes("pdf"))), false);
});

test("EXPORT-002 export controls are capability-gated and the Reports surface has one export entry point", async () => {
  const { createCapabilityState } = await import("./core/capabilities.mjs");
  const fs = require("node:fs");
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.equal(createCapabilityState({ capabilities: ["report.read"] }).has("report.export"), false);
  assert.equal(createCapabilityState({ capabilities: ["report.read", "report.export"] }).has("report.export"), true);
  assert.match(app, /state\.capabilities\.has\("report\.export"\)/);
  assert.equal((app.match(/<form data-report-export>/g) || []).length, 1, "one contextual export form");
  assert.equal((app.match(/data-evidence-preview>/g) || []).length, 1, "one HTML evidence action");
});
