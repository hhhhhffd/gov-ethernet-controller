import { createApiClient } from "./core/api.mjs";
import { createCapabilityState } from "./core/capabilities.mjs";
import { createI18n } from "./core/i18n.mjs";
import { escapeHtml, formatDate, formatNumber, humanRole, humanStatus, statusPresentation } from "./core/presentation.mjs";
import { createShellRouter } from "./core/router.mjs";
import { createSession } from "./core/session.mjs";
import { createThemeState } from "./core/theme.mjs";
import { createMapIntegration } from "./integration/map-integration.mjs";
import { createAdminBoundary } from "./features/admin.mjs";
import { createAuditBoundary } from "./features/audit.mjs";
import { createIncidentsBoundary } from "./features/incidents.mjs";
import { createLinesBoundary } from "./features/lines.mjs";
import { createNotificationsBoundary } from "./features/notifications.mjs";
import { createProviderCaseBoundary } from "./features/provider-case.mjs";
import { createReportsBoundary } from "./features/reports.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const state = { capabilities: createCapabilityState(null), mapPopupContext: null, mapPopupTrigger: null, mapLoaded: false, mapLoadPromise: null, toastTimer: null };

let session;
const api = createApiClient({
  getToken: () => session?.token || "",
  onUnauthorized: async () => { session?.clear(); showLogin("Сессия истекла. Войдите снова."); },
  onForbidden: async () => { if (session?.hasToken()) await session.bootstrap(); },
});
session = createSession({ api, onChange: handleSessionChange });
const i18n = createI18n();
const theme = createThemeState();
const reports = createReportsBoundary(api);
const map = createMapIntegration({ api, reports });
const lines = createLinesBoundary(api);
const router = createShellRouter({
  canAccess(view) {
    if (view === "admin") return state.capabilities.has("admin.manage");
    if (view === "audit") return state.capabilities.has("audit.read");
    if (view === "notifications") return state.capabilities.has("notification.read");
    return true;
  },
});
const boundaries = {
  api, session, capabilities: () => state.capabilities, map,
  lines, incidents: createIncidentsBoundary(api), reports,
  notifications: createNotificationsBoundary(api),
  providerCases: createProviderCaseBoundary(api),
  admin: createAdminBoundary(api),
  audit: createAuditBoundary(api),
};

function showLogin(message = "Введите рабочие учётные данные.") {
  const backdrop = $("#authBackdrop");
  if (!backdrop) return;
  $("#authMessage").textContent = message;
  backdrop.hidden = false;
  $("#loginUsername").value ? $("#loginPassword").focus() : $("#loginUsername").focus();
}

function hideLogin() { if ($("#authBackdrop")) $("#authBackdrop").hidden = true; }

function renderSession() {
  const authenticated = session.authenticated;
  const workspace = $("#authenticatedWorkspace");
  if (workspace) workspace.hidden = !authenticated;
  if (authenticated) hideLogin(); else showLogin();
  const user = session.user || {};
  const userName = $("#sessionUser");
  const userRole = $("#sessionRole");
  if (userName) userName.textContent = user.name || user.full_name || user.username || "—";
  if (userRole) userRole.textContent = user.role_label || humanRole(user.role);
  const status = $("#sessionStatus");
  if (status) status.textContent = authenticated ? `Сессия активна · ${userRole?.textContent || ""}` : "Требуется вход";
  document.documentElement.dataset.authenticated = authenticated ? "true" : "false";
}

function handleSessionChange(snapshot) {
  state.capabilities = createCapabilityState(snapshot.user);
  document.documentElement.dataset.capabilities = state.capabilities.capabilities.join(" ");
  renderSession();
  if (snapshot.authenticated && !state.mapLoaded) loadAuthenticatedMap();
}

function renderMapStatus() {
  const summary = map.summary();
  const registry = map.registryStatus();
  const lineCount = $("#lineCount");
  if (lineCount) lineCount.textContent = String(summary.lineCount);
  const visibleCount = $("#mapVisibleCount");
  if (visibleCount) visibleCount.textContent = String(summary.lineCount);
  const mode = $("#mapModeLabel");
  if (mode) mode.textContent = summary.modeLabel;
  const footer = $("#mapFooterNote");
  if (footer) footer.textContent = summary.mode === "historical" ? "Историческое evidence · current state не используется" : "Текущее состояние из latest LineState";
  const registryStatus = $("#registryDataStatus");
  if (registryStatus) { registryStatus.textContent = registry.text; registryStatus.dataset.state = registry.state; }
  const operationalStatus = $("#operationalStatus");
  if (operationalStatus) {
    operationalStatus.textContent = summary.status === "available" ? `${formatNumber(summary.lineCount)} линий доступны в текущем scope` : "Операционные данные недоступны";
    operationalStatus.dataset.state = summary.status;
  }
  const error = $("#mapError");
  if (error) { error.hidden = !map.state.operationalError; error.textContent = map.state.operationalError ? "Сервер мониторинга недоступен. Повторите загрузку." : ""; }
}

async function loadAuthenticatedMap() {
  if (state.mapLoadPromise) return state.mapLoadPromise;
  state.mapLoadPromise = map.loadCurrent()
    .then(() => { state.mapLoaded = true; renderMapStatus(); })
    .catch((error) => { state.mapLoaded = true; renderMapStatus(); showToast(error.status === 403 ? "Карта недоступна для текущего scope" : "Карта временно недоступна", "warn"); })
    .finally(() => { state.mapLoadPromise = null; });
  return state.mapLoadPromise;
}

function showToast(message, tone = "") {
  const region = $("#toastRegion");
  if (!region) return;
  region.replaceChildren();
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.textContent = message;
  region.appendChild(item);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => item.remove(), 4200);
}

function mapFields(fields) {
  return fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd></div>`).join("");
}

function popupSchoolName(school, line) { return school?.officialName || school?.official_name || school?.name || line?.school_name || "Школа из реестра"; }

function popupLine(line) {
  const presentation = statusPresentation(line.linkwatchStatus || line.status);
  return {
    title: popupSchoolName(line.registrySchool, line),
    fields: [["Линия", line.id], ["Провайдер", line.provider], ["Тип подключения", line.technology], ["Роль линии", humanRole(line.role)], ["Статус", presentation.label], ["Последнее наблюдение", formatDate(line.latest?.at, true)]],
  };
}

function renderPopup(context) {
  const popup = $("#mapPopup");
  const openLineButton = $("#mapPopupOpenLine");
  const fields = $("#mapPopupFields");
  if (!popup || !fields) return;
  const school = context.school;
  let title = context.label || popupSchoolName(school, context.lines?.[0]);
  let summary = "";
  openLineButton.hidden = true;
  if (context.kind === "registry-cluster") {
    title = `${context.count} школ в группе`;
    summary = "Реестр школ · выберите школу для просмотра официальных данных";
    fields.innerHTML = `<div><dt>Школы</dt><dd>${context.members.map((member) => `<button type="button" class="map-member" data-popup-registry-id="${escapeHtml(member.registryId)}">${escapeHtml(popupSchoolName(member.school))}</button>`).join("")}</dd></div>`;
  } else if (context.kind === "registry") {
    title = popupSchoolName(school);
    summary = "Официальная запись реестра";
    fields.innerHTML = mapFields([["Район", school?.district], ["Адрес", school?.address], ["Источник координат", school?.coordinateSource], ["Статус мониторинга", i18n.t("notMonitored")]]);
  } else {
    const lines = context.lines || [];
    const selected = lines[0];
    const content = popupLine(selected || {});
    title = content.title;
    summary = context.mode === "historical" ? "Историческое evidence · current state не используется" : "Текущее состояние из latest LineState";
    fields.innerHTML = (lines.length > 1 ? `<div><dt>Линии школы</dt><dd>${lines.map((line) => `<button type="button" class="map-member" data-popup-line-id="${escapeHtml(line.id)}">${escapeHtml(line.id)} · ${escapeHtml(humanStatus(line.linkwatchStatus || line.status))}</button>`).join("")}</dd></div>` : "") + mapFields(content.fields);
    openLineButton.hidden = !selected;
    openLineButton.dataset.lineId = selected?.id || "";
  }
  $("#mapPopupTitle").textContent = title;
  $("#mapPopupSummary").textContent = summary;
  popup.hidden = false;
  popup.classList.remove("hidden");
  popup.querySelectorAll("[data-popup-registry-id]").forEach((button) => button.addEventListener("click", () => {
    const member = context.members.find((item) => item.registryId === button.dataset.popupRegistryId);
    if (member) openMapPopup(member);
  }));
  popup.querySelectorAll("[data-popup-line-id]").forEach((button) => button.addEventListener("click", () => {
    const line = context.lines.find((item) => item.id === button.dataset.popupLineId);
    if (line) { context.lines = [line]; renderPopup(context); }
  }));
}

function openMapPopup(context, trigger = null) { state.mapPopupContext = context; state.mapPopupTrigger = trigger; renderPopup(context); }

function closeMapPopup(restoreFocus = true) {
  const popup = $("#mapPopup");
  if (!popup) return;
  popup.hidden = true;
  popup.classList.add("hidden");
  if (restoreFocus) state.mapPopupTrigger?.getElement?.()?.focus?.();
  state.mapPopupContext = null;
  state.mapPopupTrigger = null;
}

async function openLine(id) {
  const localLine = map.getLine(id);
  let line = localLine;
  try {
    const response = await lines.get(id);
    line = { ...localLine, ...(response?.data || response) };
  } catch (error) {
    if (![404, 403].includes(error.status)) showToast("Детали линии временно недоступны", "warn");
  }
  if (!line) return;
  const drawer = $("#detailDrawer");
  if (!drawer) return;
  $("#drawerTitle").textContent = line.school_name || line.id;
  $("#drawerSubtitle").textContent = `${line.id} · ${humanRole(line.role)} · ${line.provider || "—"}`;
  $("#drawerStatus").innerHTML = `<span class="status-badge ${escapeHtml(statusPresentation(line.status).tone)}">${escapeHtml(humanStatus(line.status))}</span><p>${escapeHtml(line.reason || "Состояние получено от backend LineState.")}</p>`;
  $("#drawerContext").innerHTML = mapFields([["Линия", line.id], ["Школа", line.school_name], ["Район", line.district], ["Провайдер", line.provider], ["Тип подключения", line.technology], ["Последнее наблюдение", formatDate(line.latest?.at, true)]]);
  $("#drawerMetrics").innerHTML = mapFields([["Download", formatNumber(line.latest?.download, " Мбит/с")], ["Upload", formatNumber(line.latest?.upload, " Мбит/с")], ["Ping", formatNumber(line.latest?.ping, " мс")]]);
  $("#drawerBackdrop").hidden = false;
  drawer.hidden = false;
  drawer.classList.add("open");
}

function closeDrawer() {
  $("#detailDrawer")?.classList.remove("open");
  if ($("#detailDrawer")) $("#detailDrawer").hidden = true;
  if ($("#drawerBackdrop")) $("#drawerBackdrop").hidden = true;
}

async function refreshMap() {
  if (!session.authenticated) return;
  state.mapLoaded = false;
  state.mapLoadPromise = null;
  await loadAuthenticatedMap();
}

function bindEvents() {
  $("#loginForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("#loginSubmit");
    submit.disabled = true;
    $("#authMessage").textContent = "Проверяем учётные данные…";
    try { await session.login({ username: $("#loginUsername").value.trim(), password: $("#loginPassword").value }); }
    catch (error) { showLogin(error.status === 401 ? "Не удалось войти. Проверьте имя пользователя и пароль." : "Сервис авторизации пока недоступен."); }
    finally { submit.disabled = false; }
  });
  $("#logoutButton")?.addEventListener("click", async () => { try { await session.logout(); } catch (_) { showToast("Сеанс не удалось завершить на сервере", "warn"); session.clear(); } });
  $("#refreshButton")?.addEventListener("click", refreshMap);
  $("#mapListMode")?.addEventListener("change", async (event) => {
    const mode = event.target.value === "historical" ? "historical" : "current";
    if (mode === "current") map.setMode(mode);
    else { try { await map.loadHistorical("period=week"); } catch (_) { showToast("Исторические данные недоступны", "warn"); } }
    renderMapStatus();
  });
  $("#coverageFilter")?.addEventListener("change", (event) => { map.setCoverage(event.target.value); renderMapStatus(); });
  $("#mapPopupClose")?.addEventListener("click", () => closeMapPopup());
  $("#mapPopupOpenLine")?.addEventListener("click", () => openLine($("#mapPopupOpenLine").dataset.lineId));
  $("#drawerClose")?.addEventListener("click", closeDrawer);
  $("#drawerBackdrop")?.addEventListener("click", closeDrawer);
  $("#mapZoomIn")?.addEventListener("click", () => mapApiAction("zoomIn"));
  $("#mapZoomOut")?.addEventListener("click", () => mapApiAction("zoomOut"));
  $("#mapReset")?.addEventListener("click", () => globalThis.LinkwatchMap?.resetView());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("#mapPopup")?.hidden) closeMapPopup(); else if (!$("#detailDrawer")?.hidden) closeDrawer(); } });
  globalThis.LinkwatchMap?.setMarkerClickHandler((context, marker) => openMapPopup(context, marker));
}

function mapApiAction(action) {
  const currentMap = globalThis.LinkwatchMap?.getMap();
  if (currentMap?.[action]) currentMap[action]();
}

async function boot() {
  map.init({ containerId: "leafletMap" });
  bindEvents();
  renderSession();
  if (!session.hasToken()) return;
  try { await session.bootstrap(); } catch (_) { showLogin("Сессия недействительна. Войдите снова."); }
}

globalThis.LinkwatchApp = { i18n, theme, router, state, boundaries, refreshMap, openLine, openMapPopup };
document.addEventListener("DOMContentLoaded", boot);
