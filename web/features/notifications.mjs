import { apiAliases, unwrapCollection } from "../core/api.mjs";

const NOTIFICATION_FILTERS = Object.freeze(new Set(["source_type", "status", "before_id", "limit"]));
const DISPATCHABLE_STATUSES = Object.freeze(new Set(["PENDING", "GENERATED", "FAILED"]));
export const NOTIFICATION_POLL_INTERVAL_MS = 5_000;
export const NOTIFICATION_SEEN_STORAGE_KEY = "linkwatch.notifications.seen";

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

export function notificationKey(item) {
  const id = item?.id;
  if (id !== undefined && id !== null && String(id).trim() !== "") return String(id);
  return [item?.source_type, item?.source_id, item?.generated_at || item?.created_at, item?.message]
    .map((value) => String(value ?? "").trim())
    .join("|");
}

export function notificationIsServerRead(item) {
  return item?.read_at !== undefined && item?.read_at !== null && String(item.read_at).trim() !== "";
}

export function notificationSeenStorageKey(identity = "anonymous") {
  const value = String(identity || "anonymous").trim().replace(/[^\w.-]+/g, "_");
  return `${NOTIFICATION_SEEN_STORAGE_KEY}.${value || "anonymous"}`;
}

export function readNotificationSeenIDs(storage, key) {
  if (!storage || !key) return new Set();
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  } catch (error) {
    return new Set();
  }
}

export function writeNotificationSeenIDs(storage, key, ids) {
  if (!storage || !key) return;
  const values = [...new Set((ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(-200);
  try {
    storage.setItem(key, JSON.stringify(values));
  } catch (error) {
    // Private browsing and quota-restricted storage must not break notifications.
  }
}

export function notificationSummary(items, seenIDs = new Set()) {
  const seen = seenIDs instanceof Set ? seenIDs : new Set(Array.isArray(seenIDs) ? seenIDs.map(String) : []);
  const values = Array.isArray(items) ? items : [];
  const unseen = values.filter((item) => {
    const key = notificationKey(item);
    return key && !notificationIsServerRead(item) && !seen.has(key);
  });
  return {
    unseen,
    unseenIDs: unseen.map(notificationKey),
    serverUnreadCount: values.filter((item) => !notificationIsServerRead(item)).length,
  };
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
