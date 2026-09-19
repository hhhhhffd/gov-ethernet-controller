const STATUS_LABELS = Object.freeze({
  OK: "Норма", HEALTHY: "Норма", DEGRADED: "Нестабильно", UNSTABLE: "Нестабильно",
  CRITICAL: "Критично", NO_INTERNET: "Нет соединения", NO_DATA: "Нет актуальных данных",
  NOT_MONITORED: "Не подключена", UNKNOWN: "Недостаточно данных",
});
const ROLE_LABELS = Object.freeze({ PRIMARY: "Основная", RESERVE: "Резервная", INACTIVE: "Неактивная" });
const INCIDENT_LABELS = Object.freeze({ NEW: "Новый", SENT_TO_PROVIDER: "Передан провайдеру", IN_PROGRESS: "В работе", WAITING_INFO: "Ожидает информации", RESOLVED: "Устранён · проверка", CLOSED: "Закрыт" });
const DELIVERY_LABELS = Object.freeze({ PENDING: "Ожидает доставки", GENERATED: "Сформировано", DELIVERING: "Доставляется", SENT: "Доставлено", FAILED: "Ошибка доставки" });

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}
export function formatNumber(value, suffix = "") {
  return value == null || Number.isNaN(Number(value)) ? "—" : `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}${suffix}`;
}
export function formatDate(value, withDate = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ru-RU", { day: withDate ? "2-digit" : undefined, month: withDate ? "short" : undefined, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" });
}
export function formatRelative(value, now = Date.now()) {
  if (!value) return "нет данных";
  const minutes = Math.round(Math.max(0, now - new Date(value).getTime()) / 60000);
  if (minutes < 2) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  return `${Math.round(minutes / 60)} ч назад`;
}
export function statusPresentation(status) {
  const normalized = String(status || "UNKNOWN").toUpperCase();
  const tone = ["NO_INTERNET", "CRITICAL", "DOWN", "OUTAGE"].includes(normalized) ? "critical" : ["DEGRADED", "UNSTABLE", "ATTENTION", "DEVIATES"].includes(normalized) ? "unstable" : ["NO_DATA", "UNKNOWN", "STALE"].includes(normalized) ? "no-data" : "healthy";
  return { code: normalized, label: STATUS_LABELS[normalized] || "Неизвестно", tone };
}
export const humanStatus = (value) => statusPresentation(value).label;
export const humanRole = (value) => ROLE_LABELS[String(value || "").toUpperCase()] || value || "—";
export const humanIncidentStatus = (value) => INCIDENT_LABELS[String(value || "").toUpperCase()] || value || "Новый";
export const humanDeliveryStatus = (value) => DELIVERY_LABELS[String(value || "").toUpperCase()] || value || "Неизвестно";

export function presentationMaps() {
  return { statuses: STATUS_LABELS, roles: ROLE_LABELS, incidents: INCIDENT_LABELS, deliveries: DELIVERY_LABELS };
}
