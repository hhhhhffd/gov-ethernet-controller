import { apiAliases, unwrapCollection } from "../core/api.mjs";

const INCIDENT_EVENT_TYPES = Object.freeze(new Set(["provider_fixed", "send_to_provider", "assign", "status", "comment"]));
const SITUATION_ACTIONS = Object.freeze(new Set(["merge", "split"]));

function positiveID(id, label) {
  const value = String(id ?? "").trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) throw Object.assign(new Error(`${label} must be positive`), { code: "invalid_id" });
  return value;
}

function uniqueIDs(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => positiveID(value, "id")))];
}

export function incidentEventPayload(eventType, payload = {}) {
  if (!INCIDENT_EVENT_TYPES.has(eventType)) throw Object.assign(new Error(`Unsupported incident event: ${eventType}`), { code: "unsupported_incident_event" });
  const result = { event_type: eventType };
  if (payload.note !== undefined) result.note = String(payload.note).trim();
  if (payload.status !== undefined) result.status = String(payload.status).trim();
  return result;
}

export function situationActionPayload(action, payload = {}) {
  if (!SITUATION_ACTIONS.has(action)) throw Object.assign(new Error(`Unsupported situation action: ${action}`), { code: "unsupported_situation_action" });
  const result = { reason: String(payload.reason || "").trim() };
  if (!result.reason) throw Object.assign(new Error("Situation action reason is required"), { code: "situation_reason_required" });
  if (payload.expected_updated_at !== undefined) result.expected_updated_at = payload.expected_updated_at;
  if (action === "merge") result.situation_ids = uniqueIDs(payload.situation_ids);
  if (action === "split") result.incident_ids = uniqueIDs(payload.incident_ids);
  return result;
}

export function createIncidentsBoundary(api) {
  return {
    async list(filters = {}) {
      const query = new URLSearchParams(filters);
      return unwrapCollection(await api.tryRequest(apiAliases(`/incidents${query.toString() ? `?${query}` : ""}`)));
    },
    async get(id) {
      return api.tryRequest(apiAliases(`/incidents/${encodeURIComponent(id)}`));
    },
    async create(payload) {
      return api.tryRequest(apiAliases("/incidents"), { method: "POST", body: JSON.stringify(payload) });
    },
    async addEvent(id, payload) {
      return api.tryRequest(apiAliases(`/incidents/${encodeURIComponent(id)}/events`), { method: "POST", body: JSON.stringify(incidentEventPayload(payload?.event_type, payload)) });
    },
    async createProviderCaseDraft(id, payload = {}) {
      const body = {};
      if (payload.comment !== undefined) body.comment = String(payload.comment).trim();
      return api.tryRequest(apiAliases(`/incidents/${encodeURIComponent(id)}/provider-case/draft`), { method: "POST", body: JSON.stringify(body) });
    },
    async situations(filters = {}) {
      const query = new URLSearchParams(filters);
      return unwrapCollection(await api.tryRequest(apiAliases(`/situations${query.toString() ? `?${query}` : ""}`)));
    },
    async situation(id) {
      return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}`));
    },
    async situationComparison(id, query = "") {
      return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}/comparison${query ? `?${query}` : ""}`));
    },
    async liveVerify(id) {
      return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}/live-verify`), { method: "POST" });
    },
    async manageSituation(id, action, payload = {}) {
      const body = situationActionPayload(action, payload);
      const idempotencyKey = String(payload.idempotencyKey || `linkwatch-${id}-${action}-${Date.now()}`);
      return api.tryRequest(apiAliases(`/situations/${encodeURIComponent(id)}/${action}`), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
    },
  };
}
