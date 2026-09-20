import { apiAliases, unwrapCollection } from "../core/api.mjs";

const DELIVERY_ACTIONS = Object.freeze(new Set(["send", "retry"]));
const DELIVERY_FIELDS = Object.freeze(["reviewed", "final_text", "text", "ticket_no", "incident_id"]);

function providerCasePath(id, suffix = "") {
  const encodedID = encodeURIComponent(id);
  return `/provider-cases/${encodedID}${suffix}`;
}

function deliveryPayload(payload = {}) {
  const result = {};
  for (const field of DELIVERY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined) {
      result[field] = payload[field];
    }
  }
  return result;
}

function reviewedDeliveryPayload(payload = {}) {
  const result = deliveryPayload(payload);
  if (result.reviewed !== true) {
    throw Object.assign(new Error("Перед отправкой требуется проверка человеком"), { status: 409, code: "human_review_required" });
  }
  return result;
}

function unsupportedDeliveryAction(action) {
  return Object.assign(new Error(`Unsupported provider case delivery action: ${action}`), { code: "unsupported_delivery_action" });
}

export function createProviderCaseBoundary(api) {
  async function deliver(id, action, payload = {}) {
    if (!DELIVERY_ACTIONS.has(action)) throw unsupportedDeliveryAction(action);
    const body = reviewedDeliveryPayload(payload);
    return api.tryRequest(apiAliases(providerCasePath(id, `/${action}`)), {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  return {
    async list(filters = {}) {
      const query = new URLSearchParams(filters);
      const suffix = query.toString() ? `?${query}` : "";
      return unwrapCollection(await api.tryRequest(apiAliases(`/provider-cases${suffix}`)));
    },
    async get(id) {
      return api.tryRequest(apiAliases(providerCasePath(id)));
    },
    async create(payload) {
      return api.tryRequest(apiAliases("/provider-cases"), { method: "POST", body: JSON.stringify(payload) });
    },
    async aiDraft(id, idempotencyKey = `linkwatch-ai-${id}-${Date.now()}`) {
      return api.tryRequest(apiAliases(providerCasePath(id, "/ai-draft")), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({}),
      });
    },
    async send(id, payload = {}) {
      return deliver(id, "send", payload);
    },
    async retry(id, payload = {}) {
      return deliver(id, "retry", { ...payload, reviewed: payload.reviewed ?? true });
    },
    async deliver(id, action, payload = {}) {
      return deliver(id, action, payload);
    },
  };
}
