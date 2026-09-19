import { apiAliases, unwrapCollection } from "../core/api.mjs";

export function createAuditBoundary(api) {
  return {
    async list(filters = {}) { const query = new URLSearchParams(filters); return api.tryRequest(apiAliases(`/audit${query.toString() ? `?${query}` : ""}`)); },
    async agentVersions(query = "limit=50") { return unwrapCollection(await api.tryRequest(apiAliases(`/agent-versions?${query}`))); },
    async versionDevices(version) { return unwrapCollection(await api.tryRequest(apiAliases(`/agent-versions/${encodeURIComponent(version)}/devices`))); },
  };
}
