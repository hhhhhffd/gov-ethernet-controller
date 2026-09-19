import { apiAliases, unwrapCollection } from "../core/api.mjs";

export function createNotificationsBoundary(api) {
  return {
    async list(filters = {}) { const query = new URLSearchParams(filters); return unwrapCollection(await api.tryRequest(apiAliases(`/notifications${query.toString() ? `?${query}` : ""}`))); },
    async dispatch(id) { return api.tryRequest(apiAliases(`/admin/notifications/${encodeURIComponent(id)}/dispatch`), { method: "POST" }); },
  };
}
