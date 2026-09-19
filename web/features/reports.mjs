import { apiAliases } from "../core/api.mjs";

function queryString(query) { return typeof query === "string" ? query : new URLSearchParams(query).toString(); }

export function createReportsBoundary(api) {
  return {
    aggregate(query) { return api.tryRequest(apiAliases(`/reports/aggregate${queryString(query) ? `?${queryString(query)}` : ""}`)); },
    analytics(query) { return api.tryRequest(apiAliases(`/reports/analytics${queryString(query) ? `?${queryString(query)}` : ""}`)); },
    qualityPassport(query) { return api.tryRequest(apiAliases(`/reports/quality-passport${queryString(query) ? `?${queryString(query)}` : ""}`)); },
    evidenceReport(query) { return api.download(apiAliases(`/reports/quality-passport/evidence?${queryString(query)}`)); },
    exportPreview(query) { return api.tryRequest(apiAliases(`/exports/preview?${queryString(query)}`)); },
    exportData(query) { return api.download(apiAliases(`/exports?${queryString(query)}`)); },
  };
}
