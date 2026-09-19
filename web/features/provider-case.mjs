import { apiAliases, unwrapCollection } from "../core/api.mjs";

export function createProviderCaseBoundary(api) {
  return {
    async list(filters = {}) { const query = new URLSearchParams(filters); return unwrapCollection(await api.tryRequest(apiAliases(`/provider-cases${query.toString() ? `?${query}` : ""}`))); },
    async get(id) { return api.tryRequest(apiAliases(`/provider-cases/${encodeURIComponent(id)}`)); },
    async create(payload) { return api.tryRequest(apiAliases("/provider-cases"), { method: "POST", body: JSON.stringify(payload) }); },
    async aiDraft(id, idempotencyKey = `linkwatch-ai-${id}-${Date.now()}`) { return api.tryRequest(apiAliases(`/provider-cases/${encodeURIComponent(id)}/ai-draft`), { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({}) }); },
    async send(id, payload) {
      if (payload?.reviewed !== true) throw Object.assign(new Error("Перед отправкой требуется проверка человеком"), { status: 409 });
      return api.tryRequest(apiAliases(`/provider-cases/${encodeURIComponent(id)}/send`), { method: "POST", body: JSON.stringify(payload) });
    },
    async retry(id) { return api.tryRequest(apiAliases(`/provider-cases/${encodeURIComponent(id)}/retry`), { method: "POST" }); },
  };
}
