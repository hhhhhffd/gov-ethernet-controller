import { apiAliases, unwrapCollection } from "../core/api.mjs";

export function createIncidentsBoundary(api) {
  return {
    async list(filters = {}) { const query = new URLSearchParams(filters); return unwrapCollection(await api.tryRequest(apiAliases(`/incidents${query.toString() ? `?${query}` : ""}`))); },
    async get(id) { return api.tryRequest(apiAliases(`/incidents/${encodeURIComponent(id)}`)); },
    async create(payload) { return api.tryRequest(apiAliases("/incidents"), { method: "POST", body: JSON.stringify(payload) }); },
    async addEvent(id, payload) { return api.tryRequest(apiAliases(`/incidents/${encodeURIComponent(id)}/events`), { method: "POST", body: JSON.stringify(payload) }); },
    async createProviderCaseDraft(id, payload = {}) { return api.tryRequest(apiAliases(`/incidents/${encodeURIComponent(id)}/provider-case/draft`), { method: "POST", body: JSON.stringify(payload) }); },
    async situations(filters = {}) { const query = new URLSearchParams(filters); return unwrapCollection(await api.tryRequest(apiAliases(`/situations${query.toString() ? `?${query}` : ""}`))); },
    async situation(id) { return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}`)); },
    async situationComparison(id, query = "") { return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}/comparison${query ? `?${query}` : ""}`)); },
    async liveVerify(id) { return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}/live-verify`), { method: "POST" }); },
    async manageSituation(id, action, payload) { return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}/${action}`), { method: "POST", headers: { "Idempotency-Key": payload?.idempotencyKey || `linkwatch-${id}-${action}-${Date.now()}` }, body: JSON.stringify(payload) }); },
  };
}
