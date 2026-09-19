import { apiAliases, unwrapCollection } from "../core/api.mjs";

export function createLinesBoundary(api) {
  return {
    async list(filters = {}) { const query = new URLSearchParams(filters); return unwrapCollection(await api.tryRequest(apiAliases(`/lines${query.toString() ? `?${query}` : ""}`))); },
    async get(id) { return api.tryRequest(apiAliases(`/lines/${encodeURIComponent(id)}`)); },
    async context(id) { return api.tryRequest(apiAliases(`/lines/${encodeURIComponent(id)}/context`)); },
    async measurements(id, query = "") { return api.tryRequest(apiAliases(`/lines/${encodeURIComponent(id)}/measurements${query ? `?${query}` : ""}`)); },
    async states(id) { return api.tryRequest(apiAliases(`/lines/${encodeURIComponent(id)}/states`)); },
    async device(id, query = "") { return api.tryRequest(apiAliases(`/devices/${encodeURIComponent(id)}${query ? `?${query}` : ""}`)); },
  };
}
