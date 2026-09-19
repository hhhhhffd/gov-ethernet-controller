import { createI18n } from "./i18n.mjs";

const STATUS_TONES = Object.freeze({
  critical: new Set(["NO_INTERNET", "CRITICAL", "DOWN", "OUTAGE"]),
  unstable: new Set(["DEGRADED", "UNSTABLE", "ATTENTION", "DEVIATES"]),
  noData: new Set(["NO_DATA", "UNKNOWN", "STALE"]),
});
const defaultI18n = createI18n();

function codeOf(value) {
  return String(value ?? "UNKNOWN").trim().toUpperCase().replace(/[.\s-]+/g, "_");
}
function enumLabel(i18n, group, value) {
  const code = codeOf(value);
  return i18n.has(group + "." + code) ? i18n.t(group + "." + code) : i18n.t(group + ".UNKNOWN");
}

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

export function createPresentation(i18n = defaultI18n) {
  const localeName = () => i18n.locale === "kk" ? "kk-KZ" : "ru-RU";
  const empty = () => i18n.t("empty.value");
  return {
    t: i18n.t,
    empty,
    status(value) {
      const code = codeOf(value);
      const tone = STATUS_TONES.critical.has(code) ? "critical" : STATUS_TONES.unstable.has(code) ? "unstable" : STATUS_TONES.noData.has(code) ? "no-data" : "healthy";
      return { code, label: enumLabel(i18n, "status", code), tone };
    },
    statusDescription(value) {
      return enumLabel(i18n, "statusDetail", value);
    },
    role: (value) => enumLabel(i18n, "role", value),
    userRole: (value) => enumLabel(i18n, "userRole", value),
    incidentStatus: (value) => enumLabel(i18n, "incident", value),
    deliveryStatus: (value) => enumLabel(i18n, "delivery", value),
    lineState: (value) => enumLabel(i18n, "lineState", value),
    connectionType: (value) => enumLabel(i18n, "type", value),
    coordinateSource: (value) => enumLabel(i18n, "coordinate", value),
    event(value) {
      const normalized = String(value ?? "").trim().toLowerCase().replace(/_/g, ".");
      return i18n.has("event." + normalized) ? i18n.t("event." + normalized) : i18n.t("event.unknown");
    },
    action(value) {
      const normalized = String(value ?? "").trim().toLowerCase().replace(/_/g, ".");
      return i18n.has("action." + normalized) ? i18n.t("action." + normalized) : i18n.t("action.unknown");
    },
    error(error) {
      return i18n.t("error." + Number(error?.status), undefined, i18n.t("error.unknown"));
    },
    schoolName(school, fallback) {
      const localized = i18n.locale === "kk"
        ? school?.officialNameKk ?? school?.official_name_kk ?? school?.nameKk ?? school?.name_kk
        : school?.officialNameRu ?? school?.official_name_ru ?? school?.nameRu ?? school?.name_ru;
      return localized || school?.officialName || school?.official_name || school?.name || fallback || i18n.t("school.noOfficialName");
    },
    formatNumber(value, suffix = "") {
      return value == null || Number.isNaN(Number(value)) ? empty() : Number(value).toLocaleString(localeName(), { maximumFractionDigits: 1 }) + suffix;
    },
    formatDate(value, withDate = false) {
      if (!value) return empty();
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return empty();
      return date.toLocaleString(localeName(), { day: withDate ? "2-digit" : undefined, month: withDate ? "short" : undefined, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" });
    },
    formatRelative(value, now = Date.now()) {
      if (!value) return i18n.t("empty.noData");
      const minutes = Math.round(Math.max(0, now - new Date(value).getTime()) / 60000);
      if (minutes < 2) return i18n.t("relative.justNow");
      if (minutes < 60) return i18n.t("relative.minutesAgo", { count: minutes });
      return i18n.t("relative.hoursAgo", { count: Math.round(minutes / 60) });
    },
  };
}

const defaultPresentation = createPresentation(defaultI18n);
export const formatNumber = (...args) => defaultPresentation.formatNumber(...args);
export const formatDate = (...args) => defaultPresentation.formatDate(...args);
export const formatRelative = (...args) => defaultPresentation.formatRelative(...args);
export const statusPresentation = (...args) => defaultPresentation.status(...args);
export const humanStatus = (value) => defaultPresentation.status(value).label;
export const humanRole = (value) => defaultPresentation.role(value);
export const humanUserRole = (value) => defaultPresentation.userRole(value);
export const humanIncidentStatus = (value) => defaultPresentation.incidentStatus(value);
export const humanDeliveryStatus = (value) => defaultPresentation.deliveryStatus(value);
export function presentationMaps() {
  return { locale: defaultI18n.locale, statuses: "status", roles: "role", userRoles: "userRole", incidents: "incident", deliveries: "delivery" };
}
