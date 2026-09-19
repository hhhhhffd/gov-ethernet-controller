import { createApiClient } from "./core/api.mjs";
import { createCapabilityState } from "./core/capabilities.mjs";
import { createI18n } from "./core/i18n.mjs";
import { createPresentation, escapeHtml } from "./core/presentation.mjs";
import { createShellRouter } from "./core/router.mjs";
import { createSession } from "./core/session.mjs";
import { createMapPresentationAdapter } from "./core/map-presentation.mjs";
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
const state = { capabilities: createCapabilityState(null), mapPopupContext: null, mapPopupTrigger: null, mapInitialized: false, mapLoaded: false, mapLoadPromise: null, toastTimer: null, currentLine: null };

let session;
const i18n = createI18n();
const presentation = createPresentation(i18n);
const api = createApiClient({
  getToken: () => session?.token || "",
  onUnauthorized: async () => { session?.clear(); showLogin("auth.sessionExpired"); },
  onForbidden: async () => { if (session?.hasToken()) await session.bootstrap(); },
});
session = createSession({ api, onChange: handleSessionChange });
const theme = createThemeState();
const mapPresentationAdapter = createMapPresentationAdapter({ theme: theme.theme, locale: i18n.locale });
const reports = createReportsBoundary(api);
const map = createMapIntegration({ api, reports, presentation, mapPresentation: mapPresentationAdapter.snapshot() });
const lines = createLinesBoundary(api);
const router = createShellRouter({
  canAccess(view) {
    if (view === "incidents") return state.capabilities.canRead("incident");
    if (view === "reports") return state.capabilities.canRead("report");
    if (view === "admin") return state.capabilities.has("admin.manage");
    if (view === "audit") return state.capabilities.has("audit.read");
    if (view === "notifications") return state.capabilities.has("notification.read");
    return true;
  },
  onChange: renderRoute,
});
const boundaries = {
  api, session, capabilities: () => state.capabilities, map, lines,
  incidents: createIncidentsBoundary(api), reports, notifications: createNotificationsBoundary(api),
  providerCases: createProviderCaseBoundary(api), admin: createAdminBoundary(api), audit: createAuditBoundary(api),
};

function localizeStaticContent() {
  document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = i18n.t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", i18n.t(element.dataset.i18nAriaLabel)); });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.setAttribute("title", i18n.t(element.dataset.i18nTitle)); });
  document.querySelectorAll("[data-locale]").forEach((control) => {
    const active = control.dataset.locale === i18n.locale;
    control.toggleAttribute("aria-pressed", active);
    control.setAttribute("aria-label", i18n.t("locale.switch"));
  });
  renderThemeControl();
}

function renderThemeControl() {
  const control = $("#themeToggle");
  if (!control) return;
  const switchTo = theme.theme === "dark" ? "light" : "dark";
  const key = "theme.switchTo" + (switchTo === "light" ? "Light" : "Dark");
  control.textContent = switchTo === "light" ? "☼" : "☾";
  control.dataset.theme = theme.theme;
  control.setAttribute("aria-label", i18n.t(key));
  control.setAttribute("title", i18n.t(key));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.theme === "light" ? "#eef0ee" : "#08131f");
}

function refreshTheme() {
  mapPresentationAdapter.setTheme(theme.theme);
  mapPresentationAdapter.setLocale(i18n.locale);
  map.setMapPresentation(mapPresentationAdapter.snapshot());
  renderThemeControl();
}

function showLogin(messageKey = "auth.enterCredentials", resolving = false) {
  const backdrop = $("#authBackdrop");
  if (!backdrop) return;
  $("#authMessage").textContent = i18n.t(messageKey);
  $("#loginUsername").disabled = resolving;
  $("#loginPassword").disabled = resolving;
  $("#loginSubmit").disabled = resolving;
  backdrop.hidden = false;
  if (!resolving) ($("#loginUsername").value ? $("#loginPassword") : $("#loginUsername")).focus();
}

function hideLogin() {
  if ($("#authBackdrop")) $("#authBackdrop").hidden = true;
  $("#loginUsername").disabled = false;
  $("#loginPassword").disabled = false;
  $("#loginSubmit").disabled = false;
}

function renderRoute(snapshot = router.getState()) {
  const workspace = $("#authenticatedWorkspace");
  if (workspace) workspace.dataset.route = snapshot.view;
  document.documentElement.dataset.route = snapshot.view;
  document.querySelectorAll("[data-route]").forEach((button) => {
    const active = button.dataset.route === snapshot.view;
    button.toggleAttribute("aria-current", active);
    if (!active) button.removeAttribute("aria-current");
  });
  const liveStatus = $("#mapLiveStatus");
  if (liveStatus) liveStatus.textContent = i18n.t("map.openSection", { section: i18n.t("nav." + snapshot.view) });
  const hash = snapshot.view === "map" ? "" : "#" + snapshot.view;
  if (globalThis.location && globalThis.location.hash !== hash) globalThis.history?.replaceState?.({}, "", globalThis.location.pathname + hash);
}

function renderPrimaryNav() {
  const destinations = { map: true, incidents: state.capabilities.canRead("incident"), reports: state.capabilities.canRead("report") };
  document.querySelectorAll("#primaryNav [data-route]").forEach((button) => { button.hidden = !destinations[button.dataset.route]; });
  document.querySelectorAll("[data-capability]").forEach((control) => { control.hidden = !state.capabilities.has(control.dataset.capability); });
  const current = router.getState().view;
  if (!destinations[current]) router.navigate("map");
  else renderRoute();
}

function renderSession(snapshot = session.getState()) {
  const authenticated = snapshot.authenticated;
  const workspace = $("#authenticatedWorkspace");
  if (workspace) workspace.hidden = !authenticated;
  if (authenticated) hideLogin();
  else if (snapshot.resolving) showLogin("auth.checkingSession", true);
  else showLogin();
  const user = session.user || {};
  const userName = $("#sessionUser");
  const userRole = $("#sessionRole");
  if (userName) userName.textContent = user.name || user.full_name || user.username || presentation.empty();
  if (userRole) userRole.textContent = presentation.userRole(user.role);
  document.documentElement.dataset.authenticated = authenticated ? "true" : "false";
}

function handleSessionChange(snapshot) {
  state.capabilities = createCapabilityState(snapshot.user);
  document.documentElement.dataset.capabilities = state.capabilities.capabilities.join(" ");
  if (!snapshot.authenticated) { state.mapLoaded = false; state.mapLoadPromise = null; state.currentLine = null; }
  renderSession(snapshot);
  renderPrimaryNav();
  if (snapshot.authenticated) initializeAuthenticatedWorkspace();
}

function renderMapStatus() {
  const summary = map.summary();
  const registry = map.registryStatus();
  if ($("#lineCount")) $("#lineCount").textContent = String(summary.lineCount);
  if ($("#mapVisibleCount")) $("#mapVisibleCount").textContent = String(summary.lineCount);
  if ($("#mapModeLabel")) $("#mapModeLabel").textContent = summary.modeLabel;
  if ($("#mapFooterNote")) $("#mapFooterNote").textContent = summary.mode === "historical" ? i18n.t("map.historicalSource") : i18n.t("map.currentSource");
  if ($("#registryDataStatus")) { $("#registryDataStatus").textContent = registry.text; $("#registryDataStatus").dataset.state = registry.state; }
  if ($("#operationalStatus")) {
    $("#operationalStatus").textContent = summary.status === "available" ? i18n.t("map.monitoringAvailable", { count: summary.lineCount }) : i18n.t("map.operationalUnavailable");
    $("#operationalStatus").dataset.state = summary.status;
  }
  if ($("#mapError")) { $("#mapError").hidden = !map.state.operationalError; $("#mapError").textContent = map.state.operationalError ? i18n.t("map.serverUnavailable") : ""; }
}

async function loadAuthenticatedMap() {
  if (state.mapLoadPromise) return state.mapLoadPromise;
  state.mapLoadPromise = map.loadCurrent()
    .then(() => { state.mapLoaded = true; renderMapStatus(); })
    .catch((error) => { state.mapLoaded = true; renderMapStatus(); showToast(error.status === 403 ? "map.forbidden" : "map.temporarilyUnavailable", "warn"); })
    .finally(() => { state.mapLoadPromise = null; });
  return state.mapLoadPromise;
}

function initializeAuthenticatedWorkspace() {
  if (!session.authenticated || state.mapInitialized) {
    if (session.authenticated && !state.mapLoaded) loadAuthenticatedMap();
    return;
  }
  map.init({ containerId: "leafletMap" });
  state.mapInitialized = true;
  loadAuthenticatedMap();
}

function showToast(messageKey, tone = "") {
  const region = $("#toastRegion");
  if (!region) return;
  region.replaceChildren();
  const item = document.createElement("div");
  item.className = "toast " + tone;
  item.textContent = i18n.t(messageKey);
  region.appendChild(item);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => item.remove(), 4200);
}

function mapFields(fields) {
  return fields.map(([label, value]) => "<div><dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(value ?? presentation.empty()) + "</dd></div>").join("");
}
function popupSchoolName(school, line) { return presentation.schoolName(school, line?.school_name); }
function popupLine(line) {
  const status = presentation.status(line.linkwatchStatus || line.status);
  return {
    title: popupSchoolName(line.registrySchool, line),
    fields: [
      [i18n.t("field.line"), line.id], [i18n.t("field.provider"), line.provider],
      [i18n.t("field.connectionType"), presentation.connectionType(line.technology)],
      [i18n.t("field.lineRole"), presentation.role(line.role)], [i18n.t("field.status"), status.label],
      [i18n.t("field.lastObserved"), presentation.formatDate(line.latest?.at, true)],
    ],
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
    title = i18n.t("map.clusterTitle", { count: context.count });
    summary = i18n.t("map.clusterSummary");
    fields.innerHTML = "<div><dt>" + escapeHtml(i18n.t("field.schools")) + "</dt><dd>" + context.members.map((member) => '<button type="button" class="map-member" data-popup-registry-id="' + escapeHtml(member.registryId) + '">' + escapeHtml(popupSchoolName(member.school)) + "</button>").join("") + "</dd></div>";
  } else if (context.kind === "registry") {
    title = popupSchoolName(school);
    summary = i18n.t("map.registrySummary");
    fields.innerHTML = mapFields([[i18n.t("field.district"), school?.district], [i18n.t("field.address"), school?.address], [i18n.t("field.coordinateSource"), presentation.coordinateSource(school?.coordinateSource)], [i18n.t("field.monitoringStatus"), presentation.status("NOT_MONITORED").label]]);
  } else {
    const linesAtSchool = context.lines || [];
    const selected = linesAtSchool[0];
    const content = popupLine(selected || {});
    title = content.title;
    summary = context.mode === "historical" ? i18n.t("map.historicalSource") : i18n.t("map.currentSource");
    const selector = linesAtSchool.length > 1
      ? "<div><dt>" + escapeHtml(i18n.t("field.lines")) + "</dt><dd>" + linesAtSchool.map((line) => '<button type="button" class="map-member" data-popup-line-id="' + escapeHtml(line.id) + '">' + escapeHtml(line.id) + " · " + escapeHtml(presentation.status(line.linkwatchStatus || line.status).label) + "</button>").join("") + "</dd></div>"
      : "";
    fields.innerHTML = selector + mapFields(content.fields);
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

function renderLineDrawer(line) {
  if (!line || !$("#detailDrawer")) return;
  state.currentLine = line;
  $("#drawerTitle").textContent = popupSchoolName(line.registrySchool, line) || line.id;
  $("#drawerSubtitle").textContent = [line.id, presentation.role(line.role), line.provider || presentation.empty()].join(" · ");
  const status = presentation.status(line.status);
  $("#drawerStatus").innerHTML = '<span class="status-badge ' + escapeHtml(status.tone) + '">' + escapeHtml(status.label) + "</span><p>" + escapeHtml(i18n.t("reason.lineState")) + "</p>";
  $("#drawerContext").innerHTML = mapFields([[i18n.t("field.line"), line.id], [i18n.t("field.school"), popupSchoolName(line.registrySchool, line)], [i18n.t("field.district"), line.district], [i18n.t("field.provider"), line.provider], [i18n.t("field.connectionType"), presentation.connectionType(line.technology)], [i18n.t("field.lastObserved"), presentation.formatDate(line.latest?.at, true)]]);
  $("#drawerMetrics").innerHTML = mapFields([[i18n.t("field.download"), presentation.formatNumber(line.latest?.download, i18n.t("unit.mbps"))], [i18n.t("field.upload"), presentation.formatNumber(line.latest?.upload, i18n.t("unit.mbps"))], [i18n.t("field.ping"), presentation.formatNumber(line.latest?.ping, i18n.t("unit.ms"))]]);
  $("#drawerBackdrop").hidden = false;
  $("#detailDrawer").hidden = false;
  $("#detailDrawer").classList.add("open");
}

async function openLine(id) {
  let line = map.getLine(id);
  try {
    const response = await lines.get(id);
    line = { ...line, ...(response?.data || response) };
  } catch (error) {
    if (![404, 403].includes(error.status)) showToast("map.lineDetailsUnavailable", "warn");
  }
  if (line) renderLineDrawer(line);
}
function closeDrawer() {
  $("#detailDrawer")?.classList.remove("open");
  if ($("#detailDrawer")) $("#detailDrawer").hidden = true;
  if ($("#drawerBackdrop")) $("#drawerBackdrop").hidden = true;
  state.currentLine = null;
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
    $("#authMessage").textContent = i18n.t("auth.checkingCredentials");
    try { await session.login({ username: $("#loginUsername").value.trim(), password: $("#loginPassword").value }); }
    catch (error) { showLogin(error.status === 401 ? "auth.invalidCredentials" : "auth.serviceUnavailable"); }
    finally { submit.disabled = false; }
  });
  $("#logoutButton")?.addEventListener("click", async () => { try { await session.logout(); } catch (error) { showToast("error.unknown", "warn"); } });
  $("#themeToggle")?.addEventListener("click", () => theme.toggle());
  $("#refreshButton")?.addEventListener("click", refreshMap);
  $("#mapFilter")?.addEventListener("submit", (event) => event.preventDefault());
  document.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", () => {
    if (router.navigate(button.dataset.route)) $("#accountControl")?.removeAttribute("open");
  }));
  document.querySelectorAll("[data-locale]").forEach((button) => button.addEventListener("click", () => i18n.setLocale(button.dataset.locale)));
  $("#mapListMode")?.addEventListener("change", async (event) => {
    const mode = event.target.value === "historical" ? "historical" : "current";
    if (mode === "current") map.setMode(mode);
    else { try { await map.loadHistorical("period=week"); } catch (error) { showToast("map.historicalUnavailable", "warn"); } }
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

function refreshLocale() {
  localizeStaticContent();
  mapPresentationAdapter.setLocale(i18n.locale);
  map.setMapPresentation(mapPresentationAdapter.snapshot());
  map.setPresentation(presentation);
  renderRoute();
  renderSession();
  renderMapStatus();
  if (state.mapPopupContext) renderPopup(state.mapPopupContext);
  if (state.currentLine) renderLineDrawer(state.currentLine);
}

async function boot() {
  localizeStaticContent();
  bindEvents();
  i18n.subscribe(refreshLocale);
  theme.subscribe(refreshTheme);
  renderSession();
  if (!session.hasToken()) return;
  try {
    await session.bootstrap();
    const requestedRoute = globalThis.location?.hash?.slice(1);
    if (requestedRoute) router.navigate(requestedRoute);
  } catch (error) {
    showLogin(error.status === 401 || error.status === 403 ? "auth.invalidSession" : "auth.serviceUnavailable");
  }
}

globalThis.LinkwatchApp = { i18n, presentation, theme, router, state, boundaries, refreshMap, openLine, openMapPopup };
document.addEventListener("DOMContentLoaded", boot);
