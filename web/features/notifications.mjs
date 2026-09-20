import { apiAliases, unwrapCollection } from "../core/api.mjs";

const NOTIFICATION_FILTERS = Object.freeze(new Set(["source_type", "status", "before_id", "limit"]));
const DISPATCHABLE_STATUSES = Object.freeze(new Set(["PENDING", "GENERATED", "FAILED"]));

function code(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[.\s-]+/g, "_");
}

function notificationID(id) {
  const value = String(id ?? "").trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw Object.assign(new Error("Notification id must be positive"), { code: "invalid_notification_id" });
  }
  return value;
}

function notificationQuery(filters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (NOTIFICATION_FILTERS.has(key) && value !== undefined && value !== null && String(value) !== "") query.set(key, String(value));
  }
  return query;
}

export function createNotificationsBoundary(api) {
  return {
    async list(filters = {}) {
      const query = notificationQuery(filters);
      return unwrapCollection(await api.tryRequest(apiAliases(`/notifications${query.toString() ? `?${query}` : ""}`)));
    },
    async dispatch(id) {
      const value = notificationID(id);
      return api.tryRequest(apiAliases(`/admin/notifications/${encodeURIComponent(value)}/dispatch`), { method: "POST" });
    },
  };
}

export function notificationActions(item, capabilities, pending = false) {
  const status = code(item?.status);
  const canDispatch = capabilities?.has?.("notification.dispatch") === true
    && DISPATCHABLE_STATUSES.has(status)
    && pending !== true;
  return {
    status,
    canDispatch,
    disabled: pending === true,
    isPending: pending === true,
    operation: "dispatch",
  };
}
