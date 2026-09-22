import { createApiClient } from "./core/api.mjs";
import { createCapabilityState } from "./core/capabilities.mjs";
import { createI18n } from "./core/i18n.mjs";
import { hydrateIcons, iconMarkup } from "./core/icons.mjs";
import { createPresentation, escapeHtml } from "./core/presentation.mjs";
import { createShellRouter } from "./core/router.mjs";
import { createSession } from "./core/session.mjs";
import { createMapPresentationAdapter } from "./core/map-presentation.mjs";
import { createThemeState } from "./core/theme.mjs";
import { createMapIntegration } from "./integration/map-integration.mjs";
import { createAdminBoundary, writableAdminPayload } from "./features/admin.mjs";
import { createAuditBoundary } from "./features/audit.mjs";
import { createIncidentsBoundary } from "./features/incidents.mjs";
import { createLinesBoundary } from "./features/lines.mjs";
import { createNotificationsBoundary, NOTIFICATION_POLL_INTERVAL_MS, notificationKey, notificationSeenStorageKey, notificationIsServerRead, notificationSummary, readNotificationSeenIDs, writeNotificationSeenIDs } from "./features/notifications.mjs";
import { createProviderCaseBoundary } from "./features/provider-case.mjs";
import { createReportsBoundary } from "./features/reports.mjs";
import { defaultReportFilters, reportAvailability as formatReportAvailability, reportContextFilters, reportEvidenceSummary, reportFilterOptions, reportQuery, reportState } from "./features/reports-presentation.mjs";
import { filterIncidents, incidentActions, incidentSeverityValues, incidentStatusValues, presentIncident, presentRecovery, presentSituation, presentTimeline, relatedSituations, situationActions } from "./features/incidents-presentation.mjs";
import { presentProviderCase, providerCaseActions, providerCaseDeliveryRequest } from "./features/provider-case-presentation.mjs";
import { activeIncident, availableMetrics, createSelectedSchool, mergeLineDetail, selectedLine, selectSchoolLine } from "./features/school-detail.mjs";
import { adminResourceDefinitions, presentAdminRecord, presentAgentVersion, presentAuditItem, presentNotification } from "./features/secondary-presentation.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const OPERATIONAL_POLL_INTERVAL_MS = 5_000;
const state = {
  capabilities: createCapabilityState(null), mapPopupContext: null, mapPopupTrigger: null, mapPopupAnchor: null, selectedSchool: null, enrollment: { open: false, state: "idle", pointID: "", lineID: "", result: null },
  mapInitialized: false, mapLoaded: false, mapLoadPromise: null, operationalPollTimer: null, toastTimer: null, drawerTrigger: null, drawerFocusSet: false, drawerRequestID: 0, drawerTab: "summary", schoolDetailStates: { lineID: "", state: "idle", items: [] },
  notificationsTrigger: null, searchActiveIndex: -1,
  incidents: createIncidentSurfaceState(),
  reports: createReportsSurfaceState(),
  notifications: createNotificationsSurfaceState(),
  admin: createAdminSurfaceState(),
  audit: createAuditSurfaceState(),
};

const INCIDENT_STATUS_OPTIONS = Object.freeze(["NEW", "SENT_TO_PROVIDER", "IN_PROGRESS", "WAITING_INFO", "RESOLVED"]);
const ACTION_COPY = Object.freeze({
  ru: Object.freeze({
    incidentProviderFixed: "Отметить устранение",
    incidentSendToProvider: "Передать провайдеру",
    incidentAssign: "Назначить ответственного",
    incidentStatus: "Изменить статус",
    situationLiveVerify: "Запросить проверку сейчас",
    situationReason: "Причина изменения",
    situationMergeTargets: "Ситуации для объединения",
    situationSplitMembers: "Инциденты для новой ситуации",
    notificationDispatch: "Отправить уведомление",
    confirmIncidentProviderFixed: "Отметить, что провайдер сообщил об устранении инцидента?",
    confirmIncidentSendToProvider: "Передать этот инцидент провайдеру?",
    confirmIncidentAssign: "Назначить указанного ответственного за инцидент?",
    confirmIncidentStatus: "Изменить статус инцидента?",
    confirmSituationLiveVerify: "Запросить ограниченную проверку участников ситуации сейчас?",
    confirmSituationMerge: "Объединить выбранные ситуации в новую корреляцию?",
    confirmSituationSplit: "Разделить выбранные инциденты на отдельные корреляции?",
    confirmNotificationDispatch: "Отправить это уведомление повторно?",
  }),
  kk: Object.freeze({
    incidentProviderFixed: "Жойылғанын белгілеу",
    incidentSendToProvider: "Провайдерге жіберу",
    incidentAssign: "Жауаптыны тағайындау",
    incidentStatus: "Күйін өзгерту",
    situationLiveVerify: "Қазір тексеруді сұрау",
    situationReason: "Өзгерту себебі",
    situationMergeTargets: "Біріктірілетін жағдайлар",
    situationSplitMembers: "Жаңа жағдайға бөлінетін оқиғалар",
    notificationDispatch: "Хабарламаны жіберу",
    confirmIncidentProviderFixed: "Провайдер оқиғаны жойғанын хабарлағанын белгілеу керек пе?",
    confirmIncidentSendToProvider: "Осы оқиғаны провайдерге жіберу керек пе?",
    confirmIncidentAssign: "Көрсетілген жауаптыны оқиғаға тағайындау керек пе?",
    confirmIncidentStatus: "Оқиға күйін өзгерту керек пе?",
    confirmSituationLiveVerify: "Жағдайға қатысушыларды қазір шектеулі тексеруді сұрау керек пе?",
    confirmSituationMerge: "Таңдалған жағдайларды жаңа корреляцияға біріктіру керек пе?",
    confirmSituationSplit: "Таңдалған оқиғаларды бөлек корреляцияларға бөлу керек пе?",
    confirmNotificationDispatch: "Осы хабарламаны қайта жіберу керек пе?",
  }),
});

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
const map = createMapIntegration({ api, reports, session, presentation, mapPresentation: mapPresentationAdapter.snapshot() });
const lines = createLinesBoundary(api);
const router = createShellRouter({
  canAccess(view) {
    if (view === "incidents") return state.capabilities.canRead("incident");
    if (view === "situations") return state.capabilities.canRead("incident");
    if (view === "cases") return state.capabilities.canAny(["provider_case.draft", "provider_case.send"]);
    if (view === "reports") return state.capabilities.canRead("report");
    if (view === "admin") return state.capabilities.has("admin.manage");
    if (view === "audit") return state.capabilities.has("audit.read");
    return true;
  },
  onChange: renderRoute,
});
const boundaries = {
  api, session, capabilities: () => state.capabilities, map, lines,
  incidents: createIncidentsBoundary(api), reports, notifications: createNotificationsBoundary(api),
  providerCases: createProviderCaseBoundary(api), admin: createAdminBoundary(api), audit: createAuditBoundary(api),
};

function createIncidentSurfaceState() {
  return {
    state: "idle", items: [], filters: { status: "", severity: "" }, selectedId: null, detail: null, detailState: "idle",
    situations: [], situationsState: "idle", selectedSituationId: null, situation: null, situationState: "idle", situationComparison: null, comparisonState: "idle",
    actionState: "idle", actionError: "", actionMessage: "", commentState: "idle", commentMessage: "", situationActionState: "idle", situationActionError: "", situationActionMessage: "",
    createOpen: false, createState: "idle", createError: "", createDraft: { line_id: "", violation_type: "MANUAL_REVIEW", description: "", assignee: "" },
    providerCase: { selectedId: null, state: "idle", detail: null, actionState: "idle", actionError: "", actionMessage: "", generated: null }, caseFilters: { search: "", school: "", status: "", provider: "" }, caseCreateOpen: false, caseCreateState: "idle", caseCreateError: "", caseCreateDraft: { line_id: "", comment: "" }, situationSearch: "",
    cases: [], casesState: "idle", casesLoadPromise: null,
  };
}

function createReportsSurfaceState() {
  return {
    state: "idle", reportType: "aggregate", filters: defaultReportFilters(), aggregate: null, analytics: null, passport: null,
    aggregateState: "idle", analyticsState: "idle", passportState: "idle", preview: null, previewState: "idle", loadPromise: null,
  };
}

function createNotificationsSurfaceState() {
  return {
    open: false, state: "idle", items: [], selectedId: null, filterStatus: "", loadPromise: null, actionId: null, actionState: "idle", actionError: "", actionErrorId: null,
    seenIDs: new Set(), knownIDs: new Set(), baselineInitialized: false, storageKey: "", pollTimer: null,
  };
}

function createAdminSurfaceState() {
  return { state: "idle", resource: "organizations", items: [], relationships: { organizations: [], providers: [], lines: [], "monitoring-points": [] }, selectedId: "", editorIntent: "create", draftID: "", payload: "{}", search: "", mutationState: "idle", message: "", onboardingRegistryId: "", onboarding: createAdminOnboardingState(), loadPromise: null, preview: null, credential: null, demoAction: "idle", demoError: "" };
}

function createAdminOnboardingState() {
  return { active: false, school: null, state: "idle", step: "", error: "", result: null };
}

function createAuditSurfaceState() {
  return { state: "idle", tab: "log", items: [], filters: { action: "", object_type: "" }, search: "", nextBeforeId: "", hasMore: false, loadingMore: false, loadMoreError: "", selectedId: "", versionsState: "idle", versions: [], selectedVersion: "", devicesState: "idle", devices: [], loadPromise: null };
}

function actionCopy(key) {
  return ACTION_COPY[i18n.locale]?.[key] || ACTION_COPY.ru[key] || key;
}

function errorMessageKey(error) {
  const status = Number(error?.status);
  const key = Number.isInteger(status) ? `error.${status}` : "error.unknown";
  return i18n.has(key) ? key : "error.unknown";
}

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (error) {
    return null;
  }
}

function notificationIdentity(user = session?.user) {
  return user?.id || user?.username || user?.name || "anonymous";
}

function hydrateNotificationState(user = session?.user) {
  const view = state.notifications;
  const storageKey = notificationSeenStorageKey(notificationIdentity(user));
  if (view.storageKey !== storageKey) {
    view.storageKey = storageKey;
    view.seenIDs = readNotificationSeenIDs(browserStorage(), storageKey);
    view.knownIDs = new Set();
    view.baselineInitialized = false;
    view.items = [];
    view.state = "idle";
  }
}

function markNotificationsSeen(items = state.notifications.items) {
  const view = state.notifications;
  const ids = (Array.isArray(items) ? items : []).map(notificationKey).filter(Boolean);
  if (!ids.length) return;
  ids.forEach((id) => view.seenIDs.add(id));
  writeNotificationSeenIDs(browserStorage(), view.storageKey, view.seenIDs);
  renderNotificationButton();
}

function stopNotificationPolling() {
  const view = state.notifications;
  if (view.pollTimer !== null) globalThis.clearInterval?.(view.pollTimer);
  view.pollTimer = null;
}

function stopOperationalPolling() {
  if (state.operationalPollTimer !== null) globalThis.clearInterval?.(state.operationalPollTimer);
  state.operationalPollTimer = null;
}

function startOperationalPolling() {
  stopOperationalPolling();
  if (!session?.authenticated || typeof globalThis.setInterval !== "function") return;
  state.operationalPollTimer = globalThis.setInterval(() => { void refreshOperationalWorkspace(); }, OPERATIONAL_POLL_INTERVAL_MS);
}

function startNotificationPolling() {
  stopNotificationPolling();
  if (!session?.authenticated || !state.capabilities.has("notification.read")) return;
  const interval = globalThis.setInterval;
  if (typeof interval !== "function") return;
  state.notifications.pollTimer = interval(() => {
    if (session?.authenticated && state.capabilities.has("notification.read")) void loadNotifications({ force: true, background: true });
  }, NOTIFICATION_POLL_INTERVAL_MS);
}

function confirmAction(key) {
  return globalThis.confirm?.(actionCopy(key)) === true;
}

function localizeStaticContent() {
  document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = i18n.t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", i18n.t(element.dataset.i18nAriaLabel)); });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.setAttribute("title", i18n.t(element.dataset.i18nTitle)); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => { element.setAttribute("placeholder", i18n.t(element.dataset.i18nPlaceholder)); });
  document.querySelectorAll("[data-locale]").forEach((control) => {
    const active = control.dataset.locale === i18n.locale;
    control.toggleAttribute("aria-pressed", active);
    control.setAttribute("aria-label", `${i18n.t("locale.switch")}: ${i18n.t(control.dataset.locale === "kk" ? "locale.kk" : "locale.ru")}`);
    control.setAttribute("title", i18n.t(control.dataset.locale === "kk" ? "locale.kk" : "locale.ru"));
  });
  hydrateIcons();
  renderThemeControl();
}

function hydrateRenderedControls(root) {
  if (!root) return;
  hydrateIcons(root);
  root.querySelectorAll(".icon-close").forEach((control) => {
    if (!control.querySelector("svg")) control.replaceChildren();
    if (!control.querySelector("svg")) control.insertAdjacentHTML("beforeend", iconMarkup("x", { size: 18 }));
  });
}

function renderThemeControl() {
  const control = $("#themeToggle");
  if (!control) return;
  control.hidden = false;
  control.removeAttribute("aria-hidden");
  control.tabIndex = 0;
  control.dataset.theme = theme.theme;
  control.replaceChildren();
  const nextTheme = theme.theme === "dark" ? "light" : "dark";
  control.insertAdjacentHTML("beforeend", iconMarkup(nextTheme === "dark" ? "moon" : "sun", { size: 18 }));
  control.setAttribute("aria-label", i18n.t(nextTheme === "dark" ? "theme.switchToDark" : "theme.switchToLight"));
  control.setAttribute("title", i18n.t(nextTheme === "dark" ? "theme.switchToDark" : "theme.switchToLight"));
  document.documentElement.dataset.theme = theme.theme;
  document.querySelector("meta[name=\"theme-color\"]")?.setAttribute("content", theme.theme === "dark" ? "rgb(23 26 27)" : "rgb(241 243 242)");
}

function refreshTheme() {
  mapPresentationAdapter.setTheme(theme.theme);
  mapPresentationAdapter.setLocale(i18n.locale);
  map.setMapPresentation(mapPresentationAdapter.snapshot());
  renderThemeControl();
}

function applyReducedMotionToMap() {
  const mapInstance = globalThis.LinkwatchMap?.getMap?.();
  if (!mapInstance?.options) return;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  mapInstance.options.zoomAnimation = !reduced;
  mapInstance.options.fadeAnimation = !reduced;
  mapInstance.options.markerZoomAnimation = !reduced;
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
  const routeTitle = $("#workspaceRouteTitle");
  if (routeTitle) routeTitle.textContent = i18n.t("nav." + snapshot.view);
  document.querySelectorAll("[data-route]").forEach((button) => {
    const active = button.dataset.route === snapshot.view;
    if (active) button.setAttribute("aria-current", "page");
    if (!active) button.removeAttribute("aria-current");
  });
  const liveStatus = $("#mapLiveStatus");
  if (liveStatus) liveStatus.textContent = i18n.t("map.openSection", { section: i18n.t("nav." + snapshot.view) });
  const refresh = $("#refreshButton");
  if (refresh) refresh.hidden = snapshot.view !== "map";
  if (snapshot.view !== "map") {
    closeDrawer(false);
    closeMapPopup(false);
  }
  if (["incidents", "situations"].includes(snapshot.view)) loadIncidents();
  if (snapshot.view === "reports") loadReports();
  if (snapshot.view === "cases") loadProviderCases();
  if (snapshot.view === "admin") loadAdminResource();
  if (snapshot.view === "audit") loadAuditLog();
  renderIncidentsPreservingScroll();
  renderReportsSurface();
  renderNotificationsSurface();
  renderAdminSurface();
  renderAuditSurface();
}

function renderPrimaryNav() {
  const destinations = {
    map: true,
    incidents: state.capabilities.canRead("incident"),
    situations: state.capabilities.canRead("incident"),
    cases: state.capabilities.canAny(["provider_case.draft", "provider_case.send"]),
    reports: state.capabilities.canRead("report"),
    admin: state.capabilities.has("admin.manage"),
    audit: state.capabilities.has("audit.read"),
  };
  document.querySelectorAll("#primaryNav [data-route], #navOverflow [data-route]").forEach((button) => { button.hidden = !destinations[button.dataset.route]; });
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

function resetAuthenticatedSurfaces() {
  stopNotificationPolling();
  stopOperationalPolling();
  closeDrawer(false);
  closeMapPopup(false);
  closeNotifications(false);
  state.mapPopupContext = null;
  state.mapPopupTrigger = null;
  state.mapPopupAnchor = null;
  state.selectedSchool = null;
  state.drawerTrigger = null;
  state.notificationsTrigger = null;
  state.searchActiveIndex = -1;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = null;
  $("#toastRegion")?.replaceChildren();
  map.resetSession?.();
}

function handleSessionChange(snapshot) {
  state.capabilities = createCapabilityState(snapshot.user);
  document.documentElement.dataset.capabilities = state.capabilities.capabilities.join(" ");
  if (!snapshot.authenticated) {
    resetAuthenticatedSurfaces();
    state.mapLoaded = false;
    state.mapLoadPromise = null;
    state.incidents = createIncidentSurfaceState();
    state.reports = createReportsSurfaceState();
    state.notifications = createNotificationsSurfaceState();
    state.admin = createAdminSurfaceState();
    state.audit = createAuditSurfaceState();
  } else {
    hydrateNotificationState(snapshot.user);
  }
  renderSession(snapshot);
  renderPrimaryNav();
  if (snapshot.authenticated) {
    initializeAuthenticatedWorkspace();
    startNotificationPolling();
    startOperationalPolling();
    void loadNotifications();
  }
}

function renderMapStatus() {
  const summary = map.summary();
  const registry = map.registryStatus();
  if ($("#lineCount")) $("#lineCount").textContent = String(summary.lineCount);
  if ($("#mapVisibleCount")) $("#mapVisibleCount").textContent = String(summary.lineCount);
  if ($("#mapVisibleSchoolCount")) $("#mapVisibleSchoolCount").textContent = summary.counts ? String(summary.counts.visibleSchoolCount) : presentation.empty();
  if ($("#mapAttentionCount")) $("#mapAttentionCount").textContent = summary.counts ? String(summary.counts.attentionSchoolCount) : presentation.empty();
  if ($("#mapModeLabel")) $("#mapModeLabel").textContent = summary.modeLabel;
  if ($("#mapFooterNote")) $("#mapFooterNote").textContent = summary.mode === "historical" ? i18n.t("map.historicalSource") : i18n.t("map.currentSource");
  if ($("#registryDataStatus")) { $("#registryDataStatus").textContent = registry.text; $("#registryDataStatus").dataset.state = registry.state; }
  if ($("#operationalStatus")) {
    $("#operationalStatus").textContent = summary.status === "available" ? i18n.t("map.monitoringAvailable", { count: summary.lineCount }) : i18n.t("map.operationalUnavailable");
    $("#operationalStatus").dataset.state = summary.status;
  }
  if ($("#mapError")) { $("#mapError").hidden = !map.state.operationalError; $("#mapError").textContent = map.state.operationalError ? i18n.t("map.serverUnavailable") : ""; }
  renderMapFilterControls();
  renderSchoolSearchResults();
  renderMapQuickFilters();
  renderSchoolList();
}

async function loadAuthenticatedMap({ preserveViewport = false, background = false } = {}) {
  if (state.mapLoadPromise) return state.mapLoadPromise;
  renderMapStatus();
  const requestGeneration = session.generation;
  const loadPromise = map.loadCurrent({ preserveViewport, retainOperationalState: background })
    .then(() => {
      if (session.generation !== requestGeneration || !session.authenticated) return;
      state.mapLoaded = true;
      reconcileOperationalMapSelection();
      renderMapStatus();
    })
    .catch((error) => {
      if (session.generation !== requestGeneration || !session.authenticated) return;
      state.mapLoaded = true;
      renderMapStatus();
      if (!background) showToast(error.status === 403 ? "map.forbidden" : "map.temporarilyUnavailable", "warn");
    })
    .finally(() => {
      if (session.generation === requestGeneration && state.mapLoadPromise === loadPromise) state.mapLoadPromise = null;
    });
  state.mapLoadPromise = loadPromise;
  return loadPromise;
}

function initializeAuthenticatedWorkspace() {
  if (!session.authenticated || state.mapInitialized) {
    if (session.authenticated && !state.mapLoaded) loadAuthenticatedMap();
    return;
  }
  map.init({ containerId: "leafletMap" });
  state.mapInitialized = true;
  applyReducedMotionToMap();
  loadAuthenticatedMap();
}

function updatedOperationalLines(items) {
  return (Array.isArray(items) ? items : []).map((line) => map.getLine(line?.id) || line);
}

function reconcileOperationalMapSelection() {
  const selection = state.selectedSchool;
  if (selection?.lines?.length) {
    const nextLines = updatedOperationalLines(selection.lines);
    state.selectedSchool = { ...selection, lines: nextLines, context: { ...(selection.context || {}), lines: nextLines } };
  }
  if (!state.mapPopupContext) return;
  const context = state.mapPopupContext;
  const nextContext = Array.isArray(context.lines) ? { ...context, lines: updatedOperationalLines(context.lines) } : context;
  state.mapPopupContext = nextContext;
  state.mapPopupTrigger = markerForMapContext(nextContext) || state.mapPopupTrigger;
  const popup = $("#mapPopup");
  if (!popup?.hidden && !popup.contains(document.activeElement)) renderPopup(nextContext);
  else scheduleMapPopupAnchor();
}

async function refreshOpenLineDetail() {
  if ($("#detailDrawer")?.hidden) return;
  const requestID = state.drawerRequestID;
  const line = selectedLine(state.selectedSchool);
  if (!line?.id) return;
  const lineID = line.id;
  try {
    const payload = await lines.get(lineID);
    const current = state.selectedSchool;
    const currentLine = selectedLine(current);
    if (state.drawerRequestID !== requestID || $("#detailDrawer")?.hidden || !current || String(currentLine?.id) !== String(lineID)) return;
    state.selectedSchool = { ...current, detail: mergeLineDetail(currentLine, payload), detailState: "ready" };
    renderSchoolDrawer(state.selectedSchool);
  } catch (error) {
    // Keep the last confirmed detail visible while a background refresh fails.
  }
}

async function refreshOperationalWorkspace() {
  if (!session?.authenticated) return;
  const refreshes = [];
  if (state.mapInitialized) refreshes.push(loadAuthenticatedMap({ preserveViewport: true, background: true }));
  if (!$("#detailDrawer")?.hidden) refreshes.push(refreshOpenLineDetail());
  if (router.getState().view === "incidents" && state.capabilities.canRead("incident")) refreshes.push(loadIncidents({ force: true, background: true }));
  await Promise.allSettled(refreshes);
}

function replaceOptions(selector, options, emptyKey, label = (value) => value) {
  const select = $(selector);
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = i18n.t(emptyKey);
  select.appendChild(empty);
  options.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label(value);
    select.appendChild(option);
  });
  select.value = options.includes(selected) ? selected : "";
  select.disabled = options.length === 0;
}

function renderMapFilterControls() {
  const options = map.filterOptions();
  const filters = map.state.filters;
  replaceOptions("#districtFilter", options.districts, "map.anyDistrict");
  replaceOptions("#providerFilter", options.providers, "map.anyProvider");
  replaceOptions("#statusFilter", options.statuses, "map.anyStatus", (status) => presentation.status(status).label);
  if ($("#districtFilter")) $("#districtFilter").value = options.districts.includes(filters.district) ? filters.district : "";
  if ($("#providerFilter")) $("#providerFilter").value = options.providers.includes(filters.provider) ? filters.provider : "";
  if ($("#statusFilter")) $("#statusFilter").value = options.statuses.includes(filters.status) ? filters.status : "";
  if ($("#coverageFilter")) $("#coverageFilter").value = map.state.coverage;
  if ($("#mapListMode")) $("#mapListMode").value = map.state.mapMode;
  if ($("#schoolSearch")) $("#schoolSearch").value = filters.query;
}

function mapRecordStatus(record) {
  const rawStatus = record?.status === "NOT_MONITORED" ? "NO_DATA" : record?.status;
  return presentation.status(rawStatus);
}

function mapRecordMetrics(record) {
  const line = record?.lines?.[0];
  const latest = line?.latest || {};
  const download = latest.download;
  const upload = latest.upload;
  const speed = download == null && upload == null
    ? presentation.empty()
    : [download, upload].map((value) => value == null ? presentation.empty() : presentation.formatNumber(value)).join(" / ");
  return {
    speed,
    ping: latest.ping == null ? presentation.empty() : presentation.formatNumber(latest.ping),
  };
}

function renderMapQuickFilters() {
  const root = $("#mapQuickFilters");
  if (!root) return;
  const options = map.filterOptions();
  const filters = map.state.filters;
  const activeStatus = filters.status;
  const activeProvider = filters.provider;
  const allActive = !activeStatus && !activeProvider;
  const buttons = [
    { key: "all", label: i18n.t("map.allSchools"), active: allActive },
    ...options.statuses.map((status) => ({ key: `status:${status}`, label: status === "NOT_MONITORED" ? i18n.t("map.registryOnly") : presentation.status(status).label, active: activeStatus === status && !activeProvider })),
    ...options.providers.map((provider) => ({ key: `provider:${provider}`, label: provider, active: activeProvider === provider && !activeStatus })),
  ];
  root.innerHTML = buttons.map((button) => `<button type="button" class="map-quick-filter${button.active ? " active" : ""}" data-map-quick-filter="${escapeHtml(button.key)}" aria-pressed="${String(button.active)}">${escapeHtml(button.label)}</button>`).join("");
}

function renderSchoolList() {
  const root = $("#schoolList");
  if (!root) return;
  root.replaceChildren();
  if (map.state.registryLoading) {
    root.innerHTML = `<p class="school-list-state" role="status">${escapeHtml(i18n.t("map.registryLoading"))}</p>`;
    return;
  }
  if (map.state.registryUnavailable) {
    root.innerHTML = `<p class="school-list-state error" role="alert">${escapeHtml(i18n.t("map.registryUnavailable"))}</p>`;
    return;
  }
  const records = Array.isArray(map.state.view?.records) ? map.state.view.records : [];
  if (!records.length) {
    root.innerHTML = `<div class="school-list-empty"><span class="empty-icon" aria-hidden="true">${iconMarkup("search", { size: 18 })}</span><strong>${escapeHtml(i18n.t("map.searchEmpty"))}</strong><span>${escapeHtml(i18n.t("map.adjustFilters"))}</span></div>`;
    return;
  }
  const selectedID = state.mapPopupContext?.registryId ?? state.selectedSchool?.school?.registryId ?? null;
  records.forEach((record) => {
    const school = record.school;
    const status = mapRecordStatus(record);
    const metrics = mapRecordMetrics(record);
    const registryID = school?.registryId ?? "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `school-row${String(registryID) === String(selectedID) ? " selected" : ""}`;
    button.dataset.registryId = registryID;
    button.setAttribute("aria-pressed", String(String(registryID) === String(selectedID)));
    const title = escapeHtml(presentation.schoolName(school));
    const context = escapeHtml([school?.district, school?.locality].filter(Boolean).join(" · ") || i18n.t("school.registry"));
    const statusLabel = escapeHtml(status.label);
    button.innerHTML = `<span class="school-row-icon" aria-hidden="true">${iconMarkup("school", { size: 20 })}</span><span class="school-row-copy"><strong>${title}</strong><span>${context}</span></span><span class="school-row-state"><span><i class="state-dot ${status.tone}"></i>${statusLabel}</span><b>${escapeHtml(metrics.speed)}</b></span>`;
    button.addEventListener("click", () => {
      const focused = map.focusSchool(registryID);
      if (focused.ok) openMapPopup(focused.context, focused.marker);
      else showToast("map.searchNoCoordinate", "warn");
    });
    root.appendChild(button);
  });
}

function setSearchComboboxState(expanded, activeId = "") {
  const input = $("#schoolSearch");
  if (!input) return;
  input.setAttribute("aria-expanded", String(Boolean(expanded)));
  if (activeId) input.setAttribute("aria-activedescendant", activeId);
  else input.removeAttribute("aria-activedescendant");
}

function setSearchActiveIndex(index) {
  const results = $("#schoolSearchResults");
  const options = results ? [...results.querySelectorAll('[role="option"]')] : [];
  state.searchActiveIndex = options.length ? Math.max(0, Math.min(index, options.length - 1)) : -1;
  options.forEach((option, optionIndex) => option.setAttribute("aria-selected", String(optionIndex === state.searchActiveIndex)));
  setSearchComboboxState(options.length > 0, options[state.searchActiveIndex]?.id || "");
}

function renderSchoolSearchResults() {
  const results = $("#schoolSearchResults");
  const status = $("#mapFilterStatus");
  if (!results || !status) return;
  const query = map.state.filters.query.trim();
  const hasFilter = Boolean(query || map.state.filters.district || map.state.filters.provider || map.state.filters.status || map.state.coverage === "monitored");
  const visibleSchoolCount = map.state.view?.counts?.visibleSchoolCount;
  results.replaceChildren();
  status.hidden = true;
  state.searchActiveIndex = -1;
  setSearchComboboxState(false);
  if (!query && (!hasFilter || visibleSchoolCount !== 0)) { results.hidden = true; return; }
  if (map.state.registryLoading) { status.textContent = i18n.t("map.registryLoading"); status.hidden = false; results.hidden = true; return; }
  if (map.state.registryUnavailable) { status.textContent = i18n.t("map.registryUnavailable"); status.hidden = false; results.hidden = true; return; }
  const matches = map.searchResults();
  if (!query && visibleSchoolCount === 0) { status.textContent = i18n.t("map.searchEmpty"); status.hidden = false; results.hidden = true; return; }
  if (!matches.length) { status.textContent = i18n.t("map.searchEmpty"); status.hidden = false; results.hidden = true; return; }
  matches.forEach((record, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "school-search-result";
    button.setAttribute("role", "option");
    button.id = `school-search-option-${index}`;
    button.setAttribute("aria-selected", "false");
    button.dataset.registryId = record.school.registryId;
    const title = document.createElement("strong");
    title.textContent = presentation.schoolName(record.school);
    const description = document.createElement("span");
    description.textContent = [record.school.district, record.school.address].filter(Boolean).join(" · ");
    button.append(title, description);
    button.addEventListener("click", () => selectSearchResult(record.school.registryId));
    results.appendChild(button);
  });
  results.hidden = false;
  setSearchComboboxState(true);
}

function selectSearchResult(registryId) {
  state.searchActiveIndex = -1;
  const result = map.focusSchool(registryId);
  if (!result.ok) {
    const status = $("#mapFilterStatus");
    if (status) { status.textContent = i18n.t("map.searchNoCoordinate"); status.hidden = false; }
    return;
  }
  const results = $("#schoolSearchResults");
  if (results) results.hidden = true;
  setSearchComboboxState(false);
  openMapPopup(result.context, result.marker);
}

function handleSchoolSearchKeydown(event) {
  const options = [...($("#schoolSearchResults")?.querySelectorAll('[role="option"]') || [])];
  if (event.key === "ArrowDown" && options.length) {
    event.preventDefault();
    setSearchActiveIndex(state.searchActiveIndex + 1);
  } else if (event.key === "ArrowUp" && options.length) {
    event.preventDefault();
    setSearchActiveIndex(state.searchActiveIndex <= 0 ? options.length - 1 : state.searchActiveIndex - 1);
  } else if (event.key === "Enter" && state.searchActiveIndex >= 0 && options[state.searchActiveIndex]) {
    event.preventDefault();
    selectSearchResult(options[state.searchActiveIndex].dataset.registryId);
  } else if (event.key === "Escape" && options.length) {
    event.preventDefault();
    state.searchActiveIndex = -1;
    const results = $("#schoolSearchResults");
    if (results) results.hidden = true;
    setSearchComboboxState(false);
  }
}

function applyMapFilters() {
  map.setFilters({
    district: $("#districtFilter")?.value || "",
    provider: $("#providerFilter")?.value || "",
    status: $("#statusFilter")?.value || "",
  });
  renderMapStatus();
}

function showToastText(message, tone = "") {
  const region = $("#toastRegion");
  if (!region) return;
  region.replaceChildren();
  const item = document.createElement("div");
  item.className = "toast " + tone;
  item.textContent = message;
  region.appendChild(item);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => item.remove(), 4200);
}

function showToast(messageKey, tone = "", params = {}) {
  showToastText(i18n.t(messageKey, params), tone);
}

function mapFields(fields) {
  return fields.map(([label, value]) => "<div><dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(value ?? presentation.empty()) + "</dd></div>").join("");
}
function technicalDetails(fields) {
  if (!Array.isArray(fields) || !fields.length) return "";
  return '<details class="technical-details"><summary>' + escapeHtml(i18n.t("admin.details")) + "</summary><dl>" + mapFields(fields) + "</dl></details>";
}
function popupSchoolName(school, line) { return presentation.schoolName(school, line?.school_name); }
function popupLine(line) {
  const status = presentation.status(line.linkwatchStatus || line.status);
  const role = line.role ? presentation.role(line.role) : i18n.t("field.line");
  const reason = status.tone !== "healthy" ? presentation.statusDescription(status.code) : "";
  return {
    title: popupSchoolName(line.registrySchool, line),
    fields: [
      [i18n.t("field.line"), role], [i18n.t("field.provider"), line.provider],
      [i18n.t("field.connectionType"), presentation.connectionType(line.technology)],
      [i18n.t("field.lastObserved"), presentation.formatDate(line.latest?.at, true)],
      ...(reason ? [[i18n.t("field.problemReason"), reason]] : []),
    ],
    technical: [
      [i18n.t("admin.recordId"), line.id],
      [i18n.t("field.status"), status.label],
      [i18n.t("field.registryNumber"), line.registryId || line.registrySchool?.registryId],
      ...(line.technology_id ? [[i18n.t("field.connectionType"), line.technology_id]] : []),
    ],
  };
}

function popupMetricsMarkup(line) {
  const latest = line?.latest || {};
  const metrics = [
    [i18n.t("map.metricDownload"), latest.download, "unit.mbps"],
    [i18n.t("map.metricUpload"), latest.upload, "unit.mbps"],
    [i18n.t("map.metricPing"), latest.ping, "unit.ms"],
    [i18n.t("map.metricLoss"), latest.loss ?? latest.packet_loss, "unit.percent"],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return metrics.map(([label, value, unit]) => '<div><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(presentation.formatNumber(value, i18n.t(unit))) + '</b></div>').join("");
}

function coordinateText(school) {
  const coordinate = school?.coordinate;
  if (!coordinate || !Number.isFinite(Number(coordinate.latitude)) || !Number.isFinite(Number(coordinate.longitude))) return i18n.t("school.coordinatesUnavailable");
  return Number(coordinate.latitude).toFixed(6) + ", " + Number(coordinate.longitude).toFixed(6);
}

function registryProvenance(school) {
  const provenance = school?.provenance;
  if (typeof provenance === "string") return provenance || i18n.t("school.provenanceUnavailable");
  return provenance?.source || provenance?.sourceUrl || i18n.t("school.provenanceUnavailable");
}

function knownValue(value) { return value === undefined || value === null || value === "" ? i18n.t("school.notProvided") : value; }

function lineSelector(linesAtSchool, selectedLineId) {
  if (linesAtSchool.length < 2) return "";
  return "<div><dt>" + escapeHtml(i18n.t("field.lines")) + "</dt><dd>" + linesAtSchool.map((line) => {
    const active = line.id === selectedLineId;
    const role = line.role ? presentation.role(line.role) : i18n.t("field.line");
    return '<button type="button" class="map-member" data-popup-line-id="' + escapeHtml(line.id) + '" aria-pressed="' + active + '">' + '<span>' + escapeHtml(role) + "</span></button>";
  }).join("") + "</dd></div>";
}

function markerForMapContext(context) {
  const layers = globalThis.LinkwatchMap?.getLayers?.();
  const candidates = [
    ...(layers?.monitoringMarkers || []), ...(layers?.registryMarkers || []), ...(layers?.registryClusters?.items || []),
  ];
  const registryId = context?.registryId || context?.school?.registryId;
  return candidates.find((candidate) => {
    const candidateContext = globalThis.LinkwatchMap?.getMarkerContext?.(candidate);
    return registryId !== undefined && registryId !== null && String(candidateContext?.registryId) === String(registryId);
  }) || candidates.find((candidate) => globalThis.LinkwatchMap?.getMarkerContext?.(candidate)?.kind === context?.kind && context?.kind === "registry-cluster") || null;
}

function unbindMapPopupAnchor() {
  const anchor = state.mapPopupAnchor;
  if (!anchor) return;
  ["move", "zoom", "resize", "viewreset"].forEach((eventName) => anchor.mapInstance?.off?.(eventName, anchor.handler));
  if (anchor.frameId !== null) {
    globalThis.cancelAnimationFrame?.(anchor.frameId);
    globalThis.clearTimeout?.(anchor.frameId);
  }
  state.mapPopupAnchor = null;
}

function scheduleMapPopupAnchor() {
  const anchor = state.mapPopupAnchor;
  if (!anchor || anchor.frameId !== null) return;
  const update = () => {
    anchor.frameId = null;
    updateMapPopupAnchor();
  };
  anchor.frameId = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame(update)
    : globalThis.setTimeout(update, 0);
}

function updateMapPopupAnchor() {
  const popup = $("#mapPopup");
  if (!popup || popup.hidden || !state.mapPopupContext) return;
  const mapApi = globalThis.LinkwatchMap;
  const marker = state.mapPopupTrigger;
  const mapInstance = mapApi?.getMap?.();
  const positioner = mapApi?.positionPopup || mapApi?.syncPopupAnchor || mapApi?.anchorPopup;
  if (typeof positioner === "function") {
    positioner({ popup, marker, context: state.mapPopupContext, map: mapInstance });
    return;
  }
  const latLng = marker?.getLatLng?.();
  const mapContainer = mapInstance?.getContainer?.() || $("#leafletMap");
  const workspace = $("#mapArea") || $("#mapWrap");
  if (!latLng || !mapInstance?.latLngToContainerPoint || !mapContainer || !workspace) return;
  const point = mapInstance.latLngToContainerPoint(latLng);
  const mapRect = mapContainer.getBoundingClientRect?.();
  const workspaceRect = workspace.getBoundingClientRect?.();
  if (!mapRect || !workspaceRect || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
  const anchorX = mapRect.left - workspaceRect.left + point.x;
  const anchorY = mapRect.top - workspaceRect.top + point.y;
  const popupWidth = popup.offsetWidth || 380;
  const popupHeight = popup.offsetHeight || 240;
  const maxLeft = Math.max(12, workspaceRect.width - popupWidth - 12);
  const left = Math.max(12, Math.min(maxLeft, anchorX + 16));
  const maxTop = Math.max(72, workspaceRect.height - popupHeight - 12);
  const above = anchorY - popupHeight - 16;
  const top = above >= 72 ? above : Math.min(maxTop, anchorY + 18);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(Math.max(72, top))}px`;
  popup.style.right = "auto";
  popup.style.bottom = "auto";
}

function bindMapPopupAnchor() {
  const mapInstance = globalThis.LinkwatchMap?.getMap?.();
  if (!mapInstance || !state.mapPopupTrigger) return;
  if (state.mapPopupAnchor?.mapInstance === mapInstance) {
    scheduleMapPopupAnchor();
    return;
  }
  unbindMapPopupAnchor();
  const anchor = { mapInstance, handler: scheduleMapPopupAnchor, frameId: null };
  state.mapPopupAnchor = anchor;
  ["move", "zoom", "resize", "viewreset"].forEach((eventName) => mapInstance.on?.(eventName, anchor.handler));
  scheduleMapPopupAnchor();
}

function renderPopup(context) {
  const popup = $("#mapPopup");
  const openLineButton = $("#mapPopupOpenLine");
  const addMonitoringButton = $("#mapPopupAddMonitoring");
  const fields = $("#mapPopupFields");
  const metrics = $("#mapPopupMetrics");
  if (!popup || !fields) return;
  const school = context.school;
  const selection = state.selectedSchool;
  const stateElement = $("#mapPopupState");
  let title = context.label || popupSchoolName(school, context.lines?.[0]);
  let summary = "";
  openLineButton.hidden = true;
  openLineButton.textContent = "";
  if (addMonitoringButton) {
    addMonitoringButton.hidden = true;
    addMonitoringButton.textContent = "";
  }
  if (metrics) {
    metrics.hidden = true;
    metrics.replaceChildren();
  }
  if (stateElement) { stateElement.textContent = ""; stateElement.className = "selection-state"; }
  if (context.kind === "registry-cluster") {
    title = i18n.t("map.clusterTitle", { count: context.count });
    summary = i18n.t("map.clusterSummary");
    fields.innerHTML = "<div><dt>" + escapeHtml(i18n.t("field.schools")) + "</dt><dd>" + context.members.map((member) => '<button type="button" class="map-member" data-popup-registry-id="' + escapeHtml(member.registryId) + '">' + escapeHtml(popupSchoolName(member.school)) + "</button>").join("") + "</dd></div>";
  } else if (context.kind === "registry") {
    title = popupSchoolName(school);
    summary = i18n.t("map.registrySummary");
    fields.innerHTML = mapFields([[i18n.t("field.registryNumber"), school?.registryId], [i18n.t("field.address"), school?.address], [i18n.t("field.monitoringStatus"), presentation.status("NOT_MONITORED").label]]);
    if (stateElement) stateElement.textContent = presentation.statusDescription("NOT_MONITORED");
    openLineButton.textContent = i18n.t("action.openSchoolDetail");
    openLineButton.hidden = false;
    if (addMonitoringButton && state.capabilities.has("admin.manage")) {
      addMonitoringButton.textContent = i18n.t("admin.addToMonitoring");
      addMonitoringButton.hidden = false;
    }
  } else {
    const linesAtSchool = selection?.lines || context.lines || [];
    const selected = selectedLine(selection);
    const content = selected ? popupLine(selected) : null;
    title = popupSchoolName(selection?.school || school, selected || linesAtSchool[0]);
    summary = context.mode === "historical" ? i18n.t("map.historicalSource") : i18n.t("map.currentSource");
    fields.innerHTML = lineSelector(linesAtSchool, selection?.selectedLineId) + (content ? mapFields(content.fields) : "");
    if (stateElement) {
      stateElement.textContent = selected
        ? presentation.statusDescription(selected.linkwatchStatus || selected.status)
        : i18n.t("school.chooseLine");
    }
    openLineButton.textContent = i18n.t("action.openLine");
    openLineButton.hidden = false;
    openLineButton.dataset.lineId = selected?.id || "";
    if (metrics && selected) {
      metrics.innerHTML = popupMetricsMarkup(selected);
      metrics.hidden = !metrics.childElementCount;
    }
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
    state.selectedSchool = selectSchoolLine(state.selectedSchool, button.dataset.popupLineId);
    renderPopup(context);
  }));
  bindMapPopupAnchor();
}

function registrySchoolAdminPayload(school) {
  const coordinate = school?.coordinate || {};
  const registryID = String(school?.registryId || school?.school_id || school?.id || "").trim();
  return {
    id: adminGeneratedID("organizations"),
    school_id: registryID,
    name: popupSchoolName(school),
    district: String(school?.district || school?.districtName || school?.region || "").trim(),
    address: String(school?.address || "").trim(),
    latitude: Number.isFinite(Number(coordinate.latitude)) ? Number(coordinate.latitude) : undefined,
    longitude: Number.isFinite(Number(coordinate.longitude)) ? Number(coordinate.longitude) : undefined,
    active: true,
  };
}

function openProviderCaseCreateForLine(lineID) {
  if (!lineID || !state.capabilities.has("provider_case.draft")) return;
  const view = incidentSurfaceState();
  view.caseCreateOpen = true;
  view.caseCreateState = "idle";
  view.caseCreateError = "";
  view.caseCreateDraft = { line_id: String(lineID), comment: "" };
  closeMapPopup(false);
  router.navigate("cases");
  renderIncidentsSurface();
}

async function startSchoolMonitoringSetup() {
  if (!state.capabilities.has("admin.manage") || state.mapPopupContext?.kind !== "registry") return;
  const school = state.mapPopupContext.school;
  const payload = registrySchoolAdminPayload(school);
  if (!payload.school_id || !payload.name || !payload.district) {
    showToast("admin.registryDataIncomplete", "warn");
    return;
  }
  state.admin.onboarding = { active: true, school: { ...school, ...payload }, state: "idle", step: "", error: "", result: null };
  state.admin.resource = "organizations";
  state.admin.selectedId = "";
  state.admin.editorIntent = "create";
  state.admin.draftID = payload.id;
  state.admin.payload = JSON.stringify(payload, null, 2);
  state.admin.search = "";
  state.admin.message = "admin.registryPrefillHint";
  state.admin.onboardingRegistryId = payload.school_id;
  closeMapPopup(false);
  router.navigate("admin");
  await loadAdminResource({ force: true, preserveMessage: true });
  renderAdminPreservingScroll();
  globalThis.requestAnimationFrame?.(() => $("[data-school-onboarding]")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function onboardingStepLabel(step) {
  return { organization: i18n.t("field.school"), provider: i18n.t("admin.onboardingProvider"), line: i18n.t("admin.onboardingLine"), point: i18n.t("admin.onboardingPoint"), contract: i18n.t("admin.onboardingContract"), activation: i18n.t("admin.onboardingLine"), enrollment: i18n.t("admin.onboardingEnrollmentCode") }[step] || i18n.t("admin.onboardingTitle");
}

function setOnboardingStep(step) {
  state.admin.onboarding.step = step;
  renderAdminPreservingScroll();
}

function onboardingOrganization(organizations, schoolID) {
  return (Array.isArray(organizations) ? organizations : []).find((item) => String(item?.school_id || "") === String(schoolID)) || null;
}

function onboardingProvider(providers, providerID, providerName) {
  const byID = providerID ? providers.find((item) => String(item?.id || "") === String(providerID)) : null;
  if (byID) return byID;
  const normalizedName = String(providerName || "").trim().toLocaleLowerCase();
  return normalizedName ? providers.find((item) => String(item?.name || "").trim().toLocaleLowerCase() === normalizedName) || null : null;
}

function onboardingLine(linesForSetup, organizationID, role, providerID) {
  return (Array.isArray(linesForSetup) ? linesForSetup : []).find((item) => String(item?.organization_id || "") === String(organizationID)
    && String(item?.role || "") === String(role)
    && String(item?.status || "") !== "DELETED"
    && (!providerID || String(item?.provider_id || "") === String(providerID))) || null;
}

function onboardingPoint(points, lineID) {
  const sameLine = (Array.isArray(points) ? points : []).filter((item) => String(item?.line_id || "") === String(lineID));
  return sameLine.find((item) => item?.active !== false) || sameLine[0] || null;
}

function onboardingDateISO(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function runSchoolMonitoringSetup(event) {
  event.preventDefault();
  const view = state.admin;
  const onboarding = view.onboarding;
  if (!onboarding.active || onboarding.state === "running") return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const school = onboarding.school || {};
  const providerID = String(values.provider_id || "").trim();
  const providerName = String(values.provider_name || "").trim();
  const supportContact = String(values.support_contact || "").trim();
  const role = String(values.role || "PRIMARY").trim().toUpperCase();
  const technology = String(values.technology || "FIBER").trim().toUpperCase();
  const location = String(values.location || school.address || "").trim();
  const contractNo = String(values.contract_no || "").trim();
  const validFrom = onboardingDateISO(values.valid_from);
  const validTo = onboardingDateISO(values.valid_to);
  const contractDate = onboardingDateISO(values.contract_date);
  if (!providerID && !providerName) {
    onboarding.error = "admin.onboardingNoProvider";
    onboarding.state = "error";
    renderAdminPreservingScroll();
    return;
  }
  if (!location || !technology) {
    onboarding.error = "admin.payloadInvalid";
    onboarding.state = "error";
    renderAdminPreservingScroll();
    return;
  }
  onboarding.state = "running";
  onboarding.error = "";
  onboarding.result = null;
  renderAdminPreservingScroll();
  try {
    setOnboardingStep("organization");
    let organizations = await boundaries.admin.list("organizations");
    let organization = onboardingOrganization(organizations, school.school_id || school.registryId);
    if (!organization) {
      const organizationPayload = registrySchoolAdminPayload(school);
      try {
        organization = objectPayload(await boundaries.admin.create("organizations", organizationPayload));
      } catch (error) {
        if (Number(error?.status) !== 409) throw error;
        organizations = await boundaries.admin.list("organizations");
        organization = onboardingOrganization(organizations, school.school_id || school.registryId);
        if (!organization) throw error;
      }
    }
    if (!organization?.id) throw new Error("organization was not returned");

    setOnboardingStep("provider");
    let providers = await boundaries.admin.list("providers");
    let provider = onboardingProvider(providers, providerID, providerName);
    if (!provider && providerName) {
      const newProvider = { id: adminGeneratedID("providers"), name: providerName, support_contact: supportContact, active: true };
      try {
        provider = objectPayload(await boundaries.admin.create("providers", newProvider));
      } catch (error) {
        if (Number(error?.status) !== 409) throw error;
        providers = await boundaries.admin.list("providers");
        provider = onboardingProvider(providers, providerID, providerName);
        if (!provider) throw error;
      }
    }
    if (!provider?.id) throw new Error("provider was not returned");

    setOnboardingStep("line");
    let managedLines = await boundaries.admin.list("lines");
    let line = onboardingLine(managedLines, organization.id, role, provider.id);
    const linePayload = { id: adminGeneratedID("lines"), organization_id: organization.id, provider_id: provider.id, role, technology, status: "INACTIVE" };
    if (!line) {
      try {
        line = objectPayload(await boundaries.admin.create("lines", linePayload));
      } catch (error) {
        if (Number(error?.status) !== 409) throw error;
        managedLines = await boundaries.admin.list("lines");
        line = onboardingLine(managedLines, organization.id, role, provider.id);
        if (!line) throw error;
      }
    }
    if (!line?.id) throw new Error("line was not returned");

    setOnboardingStep("point");
    let points = await boundaries.admin.list("monitoring-points");
    let point = onboardingPoint(points, line.id);
    const pointPayload = { id: adminGeneratedID("monitoring-points"), line_id: line.id, location, is_primary: true, active: true };
    if (!point) {
      try {
        point = objectPayload(await boundaries.admin.create("monitoring-points", pointPayload));
      } catch (error) {
        if (Number(error?.status) !== 409) throw error;
        points = await boundaries.admin.list("monitoring-points");
        point = onboardingPoint(points, line.id);
        if (!point) throw error;
      }
    } else if (point.active === false || point.is_primary !== true || point.location !== location) {
      point = objectPayload(await boundaries.admin.update("monitoring-points", point.id, { id: point.id, line_id: line.id, location, is_primary: true, active: true }));
    }
    if (!point?.id) throw new Error("monitoring point was not returned");

    if (contractNo) {
      setOnboardingStep("contract");
      const contracts = await boundaries.admin.list("contracts", "line_id=" + encodeURIComponent(line.id));
      const existingContract = contracts.find((item) => String(item?.contract_no || "") === contractNo);
      if (!existingContract) {
        const contractPayload = { line_id: line.id, valid_from: validFrom || new Date().toISOString(), contract_no: contractNo };
        if (validTo) contractPayload.valid_to = validTo;
        if (contractDate) contractPayload.contract_date = contractDate;
        await boundaries.admin.create("contracts", contractPayload);
      }
    }

    setOnboardingStep("activation");
    const activePayload = { id: line.id, organization_id: organization.id, provider_id: provider.id, role, technology, ...(line.technology_id ? { technology_id: line.technology_id } : {}), status: "ACTIVE" };
    if (String(line.status || "") !== "ACTIVE" || String(line.role || "") !== role || String(line.technology || "") !== technology || String(line.provider_id || "") !== String(provider.id)) {
      line = objectPayload(await boundaries.admin.update("lines", line.id, activePayload));
    }

    setOnboardingStep("enrollment");
    const enrollment = objectPayload(await boundaries.admin.createEnrollmentCode(point.id));
    onboarding.result = { organization, provider, line, point, enrollment };
    onboarding.state = "success";
    onboarding.step = "";
    view.onboardingRegistryId = "";
    view.message = "";
    await Promise.allSettled([refreshMap(), loadAdminResource({ force: true, preserveMessage: true })]);
  } catch (error) {
    onboarding.state = "error";
    onboarding.error = "admin.onboardingFailed";
  }
  renderAdminPreservingScroll();
}

function cancelSchoolMonitoringSetup() {
  state.admin.onboarding = createAdminOnboardingState();
  state.admin.onboardingRegistryId = "";
  state.admin.message = "";
  router.navigate("map");
}

function openMapPopup(context, trigger = null) {
  state.mapPopupContext = context;
  state.mapPopupTrigger = trigger?.getLatLng?.() ? trigger : markerForMapContext(context) || (document.activeElement !== document.body ? document.activeElement : null);
  state.selectedSchool = context.kind === "registry-cluster" ? null : createSelectedSchool(context);
  renderPopup(context);
  renderSchoolList();
  $("#mapPopup")?.focus();
}

function closeMapPopup(restoreFocus = true, preserveSelection = false) {
  unbindMapPopupAnchor();
  const popup = $("#mapPopup");
  if (popup) {
    popup.hidden = true;
    popup.classList.add("hidden");
    popup.style.left = "";
    popup.style.top = "";
    popup.style.right = "";
    popup.style.bottom = "";
  }
  const trigger = state.mapPopupTrigger;
  if (restoreFocus) (trigger?.getElement?.() || trigger)?.focus?.();
  state.mapPopupContext = null;
  state.mapPopupTrigger = null;
  renderSchoolList();
  if (preserveSelection || !$("#detailDrawer")?.hidden) return;
  state.selectedSchool = null;
}

function renderSchoolDrawer(selection = state.selectedSchool) {
  if (!selection || !$("#detailDrawer")) return;
  const school = selection.school;
  const selected = selectedLine(selection);
  const line = selection.detail || selected;
  const drawerState = $("#drawerState");
  $("#drawerTitle").textContent = popupSchoolName(school, line) || presentation.empty();
  $("#drawerSubtitle").textContent = knownValue(school?.address || school?.district);
  drawerState.textContent = selection.detailState === "loading" ? i18n.t("school.detailLoading") : selection.detailState === "error" ? i18n.t("school.detailUnavailable") : "";
  drawerState.className = "selection-state" + (selection.detailState === "error" ? " error" : "");
  const tabs = [["summary", i18n.t("map.lineDetail")], ["measurements", i18n.t("field.metrics")], ["states", i18n.t("field.status")], ["device", i18n.t("field.device")], ["incidents", i18n.t("nav.incidents")]];
  const tabsRoot = $("#drawerTabs");
  if (tabsRoot) tabsRoot.innerHTML = tabs.map(([key, label]) => '<button type="button" class="detail-tab' + (state.drawerTab === key ? " active" : "") + '" data-drawer-tab="' + escapeHtml(key) + '" role="tab" aria-selected="' + String(state.drawerTab === key) + '">' + escapeHtml(label) + '</button>').join("");
  $("#drawerContext").innerHTML = mapFields([
    [i18n.t("field.officialIdentity"), popupSchoolName(school, line)],
    [i18n.t("field.address"), knownValue(school?.address)],
  ]);
  $("#drawerTechnical").innerHTML = technicalDetails([
    [i18n.t("field.registryNumber"), school?.registryId],
    [i18n.t("field.coordinates"), coordinateText(school)],
    [i18n.t("field.coordinateSource"), presentation.coordinateSource(school?.coordinateSource)],
    [i18n.t("field.registryProvenance"), registryProvenance(school)],
  ]);
  $("#drawerLineTechnical").innerHTML = "";
  if (!selected) {
    $("#drawerStatus").innerHTML = selection.registryOnly
      ? '<span class="status-badge no-data">' + escapeHtml(presentation.status("NOT_MONITORED").label) + "</span><p>" + escapeHtml(presentation.statusDescription("NOT_MONITORED")) + "</p>"
      : "<p>" + escapeHtml(i18n.t("school.chooseLine")) + "</p>";
    $("#drawerLine").innerHTML = lineSelector(selection.lines, null);
    $("#drawerMetrics").innerHTML = "";
    $("#drawerIncident").innerHTML = '<div class="empty-state"><strong>' + escapeHtml(i18n.t("nav.incidents")) + '</strong><span>' + escapeHtml(i18n.t("school.chooseLine")) + '</span></div>';
    $("#drawerMeasurements").innerHTML = '<p class="detail-muted">' + escapeHtml(i18n.t("school.chooseLine")) + '</p>';
    $("#drawerStates").innerHTML = '<p class="detail-muted">' + escapeHtml(i18n.t("school.chooseLine")) + '</p>';
    $("#drawerDevice").innerHTML = "";
  } else {
    const status = presentation.status(line.linkwatchStatus || line.status);
    $("#drawerStatus").innerHTML = '<span class="status-badge ' + escapeHtml(status.tone) + '">' + escapeHtml(status.label) + "</span><p>" + escapeHtml(presentation.statusDescription(status.code)) + "</p>";
    const contractNumber = line.contract?.contract_no;
    $("#drawerLine").innerHTML = lineSelector(selection.lines, selected.id) + mapFields([
      [i18n.t("field.provider"), knownValue(line.provider === "—" ? null : line.provider)],
      [i18n.t("field.connectionType"), presentation.connectionType(line.technology)], [i18n.t("field.lineRole"), presentation.role(line.role)],
      [i18n.t("field.lastObserved"), line.latest?.at ? presentation.formatDate(line.latest.at, true) : i18n.t("school.notObserved")],
      ...(contractNumber ? [[i18n.t("field.contract"), contractNumber]] : []),
    ]);
    $("#drawerLineTechnical").innerHTML = technicalDetails([
      [i18n.t("field.line"), line.id],
      [i18n.t("field.status"), line.status],
      ...(line.technology_id ? [[i18n.t("field.connectionType"), line.technology_id]] : []),
    ]);
    const metricLabels = { download: ["field.download", "unit.mbps"], upload: ["field.upload", "unit.mbps"], ping: ["field.ping", "unit.ms"], jitter: ["field.jitter", "unit.ms"], loss: ["field.loss", "unit.percent"] };
    const metrics = availableMetrics(line);
    $("#drawerMetrics").innerHTML = metrics.length
      ? mapFields(metrics.map(([metric, value]) => [i18n.t(metricLabels[metric][0]), presentation.formatNumber(value, i18n.t(metricLabels[metric][1]))]))
      : mapFields([[i18n.t("field.metrics"), i18n.t("school.metricsUnavailable")]]);
    const incident = activeIncident(line);
    $("#drawerIncident").innerHTML = incident ? mapFields([[i18n.t("field.activeIncident"), incident.incident_no || incident.number || incident.id], [i18n.t("field.incidentStatus"), presentation.incidentStatus(incident.status)]]) + '<button class="link-action" type="button" data-open-incident-id="' + escapeHtml(incident.id) + '">' + escapeHtml(i18n.t("nav.incidents")) + "</button>" : '<div class="empty-state"><strong>' + escapeHtml(i18n.t("nav.incidents")) + '</strong><span>' + escapeHtml(i18n.t("incidents.empty")) + '</span></div>';
    const measurements = Array.isArray(line.measurements) ? line.measurements : [];
    $("#drawerMeasurements").innerHTML = measurements.length ? '<div class="sectionhead"><h3>' + escapeHtml(i18n.t("field.metrics")) + '</h3><span>' + escapeHtml(String(measurements.length)) + '</span></div><div class="detail-table"><table><thead><tr><th>' + escapeHtml(i18n.t("field.lastObserved")) + '</th><th>' + escapeHtml(i18n.t("field.download")) + '</th><th>' + escapeHtml(i18n.t("field.upload")) + '</th><th>' + escapeHtml(i18n.t("field.ping")) + '</th><th>' + escapeHtml(i18n.t("field.loss")) + '</th></tr></thead><tbody>' + measurements.slice(0, 20).map((measurement) => '<tr><td>' + escapeHtml(presentation.formatDate(measurement.observed_at || measurement.at, true)) + '</td><td>' + escapeHtml(presentation.formatNumber(measurement.download, i18n.t("unit.mbps"))) + '</td><td>' + escapeHtml(presentation.formatNumber(measurement.upload, i18n.t("unit.mbps"))) + '</td><td>' + escapeHtml(presentation.formatNumber(measurement.ping, i18n.t("unit.ms"))) + '</td><td>' + escapeHtml(presentation.formatNumber(measurement.packet_loss ?? measurement.loss, i18n.t("unit.percent"))) + '</td></tr>').join("") + '</tbody></table></div>' : '<p class="detail-muted">' + escapeHtml(i18n.t("school.metricsUnavailable")) + '</p>';
    const stateView = state.schoolDetailStates.lineID === String(selected.id) ? state.schoolDetailStates : null;
    const states = stateView?.items || [];
    $("#drawerStates").innerHTML = stateView?.state === "loading" ? '<p class="detail-muted" role="status">' + escapeHtml(i18n.t("school.detailLoading")) + '</p>' : states.length ? '<div class="timeline">' + states.map((item) => '<div class="event"><time>' + escapeHtml(presentation.formatDate(item.occurred_at || item.updated_at, true)) + '</time><div><strong>' + escapeHtml(item.connection_state || item.data_state || i18n.t("empty.noData")) + '</strong><p>' + escapeHtml(item.reason || i18n.t("empty.noData")) + '</p></div></div>').join("") + '</div>' : '<div class="empty-state"><strong>' + escapeHtml(i18n.t("field.status")) + '</strong><span>' + escapeHtml(i18n.t("school.notObserved")) + '</span><button type="button" class="secondary-action" data-drawer-load-states>' + escapeHtml(i18n.t("incidents.refresh")) + '</button></div>';
    const devices = (Array.isArray(line.monitoring_points) ? line.monitoring_points.flatMap((point) => Array.isArray(point?.devices) ? point.devices : []) : []);
    const device = devices[0] || { id: line.device_id, hostname: line.hostname, agent_version: line.agent_version, last_seen: line.last_seen };
    $("#drawerDevice").innerHTML = mapFields([[i18n.t("field.device"), device.id || i18n.t("empty.noData")], [i18n.t("admin.identity"), device.display_name || device.hostname || i18n.t("empty.noData")], [i18n.t("audit.version"), device.agent_version || i18n.t("empty.noData")], [i18n.t("audit.lastSeen"), presentation.formatDate(device.last_seen, true)]]) + (devices.length ? '<div class="sectionhead"><h3>' + escapeHtml(i18n.t("admin.monitoringPoint")) + '</h3><span>' + escapeHtml(String(devices.length)) + '</span></div><ul class="memberlist">' + devices.map((item) => '<li class="member"><span><b>' + escapeHtml(item.display_name || item.hostname || item.id) + '</b><small>' + escapeHtml(item.agent_version || i18n.t("empty.noData")) + '</small></span><span>' + escapeHtml(presentation.formatDate(item.last_seen, true)) + '</span></li>').join("") + '</ul>' : "");
  }
  $("#drawerEnrollment").innerHTML = renderEnrollmentPanel(selected, line);
  $("#detailDrawer").querySelectorAll("[data-drawer-panel]").forEach((panel) => { panel.hidden = panel.dataset.drawerPanel !== state.drawerTab; });
  $("#drawerBackdrop").hidden = false;
  $("#detailDrawer").hidden = false;
  $("#detailDrawer").classList.add("open");
  $("#detailDrawer").setAttribute("aria-hidden", "false");
  if (state.drawerTrigger && !state.drawerFocusSet) { $("#detailDrawer")?.focus(); state.drawerFocusSet = true; }
  $("#detailDrawer").querySelectorAll("[data-popup-line-id]").forEach((button) => button.addEventListener("click", async () => {
    state.selectedSchool = selectSchoolLine(state.selectedSchool, button.dataset.popupLineId);
    resetEnrollment();
    renderSchoolDrawer();
    if (state.mapPopupContext) renderPopup(state.mapPopupContext);
    await openSelectedSchoolDetail();
  }));
  $("#detailDrawer").querySelectorAll("[data-drawer-tab]").forEach((button) => button.addEventListener("click", () => {
    state.drawerTab = button.dataset.drawerTab || "summary";
    renderSchoolDrawer();
    if (state.drawerTab === "states") void loadSchoolStates();
  }));
  $("#detailDrawer").querySelector("[data-drawer-load-states]")?.addEventListener("click", loadSchoolStates);
  $("#detailDrawer").querySelector("[data-open-incident-id]")?.addEventListener("click", () => openIncident($("#detailDrawer").querySelector("[data-open-incident-id]").dataset.openIncidentId));
  bindEnrollmentPanel();
}

async function loadSchoolStates() {
  const selected = selectedLine(state.selectedSchool);
  if (!selected || state.schoolDetailStates.state === "loading") return;
  const lineID = String(selected.id);
  if (state.schoolDetailStates.lineID === lineID && state.schoolDetailStates.state === "ready") {
    renderSchoolDrawer();
    return;
  }
  state.schoolDetailStates = { lineID, state: "loading", items: [] };
  renderSchoolDrawer();
  try {
    const response = await lines.states(lineID);
    const items = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
    if (String(selectedLine(state.selectedSchool)?.id) !== lineID) return;
    state.schoolDetailStates = { lineID, state: "ready", items };
  } catch (error) {
    if (String(selectedLine(state.selectedSchool)?.id) !== lineID) return;
    state.schoolDetailStates = { lineID, state: "error", items: [] };
  }
  renderSchoolDrawer();
}

function resetEnrollment() {
  state.enrollment = { open: false, state: "idle", pointID: "", lineID: "", result: null };
}

function activeMonitoringPoints(line) {
  return (Array.isArray(line?.monitoring_points) ? line.monitoring_points : []).filter((point) => point?.id && point.active !== false);
}

function renderEnrollmentPanel(selected, line) {
  if (!selected || !state.capabilities.has("admin.manage")) return "";
  const view = state.enrollment;
  if (!view.open || view.lineID !== String(selected.id)) {
    return '<button type="button" class="secondary-action" data-enrollment-connect>' + escapeHtml(i18n.t("enrollment.connectAgent")) + "</button>";
  }
  const points = activeMonitoringPoints(line);
  const pointID = points.some((point) => String(point.id) === String(view.pointID)) ? view.pointID : points[0]?.id || "";
  const options = points.map((point) => '<option value="' + escapeHtml(String(point.id)) + '"' + (String(point.id) === String(pointID) ? " selected" : "") + ">" + escapeHtml(point.location ? `${point.location} · ${point.id}` : String(point.id)) + "</option>").join("");
  const busy = view.state === "saving";
  const result = view.result;
  const status = view.state === "error"
    ? '<p class="enrollment-status error" role="alert">' + escapeHtml(i18n.t("enrollment.failed")) + "</p>"
    : result
      ? '<p class="enrollment-status" role="status">' + escapeHtml(i18n.t("enrollment.activeUntil", { expiresAt: presentation.formatDate(result.expires_at, true) })) + "</p>"
      : "";
  const code = result?.code
    ? '<div class="enrollment-code"><code>' + escapeHtml(result.code) + '</code><button type="button" class="secondary-action" data-enrollment-copy>' + escapeHtml(i18n.t("admin.copy")) + "</button></div>"
    : "";
  const noPoints = !points.length;
  return '<div class="enrollment-panel"><h3>' + escapeHtml(i18n.t("enrollment.connectAgent")) + "</h3><p>" + escapeHtml(i18n.t("enrollment.selectedLine", { line: selected.id })) + "</p>"
    + (noPoints ? '<p class="enrollment-status error">' + escapeHtml(i18n.t("enrollment.noActivePoint")) + "</p>" : '<label>' + escapeHtml(i18n.t("enrollment.monitoringPoint")) + '<select data-enrollment-point' + (busy ? " disabled" : "") + ">" + options + "</select></label>")
    + '<button type="button" class="primary-action" data-enrollment-generate' + (busy || noPoints ? " disabled" : "") + ">" + escapeHtml(busy ? i18n.t("enrollment.generating") : i18n.t("enrollment.generate")) + "</button>"
    + status + code + "</div>";
}

async function openEnrollmentPanel() {
  const selected = selectedLine(state.selectedSchool);
  if (!selected || !state.capabilities.has("admin.manage")) return;
  let line = state.selectedSchool?.detail || selected;
  if (!Array.isArray(line.monitoring_points)) {
    await openSelectedSchoolDetail();
    line = state.selectedSchool?.detail || selectedLine(state.selectedSchool);
  }
  const points = activeMonitoringPoints(line);
  state.enrollment = { open: true, state: "idle", pointID: String(points[0]?.id || ""), lineID: String(selected.id), result: null };
  renderSchoolDrawer();
}

async function generateEnrollmentCode() {
  const view = state.enrollment;
  const selected = selectedLine(state.selectedSchool);
  if (!selected || view.state === "saving" || !view.pointID || view.lineID !== String(selected.id)) return;
  state.enrollment = { ...view, state: "saving", result: null };
  renderSchoolDrawer();
  try {
    const result = objectPayload(await boundaries.admin.createEnrollmentCode(view.pointID));
    state.enrollment = { ...state.enrollment, state: "success", result };
  } catch (error) {
    state.enrollment = { ...state.enrollment, state: "error", result: null };
  }
  renderSchoolDrawer();
}

async function copyEnrollmentCode() {
  const code = state.enrollment?.result?.code;
  if (!code) return;
  try {
    if (typeof globalThis.navigator?.clipboard?.writeText !== "function") throw new Error("clipboard unavailable");
    await globalThis.navigator.clipboard.writeText(code);
    showToast("admin.copied");
  } catch (error) {
    showToast("admin.copyFailed", "warn");
  }
}

function bindEnrollmentPanel() {
  const panel = $("#drawerEnrollment");
  panel?.querySelector("[data-enrollment-connect]")?.addEventListener("click", openEnrollmentPanel);
  panel?.querySelector("[data-enrollment-point]")?.addEventListener("change", (event) => {
    state.enrollment = { ...state.enrollment, pointID: String(event.target.value), result: null, state: "idle" };
    renderSchoolDrawer();
  });
  panel?.querySelector("[data-enrollment-generate]")?.addEventListener("click", generateEnrollmentCode);
  panel?.querySelector("[data-enrollment-copy]")?.addEventListener("click", copyEnrollmentCode);
}

async function openSelectedSchoolDetail() {
  let selection = state.selectedSchool;
  if (!selection) return;
  const requestID = ++state.drawerRequestID;
  state.drawerTab = "summary";
  state.schoolDetailStates = { lineID: "", state: "idle", items: [] };
  if (!state.drawerTrigger) state.drawerTrigger = state.mapPopupTrigger || (document.activeElement !== document.body ? document.activeElement : null);
  closeMapPopup(false, true);
  const line = selectedLine(selection);
  if (!line) { renderSchoolDrawer(selection); return; }
  selection = { ...selection, detailState: "loading", detail: null };
  state.selectedSchool = selection;
  renderSchoolDrawer(selection);
  try {
    const response = await lines.get(line.id);
    if (state.drawerRequestID !== requestID || $("#detailDrawer")?.hidden) return;
    state.selectedSchool = { ...selection, detail: mergeLineDetail(line, response), detailState: "ready" };
  } catch (error) {
    if (state.drawerRequestID !== requestID || $("#detailDrawer")?.hidden) return;
    state.selectedSchool = { ...selection, detailState: "error" };
  }
  renderSchoolDrawer();
}
async function openLine(id) {
  const line = map.getLine(id);
  if (!line) return;
  if (!state.selectedSchool || !state.selectedSchool.lines.some((item) => item.id === id)) {
    state.selectedSchool = createSelectedSchool({ kind: "monitoring", school: line.registrySchool, lines: [line] }, id);
  } else state.selectedSchool = selectSchoolLine(state.selectedSchool, id);
  await openSelectedSchoolDetail();
}

function objectPayload(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function incidentSurfaceState() { return state.incidents; }

function incidentCreateLines() {
  return (Array.isArray(map.state.lines) ? map.state.lines : []).filter((line) => line?.id);
}

function renderIncidentCreateForm() {
  const view = incidentSurfaceState();
  if (!view.createOpen) return "";
  const linesForCreate = incidentCreateLines();
  if (!linesForCreate.length) {
    return '<section class="incident-create-panel"><div><h2>' + escapeHtml(i18n.t("incidents.createTitle")) + '</h2><p class="surface-state">' + escapeHtml(i18n.t("incidents.createNoLines")) + '</p></div><button class="secondary-action" type="button" data-incident-create-cancel>' + escapeHtml(i18n.t("incidents.createCancel")) + "</button></section>";
  }
  const draft = view.createDraft;
  const lineOptions = linesForCreate.map((line) => {
    const school = line.school_name || line.organization_name || i18n.t("school.noOfficialName");
    const label = `${school} · ${line.name || line.label || line.id}`;
    return '<option value="' + escapeHtml(line.id) + '"' + (String(draft.line_id) === String(line.id) ? " selected" : "") + ">" + escapeHtml(label) + "</option>";
  }).join("");
  const busy = view.createState === "saving";
  const error = view.createError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.createError)) + "</p>" : "";
  return '<section class="incident-create-panel"><div class="incident-create-heading"><div><h2>' + escapeHtml(i18n.t("incidents.createTitle")) + '</h2><p>' + escapeHtml(i18n.t("incidents.subtitle")) + '</p></div><button class="icon-close" type="button" data-incident-create-cancel aria-label="' + escapeHtml(i18n.t("incidents.createCancel")) + '">' + iconMarkup("x", { size: 18 }) + '</button></div><form class="incident-create-form" data-incident-create><label>' + escapeHtml(i18n.t("incidents.createLine")) + '<select name="line_id" required' + (busy ? " disabled" : "") + ">" + lineOptions + '</select></label><label>' + escapeHtml(i18n.t("incidents.createType")) + '<select name="violation_type" required' + (busy ? " disabled" : "") + '><option value="MANUAL_REVIEW"' + (draft.violation_type === "MANUAL_REVIEW" ? " selected" : "") + '>' + escapeHtml(i18n.t("incidentType.MANUAL_REVIEW")) + '</option><option value="NO_INTERNET"' + (draft.violation_type === "NO_INTERNET" ? " selected" : "") + '>' + escapeHtml(i18n.t("incidentType.NO_INTERNET")) + '</option></select></label><label class="incident-create-wide">' + escapeHtml(i18n.t("incidents.createDescription")) + '<textarea name="description" required maxlength="4000"' + (busy ? " disabled" : "") + '>' + escapeHtml(draft.description) + '</textarea></label><label>' + escapeHtml(i18n.t("incidents.createAssignee")) + '<input name="assignee" maxlength="255" placeholder="' + escapeHtml(i18n.t("incidents.createAssigneePlaceholder")) + '" value="' + escapeHtml(draft.assignee) + '"' + (busy ? " disabled" : "") + '></label><div class="incident-create-actions"><button class="secondary-action" type="button" data-incident-create-cancel' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("incidents.createCancel")) + '</button><button class="primary-action" type="submit"' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("incidents.createSubmit")) + '</button></div></form>' + error + '</section>';
}

function renderIncidentsPreservingScroll() {
  const root = $("#incidentsSurface");
  const detail = root?.querySelector(".incident-detail, .template-inspector");
  const surfaceScrollTop = root?.scrollTop || 0;
  const scrollTop = detail?.scrollTop || 0;
  renderIncidentsSurface();
  const nextDetail = root?.querySelector(".incident-detail, .template-inspector");
  if (root) root.scrollTop = surfaceScrollTop;
  if (nextDetail) nextDetail.scrollTop = scrollTop;
}

function renderSituationsSurface() {
  const root = $("#incidentsSurface");
  const view = incidentSurfaceState();
  const query = String(view.situationSearch || "").trim().toLocaleLowerCase();
  const situations = (Array.isArray(view.situations) ? view.situations : []).filter((item) => {
    if (!query) return true;
    const presented = presentSituation(item, { i18n, presentation, capabilities: state.capabilities });
    return [presented.title, presented.typeLabel, presented.severityLabel, item?.district, item?.provider].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  });
  const selected = situations.find((item) => String(item?.id) === String(view.selectedSituationId)) || situations[0];
  const list = situations.length
    ? situations.map((item) => {
      const presented = presentSituation(item, { i18n, presentation, capabilities: state.capabilities, actionState: view.situationActionState });
      const active = String(item?.id) === String(selected?.id);
      return '<button class="listitem situation-row' + (active ? ' selected sel' : '') + '" type="button" data-situation-id="' + escapeHtml(item.id) + '"><span class="incident-signal severity-' + escapeHtml(presented.severity.toLowerCase()) + '">' + iconMarkup("situation", { size: 17 }) + '</span><h3>' + escapeHtml(presented.title) + '</h3><p>' + escapeHtml(presented.typeLabel) + (item?.district ? " · " + escapeHtml(item.district) : "") + '</p><div class="meta"><span class="status-pill severity-' + escapeHtml(presented.severity.toLowerCase()) + '">' + escapeHtml(presented.severityLabel) + '</span><span>' + escapeHtml(i18n.t("situation.members", { count: presented.affectedCount })) + '</span><span class="sep"></span><span>' + escapeHtml(presented.startedLabel) + '</span></div></button>';
    }).join("")
    : '<p class="surface-state">' + escapeHtml(i18n.t("situation.empty")) + "</p>";
  const selectedID = selected?.id;
  const detail = selectedID && String(view.selectedSituationId) === String(selectedID) ? renderSituationDetail() : '<article class="inspector"><div class="empty-state"><strong>' + escapeHtml(i18n.t("incidents.select")) + '</strong><span>' + escapeHtml(i18n.t("situation.contextHint")) + '</span></div></article>';
  root.innerHTML = '<div class="template-screen structural-surface workspace two template-workspace situation-workspace"><section class="pane template-pane situation-list-pane"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.situations")) + '</span><h1>' + escapeHtml(i18n.t("nav.situations")) + '</h1><small>' + escapeHtml(String(situations.length)) + '</small></div><button class="icon-button" type="button" data-incidents-refresh aria-label="' + escapeHtml(i18n.t("incidents.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></header><label class="template-search"><span class="visually-hidden">' + escapeHtml(i18n.t("audit.search")) + '</span><input type="search" data-situation-search value="' + escapeHtml(view.situationSearch || "") + '" placeholder="' + escapeHtml(i18n.t("audit.searchPlaceholder")) + '"></label><div class="list template-list" aria-label="' + escapeHtml(i18n.t("nav.situations")) + '">' + list + '</div></section><section class="inspector template-inspector situation-inspector" aria-live="polite">' + detail + '</section></div>';
  hydrateRenderedControls(root);
  bindIncidentSurfaceEvents(root);
}

function providerCaseMatches(item, filters) {
  const query = String(filters.search || "").trim().toLocaleLowerCase();
  const school = String(filters.school || "");
  const status = String(filters.status || "").toUpperCase();
  const provider = String(filters.provider || "");
  const haystack = [item?.ticket_no, item?.external_ticket_no, item?.organization_name, item?.provider_name, item?.incident_no, item?.line_id, item?.status, item?.delivery_status].filter(Boolean).join(" ").toLocaleLowerCase();
  if (query && !haystack.includes(query)) return false;
  if (school && String(item?.organization_name || item?.school_name || "") !== school) return false;
  if (status && ![item?.delivery_status, item?.status].filter(Boolean).some((value) => String(value).toUpperCase() === status)) return false;
  if (provider && String(item?.provider_name || "") !== provider) return false;
  return true;
}

function renderProviderCaseCreateForm() {
  const view = incidentSurfaceState();
  if (!view.caseCreateOpen) return "";
  const linesForCreate = incidentCreateLines();
  const draft = view.caseCreateDraft;
  const options = linesForCreate.map((line) => '<option value="' + escapeHtml(line.id) + '"' + (String(draft.line_id) === String(line.id) ? " selected" : "") + '>' + escapeHtml((line.school_name || line.organization_name || i18n.t("school.noOfficialName")) + " · " + (line.name || line.label || line.id)) + '</option>').join("");
  const busy = view.caseCreateState === "saving";
  const error = view.caseCreateError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.caseCreateError)) + '</p>' : "";
  return '<section class="inline-workflow case-create-form"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("providerCase.prepare")) + '</h3><button class="icon-button" type="button" data-provider-case-create-cancel aria-label="' + escapeHtml(i18n.t("action.close")) + '">' + iconMarkup("x", { size: 16 }) + '</button></div><form data-provider-case-create><label>' + escapeHtml(i18n.t("field.line")) + '<select name="line_id" required' + (busy ? " disabled" : "") + '>' + options + '</select></label><label>' + escapeHtml(i18n.t("incidents.comment")) + '<textarea name="comment" maxlength="4000" placeholder="' + escapeHtml(i18n.t("providerCase.text")) + '"' + (busy ? " disabled" : "") + '>' + escapeHtml(draft.comment) + '</textarea></label><div class="form-actions"><button class="secondary-action" type="button" data-provider-case-create-cancel' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("action.cancel")) + '</button><button class="primary-action" type="submit"' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("providerCase.prepare")) + '</button></div></form>' + error + '</section>';
}

function renderProviderCasesSurface() {
  const root = $("#incidentsSurface");
  const view = incidentSurfaceState();
  const cases = Array.isArray(view.cases) ? view.cases : [];
  const filters = view.caseFilters;
  const schools = [...new Set(cases.map((item) => item?.organization_name || item?.school_name).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), i18n.locale));
  const providers = [...new Set(cases.map((item) => item?.provider_name).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), i18n.locale));
  const statuses = [...new Set(cases.flatMap((item) => [item?.delivery_status, item?.status]).filter(Boolean))].filter((value, index, values) => values.indexOf(value) === index).sort();
  const filteredCases = cases.filter((item) => providerCaseMatches(item, filters));
  let list;
  if (view.casesState === "loading" || view.casesState === "idle") {
    list = '<p class="surface-state" role="status">' + escapeHtml(i18n.t("providerCase.loading")) + '</p>';
  } else if (view.casesState === "error") {
    list = '<div class="surface-state error" role="alert"><p>' + escapeHtml(i18n.t("providerCase.listUnavailable")) + '</p><button class="secondary-action" type="button" data-provider-cases-refresh>' + escapeHtml(i18n.t("incidents.refresh")) + '</button></div>';
  } else if (!filteredCases.length) {
    list = '<p class="surface-state">' + escapeHtml(i18n.t("providerCase.empty")) + '</p>';
  } else {
    list = filteredCases.map((item) => {
      const presented = presentProviderCase(item, { i18n, presentation });
      const reference = presented.reference || item.id;
      const school = item.organization_name || i18n.t("school.noOfficialName");
      const provider = item.provider_name || i18n.t("empty.value");
      const context = item.incident_no || (item.incident_id ? i18n.t("incidents.number") + " #" + item.incident_id : i18n.t("field.line") + " " + (item.line_id || i18n.t("empty.value")));
      return '<button class="listitem case-row' + (String(view.providerCase.selectedId) === String(item.id) ? ' selected sel' : '') + '" type="button" data-provider-case-id="' + escapeHtml(item.id) + '"><span class="case-row-icon">' + iconMarkup("case", { size: 18 }) + '</span><h3>' + escapeHtml(i18n.t("providerCase.title", { reference })) + '</h3><p>' + escapeHtml(school + " · " + provider) + '</p><div class="meta"><span class="status-pill provider-case-delivery">' + escapeHtml(presented.deliveryLabel) + '</span><span>' + escapeHtml(context) + '</span><span class="sep"></span><span>' + escapeHtml(presentation.formatDate(item.updated_at || item.created_at, true)) + '</span></div></button>';
    }).join("");
  }
  const detail = view.providerCase.selectedId
    ? renderSelectedProviderCase()
    : '<article class="inspector"><div class="empty-state"><strong>' + escapeHtml(i18n.t("nav.cases")) + '</strong><span>' + escapeHtml(i18n.t("incidents.select")) + '</span><small>' + escapeHtml(i18n.t("providerCase.steps")) + '</small></div></article>';
  const filterBar = '<div class="case-filterbar"><label class="template-search"><span class="visually-hidden">' + escapeHtml(i18n.t("audit.search")) + '</span><input type="search" data-case-search value="' + escapeHtml(filters.search) + '" placeholder="' + escapeHtml(i18n.t("audit.searchPlaceholder")) + '"></label><select aria-label="' + escapeHtml(i18n.t("field.school")) + '" data-case-filter="school"><option value="">' + escapeHtml(i18n.t("reports.allSchools")) + '</option>' + schools.map((school) => '<option value="' + escapeHtml(school) + '"' + (filters.school === school ? " selected" : "") + '>' + escapeHtml(school) + '</option>').join("") + '</select><select aria-label="' + escapeHtml(i18n.t("field.provider")) + '" data-case-filter="provider"><option value="">' + escapeHtml(i18n.t("reports.allProviders")) + '</option>' + providers.map((provider) => '<option value="' + escapeHtml(provider) + '"' + (filters.provider === provider ? " selected" : "") + '>' + escapeHtml(provider) + '</option>').join("") + '</select><select aria-label="' + escapeHtml(i18n.t("field.status")) + '" data-case-filter="status"><option value="">' + escapeHtml(i18n.t("incidents.anyStatus")) + '</option>' + statuses.map((status) => '<option value="' + escapeHtml(status) + '"' + (filters.status === status ? " selected" : "") + '>' + escapeHtml(presentation.deliveryStatus(status)) + '</option>').join("") + '</select></div>';
  const canCreate = state.capabilities.has("provider_case.draft");
  root.innerHTML = '<div class="template-screen structural-surface workspace two template-workspace case-workspace"><section class="pane template-pane case-list-pane"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.cases")) + '</span><h1>' + escapeHtml(i18n.t("nav.cases")) + '</h1><small>' + escapeHtml(i18n.t("incidents.count", { count: filteredCases.length })) + '</small></div><div class="panehead-actions">' + (canCreate ? '<button class="icon-button primary" type="button" data-provider-case-create-open aria-label="' + escapeHtml(i18n.t("providerCase.prepare")) + '">' + iconMarkup("plus", { size: 17 }) + '</button>' : '') + '<button class="icon-button" type="button" data-provider-cases-refresh aria-label="' + escapeHtml(i18n.t("incidents.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></div></header>' + filterBar + renderProviderCaseCreateForm() + '<div class="list template-list" aria-label="' + escapeHtml(i18n.t("nav.cases")) + '">' + list + '</div></section><section class="inspector template-inspector case-inspector" aria-live="polite">' + detail + '</section></div>';
  hydrateRenderedControls(root);
  bindIncidentSurfaceEvents(root);
}

function renderIncidentsSurface() {
  const root = $("#incidentsSurface");
  if (!root) return;
  const view = incidentSurfaceState();
  const route = router.getState().view;
  const active = ["incidents", "situations", "cases"].includes(route);
  root.hidden = !active;
  if (!active) return;
  if (route === "cases") {
    renderProviderCasesSurface();
    return;
  }
  if (route === "situations" && view.state === "ready" && !view.selectedSituationId && view.situations[0]?.id) void selectSituation(view.situations[0].id);
  if (route === "situations" && view.state === "ready") {
    renderSituationsSurface();
    return;
  }
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="template-screen structural-surface workspace two template-workspace incident-workspace"><section class="pane template-pane"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.incidents")) + '</span><h1>' + escapeHtml(i18n.t("incidents.title")) + '</h1></div></header><p class="surface-state" role="status">' + escapeHtml(i18n.t("incidents.loading")) + '</p></section><section class="inspector template-inspector"></section></div>';
    return;
  }
  if (view.state === "error") {
    root.innerHTML = '<div class="template-screen structural-surface workspace two template-workspace incident-workspace"><section class="pane template-pane"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.incidents")) + '</span><h1>' + escapeHtml(i18n.t("incidents.title")) + '</h1></div><button class="icon-button" type="button" data-incidents-refresh aria-label="' + escapeHtml(i18n.t("incidents.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></header><p class="surface-state error" role="alert">' + escapeHtml(i18n.t("incidents.unavailable")) + '</p></section><section class="inspector template-inspector"></section></div>';
    hydrateRenderedControls(root);
    bindIncidentSurfaceEvents(root);
    return;
  }

  const statuses = incidentStatusValues(view.items);
  const severities = incidentSeverityValues(view.items);
  if (!statuses.includes(view.filters.status)) view.filters.status = "";
  if (!severities.includes(view.filters.severity)) view.filters.severity = "";
  const items = filterIncidents(view.items, view.filters);
  const statusButtons = ["", "NEW", "IN_PROGRESS", "CLOSED"].map((status) => '<button type="button" class="' + (view.filters.status === status ? "on" : "") + '" data-incident-filter-button="' + escapeHtml(status) + '">' + escapeHtml(status ? presentation.incidentStatus(status) : i18n.t("incidents.anyStatus")) + '</button>').join("");
  const filters = '<div class="segmented template-segmented" role="group" aria-label="' + escapeHtml(i18n.t("incidents.filterStatus")) + '">' + statusButtons + '</div><label class="compact-filter">' + escapeHtml(i18n.t("incidents.filterSeverity")) + '<select data-incident-filter="severity"><option value="">' + escapeHtml(i18n.t("incidents.anySeverity")) + "</option>" + severities.map((severity) => '<option value="' + escapeHtml(severity) + '"' + (view.filters.severity === severity ? " selected" : "") + ">" + escapeHtml(i18n.has("severity." + severity) ? i18n.t("severity." + severity) : i18n.t("severity.UNKNOWN")) + "</option>").join("") + "</select></label>";
  const list = items.length ? items.map((item) => {
    const incident = presentIncident(item, { i18n, presentation });
    return '<button class="listitem incident-item' + (String(view.selectedId) === String(incident.id) ? " selected sel" : "") + '" type="button" data-incident-id="' + escapeHtml(incident.id) + '"><span class="incident-signal severity-' + escapeHtml(incident.severity.toLowerCase()) + '">' + iconMarkup("incident", { size: 18 }) + '</span><h3>' + escapeHtml(incident.school) + ' · ' + escapeHtml(incident.typeLabel) + '</h3><p>' + escapeHtml(incident.description || incident.typeLabel) + '</p><div class="meta"><span class="status-pill severity-' + escapeHtml(incident.severity.toLowerCase()) + '">' + escapeHtml(incident.statusLabel) + '</span><span>' + escapeHtml(incident.line) + '</span><span class="sep"></span><span>' + escapeHtml(incident.startedLabel) + '</span><span class="sep"></span><span>' + escapeHtml(incident.lastUpdateLabel) + '</span></div></button>';
  }).join("") : '<p class="surface-state">' + escapeHtml(i18n.t("incidents.empty")) + "</p>";

  const canCreate = state.capabilities.has("incident.create");
  root.innerHTML = '<div class="template-screen structural-surface workspace two template-workspace incident-workspace"><section class="pane template-pane incident-list-pane"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.incidents")) + '</span><h1>' + escapeHtml(i18n.t("incidents.title")) + '</h1><small>' + escapeHtml(i18n.t("incidents.count", { count: items.length })) + '</small></div><div class="panehead-actions">' + (canCreate ? '<button class="icon-button primary" type="button" data-incident-create-open aria-label="' + escapeHtml(i18n.t("incidents.create")) + '">' + iconMarkup("plus", { size: 17 }) + '</button>' : "") + '<button class="icon-button" type="button" data-incidents-refresh aria-label="' + escapeHtml(i18n.t("incidents.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></div></header><p class="pane-subtitle">' + escapeHtml(i18n.t("incidents.subtitle")) + '</p><div class="incident-filters template-filterbar">' + filters + '</div>' + renderIncidentCreateForm() + '<div class="list template-list" aria-label="' + escapeHtml(i18n.t("incidents.title")) + '">' + list + '</div></section><section class="inspector template-inspector incident-inspector" aria-live="polite">' + renderIncidentDetail() + '</section></div>';
  hydrateRenderedControls(root);
  bindIncidentSurfaceEvents(root);
}

function reportSurfaceState() { return state.reports; }

function reportAvailability(value, locale, diagnostics = null, field = "") {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return i18n.t("reports.valueUnavailable");
  const number = Number(value);
  if (!Number.isFinite(number)) {
    (diagnostics || state.reportDiagnostics)?.push({ field, value });
    return i18n.t("reports.valueUnavailable");
  }
  return formatReportAvailability(number, locale);
}

function reportNumber(value, suffix = "", diagnostics = null, field = "") {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return i18n.t("reports.valueUnavailable");
  const number = Number(value);
  if (!Number.isFinite(number)) {
    (diagnostics || state.reportDiagnostics)?.push({ field, value });
    return i18n.t("reports.valueUnavailable");
  }
  return presentation.formatNumber(number, suffix);
}

function reportPercentage(value, diagnostics, field) {
  return reportAvailability(value, i18n, diagnostics, field);
}

const REPORT_COLUMN_LABELS = Object.freeze({
  observed_at: "field.lastObserved", received_at: "field.receivedAt", line_id: "field.line", school_id: "field.school",
  organization_name: "field.school", district: "field.district", provider: "field.provider", device_id: "field.device",
  device_display_name: "field.device", monitoring_point_id: "admin.monitoringPoint", monitoring_point_location: "field.address",
  mode: "field.measurementType", connection_status: "field.status", download: "field.download", upload: "field.upload",
  ping: "field.ping", jitter: "field.jitter", packet_loss: "field.loss", availability: "reports.availability",
  availability_status: "reports.availabilityStatus", baseline_state: "reports.baseline", contract_state: "reports.contract",
  reason: "field.problemReason",
});

function reportColumnLabels(columns) {
  return (Array.isArray(columns) ? columns : []).map((column) => {
    const key = REPORT_COLUMN_LABELS[String(column || "")];
    return key && i18n.has(key) ? i18n.t(key) : i18n.t("reports.additionalField");
  });
}

function reportTechnicalDetails(diagnostics) {
  // Diagnostics are useful for logs and support, but raw field dumps do not
  // help an operator decide what to do in the report workspace.
  return "";
}

function reportOptions(items, selected, label, value = (item) => item) {
  return ['<option value="">' + escapeHtml(label) + "</option>"].concat(items.map((item) => {
    const itemValue = value(item);
    return '<option value="' + escapeHtml(itemValue) + '"' + (String(itemValue) === String(selected) ? " selected" : "") + ">" + escapeHtml(typeof item === "object" ? item.name : item) + "</option>";
  })).join("");
}

function renderReportTable(title, headers, rows) {
  if (!rows.length) return '<section class="report-panel"><h2>' + escapeHtml(title) + '</h2><p class="surface-state">' + escapeHtml(i18n.t("reports.empty")) + "</p></section>";
  return '<section class="report-panel report-table-wrap"><h2>' + escapeHtml(title) + '</h2><table class="report-table"><thead><tr>' + headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((row) => "<tr>" + row.map((value) => "<td>" + escapeHtml(value) + "</td>").join("") + "</tr>").join("") + "</tbody></table></section>";
}

function renderReportFacts(rows) {
  return '<dl class="report-grid">' + rows.map(([label, value]) => '<div><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd></div>').join("") + "</dl>";
}

function reportDynamicsLabel(status) {
  const key = { AVAILABLE: "reports.dynamicsAvailable", INSUFFICIENT_DATA: "reports.dynamicsInsufficient", INCOMPARABLE: "reports.dynamicsIncomparable", NO_DATA: "reports.dynamicsNoData" }[String(status || "").toUpperCase()];
  return key ? i18n.t(key) : i18n.t("reports.valueUnavailable");
}

function reportAvailabilityStateLabel(value) {
  const code = String(value || "").toUpperCase();
  if (code === "AVAILABLE" || code === "OK") return i18n.t("reports.availabilityAvailable");
  if (code === "NO_DATA" || code === "UNKNOWN") return i18n.t("reports.availabilityNoDataState");
  return code ? presentation.status(code).label : i18n.t("reports.valueUnavailable");
}

function renderReportsSurface() {
  const root = $("#reportsSurface");
  if (!root) return;
  const view = reportSurfaceState();
  const active = router.getState().view === "reports";
  root.hidden = !active;
  if (!active) return;
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="template-screen structural-surface workspace split template-workspace reports-workspace"><aside class="pane report-query-pane"><h1>' + escapeHtml(i18n.t("reports.title")) + '</h1><p class="surface-state" role="status">' + escapeHtml(i18n.t("reports.loading")) + '</p></aside><main class="inspector report-stage"></main></div>';
    return;
  }
  const options = reportFilterOptions(map.state.lines);
  const filters = view.filters;
  const form = '<form class="report-filters" data-report-filters><label>' + escapeHtml(i18n.t("reports.from")) + '<input name="from" type="date" required value="' + escapeHtml(filters.from) + '"></label><label>' + escapeHtml(i18n.t("reports.to")) + '<input name="to" type="date" required value="' + escapeHtml(filters.to) + '"></label><label>' + escapeHtml(i18n.t("reports.region")) + '<select name="district">' + reportOptions(options.districts, filters.district, i18n.t("reports.allRegions")) + '</select></label><label>' + escapeHtml(i18n.t("field.provider")) + '<select name="provider">' + reportOptions(options.providers, filters.provider, i18n.t("reports.allProviders")) + '</select></label><label>' + escapeHtml(i18n.t("field.line")) + '<select name="line_id">' + reportOptions(options.lines, filters.line_id, i18n.t("reports.allLines")) + '</select></label><label>' + escapeHtml(i18n.t("field.school")) + '<select name="school_id">' + reportOptions(options.schools, filters.school_id, i18n.t("reports.allSchools"), (school) => school.id) + '</select></label><button class="secondary-action" type="submit">' + escapeHtml(i18n.t("reports.apply")) + '</button><button class="secondary-action" type="button" data-reports-refresh>' + escapeHtml(i18n.t("reports.refresh")) + "</button></form>";
  const aggregate = view.aggregate;
  const analytics = view.analytics;
  const passport = view.passport;
  const reportDiagnostics = state.reportDiagnostics = [];
  const aggregateMessage = view.aggregateState === "error" ? i18n.t("reports.unavailable") : reportState(aggregate, i18n);
  const aggregatePanel = aggregateMessage ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.measurements")) + '</h2><p class="surface-state' + (view.aggregateState === "error" ? " error" : "") + '">' + escapeHtml(aggregateMessage) + "</p></section>" : '<section class="report-panel report-measures"><h2>' + escapeHtml(i18n.t("reports.measurements")) + '</h2><dl class="report-grid"><div><dt>' + escapeHtml(i18n.t("reports.measurements")) + "</dt><dd>" + escapeHtml(reportNumber(aggregate.measurement_count)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.availability")) + "</dt><dd>" + escapeHtml(reportAvailability(aggregate.availability_pct, i18n)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.completeness")) + "</dt><dd>" + escapeHtml(reportAvailability(aggregate.data_completeness_pct, i18n)) + "</dd></div></dl><p class=\"report-note\">" + escapeHtml(i18n.t("reports.historicalOnly")) + "</p></section>";
  const trendRows = Array.isArray(analytics?.trend) ? analytics.trend.map((item) => [item.key, reportNumber(item.measurements, "", reportDiagnostics, "analytics.trend.measurements"), reportNumber(item.valid_evidence, "", reportDiagnostics, "analytics.trend.valid_evidence"), reportPercentage(item.average_availability, reportDiagnostics, "analytics.trend.average_availability")]) : [];
  const rankingRows = Array.isArray(analytics?.ranking) ? analytics.ranking.map((item) => [item.line_id || i18n.t("empty.value"), reportNumber(item.measurements, "", reportDiagnostics, "analytics.ranking.measurements"), reportNumber(item.valid_evidence, "", reportDiagnostics, "analytics.ranking.valid_evidence"), reportPercentage(item.contract_compliance, reportDiagnostics, "analytics.ranking.contract_compliance")]) : [];
  const analyticsPanel = view.analyticsState === "error" ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.analytics")) + '</h2><p class="surface-state error">' + escapeHtml(i18n.t("reports.unavailable")) + "</p></section>" : '<div class="report-tables">' + renderReportTable(i18n.t("reports.trend"), [i18n.t("reports.to"), i18n.t("reports.measurements"), i18n.t("reports.evidence"), i18n.t("reports.availability")], trendRows) + renderReportTable(i18n.t("reports.ranking"), [i18n.t("field.line"), i18n.t("reports.measurements"), i18n.t("reports.evidence"), i18n.t("reports.contract")], rankingRows) + "</div>";
  const evidence = reportEvidenceSummary(passport, { i18n, presentation });
  const passportIncident = passport?.incidents || {};
  const availabilityPeriod = passport?.availability_period || {};
  const passportDynamics = passport?.dynamics || {};
  const passportRows = [
    [i18n.t("reports.measurementsReceived"), reportNumber(passport?.measurements_received)],
    [i18n.t("reports.measurementsExpected"), reportNumber(passport?.measurements_expected)],
    [i18n.t("reports.completeness"), reportAvailability(passport?.data_completeness_pct, i18n)],
    [i18n.t("reports.baseline"), reportAvailability(passport?.baseline_compliance, i18n)],
    [i18n.t("reports.contract"), reportAvailability(passport?.contract_compliance, i18n)],
    [i18n.t("reports.availability"), reportAvailability(passport?.availability_pct, i18n)],
    [i18n.t("reports.availabilityThreshold"), reportAvailability(passport?.availability_threshold, i18n)],
    [i18n.t("reports.availabilityState"), reportAvailabilityStateLabel(passport?.availability_status)],
    [i18n.t("reports.availabilityObserved"), reportNumber(passport?.observed_duration_minutes, i18n.t("reports.minutes"))],
    [i18n.t("reports.availabilityUnavailable"), reportNumber(passport?.unavailable_duration_minutes, i18n.t("reports.minutes"))],
    [i18n.t("reports.availabilityNoData"), reportNumber(passport?.no_data_duration_minutes, i18n.t("reports.minutes"))],
    [i18n.t("reports.availabilityValid"), reportNumber(passport?.availability_valid_count ?? availabilityPeriod.valid_count)],
    [i18n.t("reports.availabilityInvalid"), reportNumber(passport?.availability_invalid_count ?? availabilityPeriod.invalid_count)],
    [i18n.t("reports.availabilityUnknown"), reportNumber(passport?.availability_unknown_count ?? availabilityPeriod.unknown_count)],
    [i18n.t("reports.incidents"), reportNumber(passportIncident.count)],
    [i18n.t("reports.incidentsDuration"), reportNumber(passportIncident.total_duration_minutes, i18n.t("reports.minutes"))],
    [i18n.t("reports.incidentsRecurrence"), reportNumber(passportIncident.recurrence_count)],
    [i18n.t("reports.incidentsRecovery"), reportNumber(passportIncident.confirmed_recovery_count)],
    [i18n.t("reports.sufficientData"), passport?.sufficient_data == null ? i18n.t("reports.valueUnavailable") : i18n.t(passport.sufficient_data ? "reports.yes" : "reports.no")],
  ];
  const dynamicsRows = [[i18n.t("reports.dynamicsStatus"), reportDynamicsLabel(passportDynamics.status)]];
  if (passportDynamics.current) dynamicsRows.push([i18n.t("reports.availability") + " · " + i18n.t("reports.current"), reportAvailability(passportDynamics.current.availability_pct, i18n)]);
  if (passportDynamics.previous) dynamicsRows.push([i18n.t("reports.availability") + " · " + i18n.t("reports.previous"), reportAvailability(passportDynamics.previous.availability_pct, i18n)]);
  if (passportDynamics.delta?.availability_pct !== undefined) dynamicsRows.push([i18n.t("reports.availability") + " · Δ", reportAvailability(passportDynamics.delta.availability_pct, i18n)]);
  const passportPanel = view.passportState === "error" ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.quality")) + '</h2><p class="surface-state error">' + escapeHtml(i18n.t("reports.unavailable")) + "</p></section>" : '<section class="report-panel report-passport"><h2>' + escapeHtml(i18n.t("reports.quality")) + '</h2>' + renderReportFacts(passportRows) + '<p class="report-note">' + escapeHtml(i18n.t("reports.historicalOnly")) + '</p><section class="report-subpanel"><h3>' + escapeHtml(i18n.t("reports.dynamics")) + '</h3>' + renderReportFacts(dynamicsRows) + '</section></section>';
  const evidencePanel = '<section class="report-panel evidence-stage"><h2>' + escapeHtml(i18n.t("reports.confirmation")) + '</h2>' + renderReportFacts([[i18n.t("reports.evidenceCount"), reportNumber(evidence.count)], [i18n.t("reports.evidenceProvenance"), evidence.provenance], [i18n.t("reports.lastVerified"), evidence.lastVerified]]) + '<p class="report-note">' + escapeHtml(i18n.t("reports.evidenceHtmlOnly")) + '</p><div class="report-evidence-action"><button class="secondary-action" type="button" data-evidence-preview>' + escapeHtml(i18n.t("reports.evidencePreview")) + '</button></div></section>';
  const canExport = state.capabilities.has("report.export");
  const preview = view.preview;
  const previewText = view.previewState === "error" ? i18n.t("reports.previewUnavailable") : preview ? i18n.t(preview.limited ? "reports.previewLimited" : "reports.previewRows", { count: preview.count }) : "";
  const exportPanel = '<section class="report-panel report-export"><h2>' + escapeHtml(i18n.t("reports.export")) + (canExport ? "</h2><form data-report-export><label>" + escapeHtml(i18n.t("reports.exportKind")) + '<select name="kind"><option value="raw">' + escapeHtml(i18n.t("reports.exportRaw")) + '</option><option value="aggregate">' + escapeHtml(i18n.t("reports.exportAggregate")) + '</select></label><label>' + escapeHtml(i18n.t("reports.exportFormat")) + '<select name="format"><option value="csv">CSV</option><option value="xlsx">XLSX</option><option value="json">JSON</option></select></label><button class="secondary-action" type="button" data-export-preview>' + escapeHtml(i18n.t("reports.preview")) + '</button><button class="primary-action" type="submit">' + escapeHtml(i18n.t("reports.download")) + "</button></form>" + (previewText ? '<p class="surface-state' + (view.previewState === "error" ? " error" : "") + '">' + escapeHtml(previewText) + (preview?.columns?.length ? " " + escapeHtml(i18n.t("reports.previewColumns")) + ": " + escapeHtml(reportColumnLabels(preview.columns).join(", ")) : "") + "</p>" : "") : '</h2><p class="surface-state">' + escapeHtml(i18n.t("reports.exportUnavailable")) + "</p>") + "</section>";
  const stage = '<div class="report-unified-stage"><div class="report-overview">' + aggregatePanel + '</div>' + analyticsPanel + passportPanel + evidencePanel + exportPanel + '</div>';
  reportTechnicalDetails(reportDiagnostics);
  root.innerHTML = '<div class="template-screen structural-surface workspace split template-workspace reports-workspace"><aside class="pane report-query-pane"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.reports")) + '</span><h1>' + escapeHtml(i18n.t("reports.title")) + '</h1><small>' + escapeHtml(i18n.t("reports.subtitle")) + '</small></div><button class="icon-button" type="button" data-reports-refresh aria-label="' + escapeHtml(i18n.t("reports.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></header>' + form + '</aside><main class="inspector report-stage" aria-live="polite">' + stage + '</main></div>';
  bindReportSurfaceEvents(root);
}

function reportSelectionContext() {
  return { line: selectedLine(state.selectedSchool), incident: state.incidents.detail };
}

async function loadReports({ force = false } = {}) {
  const view = reportSurfaceState();
  if (!session.authenticated || !state.capabilities.canRead("report")) return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "idle") view.filters = reportContextFilters(view.filters, reportSelectionContext());
  if (view.state === "ready" && !force) { renderReportsSurface(); return; }
  const request = reportQuery(view.filters);
  if (request.error) { view.state = "ready"; view.aggregateState = view.analyticsState = view.passportState = "error"; renderReportsSurface(); return; }
  view.state = "loading";
  renderReportsSurface();
  view.loadPromise = Promise.allSettled([reports.aggregate(request.query), reports.analytics(request.query), reports.qualityPassport(request.query)]).then(([aggregate, analytics, passport]) => {
    view.aggregateState = aggregate.status === "fulfilled" ? "ready" : "error";
    view.analyticsState = analytics.status === "fulfilled" ? "ready" : "error";
    view.passportState = passport.status === "fulfilled" ? "ready" : "error";
    view.aggregate = aggregate.status === "fulfilled" ? objectPayload(aggregate.value) : null;
    view.analytics = analytics.status === "fulfilled" ? objectPayload(analytics.value) : null;
    view.passport = passport.status === "fulfilled" ? objectPayload(passport.value) : null;
    view.state = "ready";
    renderReportsSurface();
  }).finally(() => { view.loadPromise = null; });
  return view.loadPromise;
}

function reportExportQuery(form) {
  const request = reportQuery(reportSurfaceState().filters);
  if (request.error) return request;
  const query = new URLSearchParams(request.query);
  query.set("kind", form.elements.kind.value);
  query.set("format", form.elements.format.value);
  return { error: null, query: query.toString() };
}

async function previewReportExport(root) {
  const form = root.querySelector("[data-report-export]");
  if (!form || !state.capabilities.has("report.export")) return;
  const request = reportExportQuery(form);
  if (request.error) { reportSurfaceState().previewState = "error"; renderReportsSurface(); return; }
  reportSurfaceState().previewState = "loading";
  try { reportSurfaceState().preview = objectPayload(await reports.exportPreview(request.query)); reportSurfaceState().previewState = "ready"; }
  catch (error) { reportSurfaceState().preview = null; reportSurfaceState().previewState = "error"; }
  renderReportsSurface();
}

async function downloadReportExport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const request = reportExportQuery(form);
  if (request.error || !state.capabilities.has("report.export")) return;
  const filename = `linkwatch-report.${form.elements.format.value}`;
  try { await triggerDownload(await reports.exportData(request.query), filename); }
  catch (error) { showToast("reports.exportFailed", "warn"); }
}

async function triggerDownload(response, filename) {
  const blob = await response.blob();
  const urlAPI = globalThis.URL;
  if (!urlAPI || typeof urlAPI.createObjectURL !== "function") throw new Error("Browser does not support file downloads");
  const url = urlAPI.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.setAttribute("aria-hidden", "true");
  anchor.style.position = "fixed";
  anchor.style.left = "-10000px";
  (document.body || document.documentElement).appendChild(anchor);
  anchor.click();
  globalThis.setTimeout(() => {
    anchor.remove();
    urlAPI.revokeObjectURL?.(url);
  }, 1_000);
}

async function previewEvidenceReport() {
  const request = reportQuery(reportSurfaceState().filters);
  if (request.error) return;
  try {
    const blob = await (await reports.evidenceReport(request.query)).blob();
    const url = URL.createObjectURL(blob);
    const preview = globalThis.open?.(url, "_blank", "noopener");
    if (!preview) showToast("reports.exportFailed", "warn");
  } catch (error) { showToast("reports.exportFailed", "warn"); }
}

function bindReportSurfaceEvents(root) {
  root.querySelectorAll("[data-report-type]").forEach((button) => button.addEventListener("click", () => {
    reportSurfaceState().reportType = button.dataset.reportType || "aggregate";
    renderReportsSurface();
  }));
  root.querySelector("[data-report-filters]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    reportSurfaceState().filters = Object.fromEntries(new FormData(form));
    reportSurfaceState().preview = null;
    reportSurfaceState().previewState = "idle";
    loadReports({ force: true });
  });
  root.querySelector("[data-reports-refresh]")?.addEventListener("click", () => loadReports({ force: true }));
  root.querySelector("[data-export-preview]")?.addEventListener("click", () => previewReportExport(root));
  root.querySelector("[data-report-export]")?.addEventListener("submit", downloadReportExport);
  root.querySelector("[data-evidence-preview]")?.addEventListener("click", previewEvidenceReport);
}

function notificationCloseLabel() {
  return i18n.t("notification.close");
}

function notificationDispatchLabel() {
  return actionCopy("notificationDispatch");
}

function renderNotificationButton() {
  const button = $("#notificationsButton");
  if (!button) return;
  const view = state.notifications;
  const summary = notificationSummary(view.items, view.seenIDs);
  const count = summary.unseen.length;
  button.replaceChildren();
  button.insertAdjacentHTML("beforeend", iconMarkup("bell", { size: 18 }));
  if (count > 0) {
    const indicator = document.createElement("span");
    indicator.className = "notification-indicator";
    indicator.textContent = count > 99 ? "99+" : String(count);
    indicator.setAttribute("aria-hidden", "true");
    button.appendChild(indicator);
  }
  button.dataset.notificationUnseenCount = String(count);
  button.dataset.notificationState = count > 0 ? "new" : "idle";
  const label = i18n.t("notification.open");
  button.setAttribute("aria-label", count > 0 ? `${label}. ${i18n.t("notification.new", { count })}` : label);
  button.setAttribute("title", count > 0 ? `${label}. ${i18n.t("notification.new", { count })}` : label);
}

function notificationHeader(view, withRefresh = false) {
  const refresh = withRefresh ? '<button type="button" class="secondary-action utility-refresh" data-notifications-refresh>' + escapeHtml(i18n.t("notification.refresh")) + "</button>" : "";
  return '<header class="utility-header"><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><div>' + refresh + '<button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(notificationCloseLabel()) + '">' + iconMarkup("x", { size: 18 }) + '</button></div></header>';
}

function ingestNotifications(items) {
  const view = state.notifications;
  const nextItems = Array.isArray(items) ? items : [];
  const summary = notificationSummary(nextItems, view.seenIDs);
  const fresh = view.baselineInitialized
    ? summary.unseen.filter((item) => !view.knownIDs.has(notificationKey(item)))
    : [];
  nextItems.map(notificationKey).filter(Boolean).forEach((id) => view.knownIDs.add(id));
  view.items = nextItems;
  view.baselineInitialized = true;
  if (fresh.length > 0) {
    const latest = presentNotification(fresh[0], { i18n, presentation });
    showToast("notification.newToast", "notification", { message: latest.message });
  }
  if (view.open) markNotificationsSeen(nextItems);
}

function renderNotificationsState(root, view, stateName) {
  const loading = stateName === "loading";
  const message = i18n.t(loading ? "notification.loading" : "notification.unavailable");
  const action = loading ? "" : '<button type="button" class="primary-action" data-notifications-retry>' + escapeHtml(i18n.t("notification.refresh")) + "</button>";
  root.innerHTML = '<div class="notification-popover notification-workspace"><header class="utility-header"><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><div><button type="button" class="secondary-action utility-refresh" data-notifications-refresh>' + escapeHtml(i18n.t("notification.refresh")) + '</button><button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(notificationCloseLabel()) + '">' + iconMarkup("x", { size: 18 }) + '</button></div></header><div class="notification-list-pane"><div class="list template-list"><div class="surface-state' + (loading ? "" : " error") + '" role="status"><strong>' + escapeHtml(message) + '</strong>' + (loading ? "" : '<span>' + escapeHtml(i18n.t("notification.tryAgain")) + '</span>') + action + '</div></div></div></div>';
  root.querySelector("[data-notifications-close]")?.addEventListener("click", closeNotifications);
  root.querySelector("[data-notifications-refresh]")?.addEventListener("click", () => loadNotifications({ force: true }));
  root.querySelector("[data-notifications-retry]")?.addEventListener("click", () => loadNotifications({ force: true }));
}

function renderNotificationsSurface() {
  const root = $("#notificationsSurface");
  const button = $("#notificationsButton");
  const view = state.notifications;
  const allowed = state.capabilities.has("notification.read");
  if (button) {
    button.hidden = !allowed;
    button.setAttribute("aria-expanded", String(Boolean(allowed && view.open)));
  }
  renderNotificationButton();
  if (!root) return;
  root.hidden = !allowed || !view.open;
  if (!allowed || !view.open) return;
  if (view.state === "idle" || view.state === "loading") {
    renderNotificationsState(root, view, "loading");
    return;
  }
  if (view.state === "error") {
    renderNotificationsState(root, view, "error");
    return;
  }
  const availableStatuses = ["", ...new Set(["SENT", "PENDING", "FAILED", "GENERATED", "DELIVERING", "DELIVERY_FAILED", ...view.items.flatMap((item) => [item?.delivery_status, item?.status]).filter(Boolean).map((value) => String(value).toUpperCase())])];
  const filteredItems = view.items.filter((item) => !view.filterStatus || String(item?.delivery_status || item?.status || "").toUpperCase() === view.filterStatus);
  const rows = filteredItems.map((item) => {
    const notification = presentNotification(item, { i18n, presentation, capabilities: state.capabilities });
    const availableNotification = presentNotification(item, { i18n, presentation, capabilities: state.capabilities });
    const pending = view.actionState !== "idle" && String(view.actionId) === String(item?.id);
    const notificationMeta = '<span>' + escapeHtml(i18n.t("notification.channel")) + ': ' + escapeHtml(notification.channelLabel) + '</span><span>' + escapeHtml(i18n.t("notification.recipient")) + ': ' + escapeHtml(notification.recipientLabel) + '</span><span class="status-pill notification-delivery">' + escapeHtml(notification.deliveryLabel) + '</span><span>' + escapeHtml(notification.generatedLabel) + '</span>';
    const openIncident = notification.incidentId && state.capabilities.canRead("incident")
      ? '<button type="button" class="notification-open" data-notification-incident="' + escapeHtml(notification.incidentId) + '"><span class="notification-open-copy"><h3>' + escapeHtml(notification.sourceLabel) + '</h3><p>' + escapeHtml(notification.message) + '</p><span class="meta">' + notificationMeta + '</span></span></button>'
      : '<div class="notification-open notification-open-static"><span class="notification-open-copy"><h3>' + escapeHtml(notification.sourceLabel) + '</h3><p>' + escapeHtml(notification.message) + '</p><span class="meta">' + notificationMeta + '</span></span></div>';
    const dispatch = availableNotification.actions?.canDispatch && notification.id != null
      ? '<button type="button" class="secondary-action" data-notification-dispatch="' + escapeHtml(notification.id) + '"' + (pending ? " disabled" : "") + '>' + escapeHtml(notificationDispatchLabel()) + '</button>'
      : "";
    const actionError = String(view.actionErrorId) === String(item?.id) && view.actionError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.actionError)) + '</p>' : "";
    return '<article class="listitem notification-listitem" data-server-read="' + String(notificationIsServerRead(item)) + '"><span class="noticeicon">' + iconMarkup(notification.sourceLabel === i18n.t("field.providerCase") ? "case" : "bell", { size: 17 }) + '</span>' + openIncident + (dispatch || actionError ? '<div class="notification-row-actions">' + dispatch + actionError + '</div>' : "") + '</article>';
  }).join("");
  const filterButtons = availableStatuses.map((status) => '<button type="button" class="' + (view.filterStatus === status ? "on" : "") + '" data-notification-filter="' + escapeHtml(status) + '">' + escapeHtml(status ? presentation.deliveryStatus(status) : i18n.t("incidents.anyStatus")) + '</button>').join("");
  root.innerHTML = '<div class="notification-popover notification-workspace"><header class="utility-header"><div><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><small>' + escapeHtml(String(filteredItems.length)) + '</small></div><div><button type="button" class="secondary-action utility-refresh" data-notifications-refresh>' + escapeHtml(i18n.t("notification.refresh")) + '</button><button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(notificationCloseLabel()) + '">' + iconMarkup("x", { size: 18 }) + '</button></div></header><div class="segmented template-segmented notification-filters" role="group">' + filterButtons + '</div><div class="list template-list notification-list">' + (rows || '<p class="surface-state">' + escapeHtml(i18n.t("notification.empty")) + '</p>') + '</div></div>';
  root.querySelector("[data-notifications-close]")?.addEventListener("click", closeNotifications);
  root.querySelector("[data-notifications-refresh]")?.addEventListener("click", () => loadNotifications({ force: true }));
  root.querySelectorAll("[data-notification-filter]").forEach((button) => button.addEventListener("click", () => { view.filterStatus = button.dataset.notificationFilter || ""; renderNotificationsSurface(); }));
  root.querySelectorAll("[data-notification-dispatch]").forEach((button) => button.addEventListener("click", () => dispatchNotification(button.dataset.notificationDispatch)));
  root.querySelectorAll("[data-notification-incident]").forEach((button) => button.addEventListener("click", () => openIncident(button.dataset.notificationIncident)));
}

function closeNotifications(restoreFocus = true) {
  const trigger = state.notificationsTrigger;
  state.notifications.open = false;
  state.notifications.actionId = null;
  state.notifications.actionState = "idle";
  state.notifications.actionError = "";
  state.notifications.actionErrorId = null;
  state.notificationsTrigger = null;
  renderNotificationsSurface();
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

async function loadNotifications({ force = false, background = false } = {}) {
  const view = state.notifications;
  if (!session.authenticated || !state.capabilities.has("notification.read")) return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderNotificationsSurface(); return; }
  const wasReady = view.state === "ready";
  if (!background || !wasReady) {
    view.state = "loading";
    renderNotificationsSurface();
  }
  view.loadPromise = boundaries.notifications.list({ limit: "50" }).then((items) => {
    ingestNotifications(items);
    view.state = "ready";
  }).catch(() => {
    if (!background || !wasReady) {
      view.items = [];
      view.state = "error";
    }
  }).finally(() => { view.loadPromise = null; renderNotificationsSurface(); });
  return view.loadPromise;
}

function toggleNotifications() {
  if (!state.capabilities.has("notification.read")) return;
  if (state.notifications.open) {
    closeNotifications();
    return;
  }
  state.notificationsTrigger = document.activeElement !== document.body ? document.activeElement : $("#notificationsButton");
  state.notifications.actionError = "";
  state.notifications.actionErrorId = null;
  state.notifications.open = !state.notifications.open;
  if (state.notifications.open) markNotificationsSeen(state.notifications.items);
  renderNotificationsSurface();
  $("#notificationsSurface")?.focus();
  void loadNotifications();
}

async function dispatchNotification(id) {
  const view = state.notifications;
  if (!session.authenticated || !state.capabilities.has("notification.dispatch") || view.actionState !== "idle") return;
  const item = view.items.find((candidate) => String(candidate?.id) === String(id));
  const actions = presentNotification(item, { i18n, presentation, capabilities: state.capabilities }).actions;
  if (!item || !actions?.canDispatch || !confirmAction("confirmNotificationDispatch")) return;
  view.actionId = id;
  view.actionState = "dispatching";
  view.actionError = "";
  renderNotificationsSurface();
  try {
    await boundaries.notifications.dispatch(id);
    const readback = await boundaries.notifications.list({ limit: "50" });
    if (!Array.isArray(readback)) throw new Error("notification readback unavailable");
    ingestNotifications(readback);
    view.actionId = null;
    view.actionState = "idle";
    view.actionErrorId = null;
  } catch (error) {
    view.actionId = null;
    view.actionState = "idle";
    view.actionError = errorMessageKey(error);
    view.actionErrorId = id;
  }
  renderNotificationsSurface();
}

function adminResourceLabel(resource) { return i18n.t("admin.resources." + resource); }

function adminRecordId(item) { return item?.id ?? item?.version ?? item?.line_id ?? item?.device_id ?? ""; }

function adminResourceOptions() {
  return adminResourceDefinitions().filter((resource) => state.capabilities.has(resource.capability));
}

function adminResourceConfig(resource) {
  return adminResourceOptions().find((item) => item.key === resource) || null;
}

function adminEditorMode(resource, id = "", intent = state.admin.editorIntent) {
  const definition = adminResourceConfig(resource);
  if (!definition) return "";
  if (intent === "register" && resource === "devices" && definition.supportsRegistration) return "register";
  if (intent === "view" && id) return "view";
  if (intent === "update" && id && definition.supportsUpdate) return "update";
  if (intent === "create" && definition.supportsCreate) return "create";
  if (resource === "devices" && !id && definition.supportsRegistration) return "register";
  if (id && definition.supportsUpdate) return "update";
  if (id) return "view";
  if (!id && definition.supportsCreate) return "create";
  if (!id && resource === "schedule" && definition.supportsUpdate) return "update";
  return "";
}

const ADMIN_EDITOR_FIELD_KEYS = Object.freeze({
  id: "admin.recordId", school_id: "field.registryNumber", organization_id: "field.school", provider_id: "field.provider", line_id: "field.line",
  name: "field.officialIdentity", district: "field.district", district_id: "field.district", address: "field.address", latitude: "field.latitude", longitude: "field.longitude", active: "admin.monitoringState",
  contact_name: "admin.contactName", contact_phone: "admin.contactPhone", contact_role: "admin.contactRole", contact_position: "admin.contactRole", contact_email: "admin.contactEmail", support_contact: "admin.supportContact",
  role: "field.lineRole", technology: "field.connectionType", technology_id: "field.connectionType", status: "field.status", location: "field.address",
  is_primary: "admin.primaryPoint", username: "field.username", password: "field.password", disabled: "admin.status", scopes: "field.registryProvenance", device_id: "admin.deviceID",
  display_name: "admin.identity", agent_version: "audit.version", tests_per_day: "admin.testsPerDay", performance_tests_per_day: "admin.performanceTestsPerDay",
  jitter_minutes: "field.jitter", light_checks_between: "admin.lightChecksBetween", scope_type: "field.registryProvenance", scope_id: "field.registryNumber", monitoring_point_id: "admin.monitoringPoint",
  version: "audit.version", valid_from: "audit.at", valid_to: "audit.at", contract_no: "field.contract", contract_date: "audit.at",
  download_min: "field.download", upload_min: "field.upload", ping_max: "field.ping", jitter_max: "field.jitter", packet_loss_max: "field.loss",
  availability_min: "field.metrics", confirm_count: "field.metrics", confirm_minutes: "field.metrics", confirm_duration_minutes: "field.metrics",
  recovery_count: "field.metrics", recovery_minutes: "field.metrics", freshness_seconds: "field.lastObserved", reason: "admin.reason",
  recommended: "admin.recommended", minimum_supported: "admin.minimumSupported", release_at: "audit.at", checksum: "admin.checksum", artifact_url: "admin.artifactURL",
});
const ADMIN_EDITOR_STRUCTURED_FIELDS = new Set(["scopes", "manifest", "line_ids", "device_ids", "policy", "contract"]);
const ADMIN_EDITOR_BOOLEAN_FIELDS = new Set(["active", "disabled", "is_primary", "recommended", "minimum_supported"]);
const ADMIN_EDITOR_NUMBER_FIELDS = new Set(["latitude", "longitude", "tests_per_day", "performance_tests_per_day", "jitter_minutes", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min", "confirm_count", "confirm_minutes", "confirm_duration_minutes", "recovery_count", "recovery_minutes", "freshness_seconds"]);
const ADMIN_EDITOR_INTEGER_FIELDS = new Set(["tests_per_day", "performance_tests_per_day", "jitter_minutes", "confirm_count", "confirm_minutes", "confirm_duration_minutes", "recovery_count", "recovery_minutes", "freshness_seconds"]);
const ADMIN_EDITOR_DATETIME_FIELDS = new Set(["valid_from", "valid_to", "contract_date", "release_at"]);
const ADMIN_EDITOR_RELATION_FIELDS = new Set(["school_id", "organization_id", "line_id", "provider_id", "monitoring_point_id"]);
const ADMIN_EDITOR_REQUIRED_FIELDS = Object.freeze({
  organizations: new Set(["school_id", "name", "district"]),
  providers: new Set(["name"]),
  lines: new Set(["organization_id", "role", "technology"]),
  "monitoring-points": new Set(["line_id", "location"]),
  users: new Set(["username", "role"]),
  devices: new Set(["device_id", "monitoring_point_id"]),
  districts: new Set(["name"]),
  technologies: new Set(["name"]),
  "agent-versions": new Set(["version"]),
});

function adminNumberField(field, resource = state.admin.resource) {
  return ADMIN_EDITOR_NUMBER_FIELDS.has(field) || (field === "version" && resource === "policies");
}

function adminIntegerField(field, resource = state.admin.resource) {
  return ADMIN_EDITOR_INTEGER_FIELDS.has(field) || (field === "version" && resource === "policies");
}

function adminEditorFieldLabel(field) {
  return i18n.t(ADMIN_EDITOR_FIELD_KEYS[field] || "admin.record");
}

function adminEditorSource(view) {
  try {
    const value = JSON.parse(view.payload || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    return {};
  }
}

function adminGeneratedID(resource) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `linkwatch-${resource}-${suffix}`;
}

function adminRelationshipOptions(field, currentValue = "") {
  const values = new Map();
  const linesForRelations = Array.isArray(map.state.lines) ? map.state.lines : [];
  const relationships = state.admin.relationships || {};
  const organizations = Array.isArray(relationships.organizations) ? relationships.organizations : [];
  const providers = Array.isArray(relationships.providers) ? relationships.providers : [];
  const relatedLines = Array.isArray(relationships.lines) ? relationships.lines : [];
  const monitoringPoints = Array.isArray(relationships["monitoring-points"]) ? relationships["monitoring-points"] : [];
  if (field === "line_id") {
    relatedLines.forEach((line) => { if (line?.id) values.set(String(line.id), `${line.organization_name || line.school_id || i18n.t("school.noOfficialName")} · ${line.id}`); });
    linesForRelations.forEach((line) => { if (line?.id) values.set(String(line.id), `${line.school_name || line.organization_name || i18n.t("school.noOfficialName")} · ${line.name || line.label || line.id}`); });
  } else if (field === "provider_id") {
    providers.forEach((provider) => { if (provider?.id) values.set(String(provider.id), provider.name || String(provider.id)); });
    linesForRelations.forEach((line) => { if (line?.provider_id) values.set(String(line.provider_id), line.provider || line.provider_name || String(line.provider_id)); });
  } else if (field === "organization_id" || field === "school_id") {
    if (field === "school_id") {
      const registrySchools = map.state.model?.registry?.schools || [];
      const managedSchoolIDs = new Set(organizations.map((organization) => String(organization?.school_id || "")).filter(Boolean));
      const creatingOrganization = state.admin.resource === "organizations" && state.admin.editorIntent === "create";
      registrySchools.forEach((school) => {
        const id = school?.registryId || school?.school_id || school?.id;
        if (id && (!creatingOrganization || !managedSchoolIDs.has(String(id)))) values.set(String(id), popupSchoolName(school));
      });
    }
    const includeManagedOrganizations = field !== "school_id" || state.admin.resource !== "organizations" || state.admin.editorIntent !== "create";
    if (includeManagedOrganizations) organizations.forEach((organization) => {
      const id = field === "school_id" ? organization?.school_id : organization?.id;
      if (id) values.set(String(id), organization.name || organization.school_id || String(id));
    });
    if (includeManagedOrganizations) linesForRelations.forEach((line) => {
      const id = field === "school_id" ? line?.school_id : line?.organization_id;
      if (id) values.set(String(id), line.school_name || line.organization_name || String(id));
    });
  } else if (field === "monitoring_point_id") {
    monitoringPoints.forEach((point) => { if (point?.id) values.set(String(point.id), point.location ? `${point.location} · ${point.line_id}` : String(point.id)); });
    state.admin.items.forEach((item) => { if (item?.monitoring_point_id) values.set(String(item.monitoring_point_id), item.display_name || item.hostname || String(item.monitoring_point_id)); });
  }
  const normalizedCurrent = String(currentValue ?? "");
  if (normalizedCurrent && !values.has(normalizedCurrent)) values.set(normalizedCurrent, normalizedCurrent);
  return [...values.entries()];
}

function adminScopeText(value) {
  if (!Array.isArray(value)) return "";
  return value.map((scope) => `${scope?.scope_type || ""}:${scope?.scope_id || ""}`).filter(Boolean).join(", ");
}

function adminDateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function hydrateAdminEditorFields(root, view, definition, editorMode) {
  const payloadControl = root.querySelector("[name=payload]");
  const payloadLabel = payloadControl?.closest("label");
  const form = root.querySelector("[data-admin-editor]");
  if (!payloadControl || !payloadLabel || !form || !definition) return;
  const source = adminEditorSource(view);
  const fields = (editorMode === "register" ? definition.registrationFields : definition.writableFields)
    .filter((field) => field !== "id");
  const fieldGroup = document.createElement("div");
  fieldGroup.className = "admin-fields";
  fields.forEach((field) => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = adminEditorFieldLabel(field);
    label.appendChild(text);
    label.className = `admin-field admin-field-${field.replace(/_/g, "-")}`;
    const value = source[field];
    if (ADMIN_EDITOR_BOOLEAN_FIELDS.has(field)) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.adminField = field;
      input.checked = value === true || value === "true" || (value === undefined && field === "active");
      input.setAttribute("role", "switch");
      const switchControl = document.createElement("span");
      switchControl.className = "admin-switch-control";
      switchControl.append(input, document.createElement("i"));
      label.classList.add("admin-switch-field");
      label.appendChild(switchControl);
      if (field === "active") {
        const hint = document.createElement("small");
        hint.textContent = i18n.t("admin.monitoringStateHint");
        label.appendChild(hint);
      }
    } else if (ADMIN_EDITOR_RELATION_FIELDS.has(field) && adminRelationshipOptions(field, value).length) {
      const input = document.createElement("select");
      input.dataset.adminField = field;
      const options = adminRelationshipOptions(field, value);
      input.appendChild(new Option(i18n.t("empty.noData"), ""));
      options.forEach(([optionValue, optionLabel]) => input.appendChild(new Option(optionLabel, optionValue)));
      input.value = String(value ?? "");
      label.appendChild(input);
    } else if (field === "scopes") {
      const input = document.createElement("input");
      input.dataset.adminField = field;
      input.type = "text";
      input.placeholder = "OBLAST:all, DISTRICT:...";
      input.value = adminScopeText(value);
      label.appendChild(input);
    } else if (ADMIN_EDITOR_STRUCTURED_FIELDS.has(field)) {
      const input = document.createElement("textarea");
      input.dataset.adminField = field;
      input.rows = 4;
      input.spellcheck = false;
      input.value = value === undefined || value === "" ? "" : JSON.stringify(value, null, 2);
      label.appendChild(input);
    } else if (adminNumberField(field, view.resource)) {
      const input = document.createElement("input");
      input.dataset.adminField = field;
      input.type = "number";
      input.step = adminIntegerField(field, view.resource) ? "1" : "any";
      input.value = value === undefined || value === null ? "" : String(value);
      label.appendChild(input);
    } else if (ADMIN_EDITOR_DATETIME_FIELDS.has(field)) {
      const input = document.createElement("input");
      input.dataset.adminField = field;
      input.type = "datetime-local";
      input.value = adminDateInputValue(value);
      label.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.dataset.adminField = field;
      input.type = field === "password" ? "password" : "text";
      input.value = value === undefined || value === null ? "" : String(value);
      if (field === "password") input.autocomplete = "new-password";
      label.appendChild(input);
    }
    const control = label.querySelector("input, select, textarea");
    if (control && ADMIN_EDITOR_REQUIRED_FIELDS[view.resource]?.has(field)) control.required = true;
    fieldGroup.appendChild(label);
  });
  payloadLabel.replaceWith(fieldGroup);
}

function pruneUnavailableDeviceActions(root, view) {
  if (view.resource !== "devices") return;
  root.querySelectorAll("[data-admin-device-action]").forEach((button) => {
    const item = view.items.find((candidate) => String(adminRecordId(candidate)) === String(button.dataset.adminDeviceId));
    const blocked = Boolean(item?.blocked || item?.blocked_at);
    const action = button.dataset.adminDeviceAction;
    if ((action === "block" && blocked) || (action === "unblock" && !blocked)) button.remove();
  });
}

function renderDeviceCredentialDialog(view) {
  const credential = view.credential;
  if (!credential?.deviceToken) return "";
  const config = `LINKWATCH_SERVER_URL=${credential.serverURL}\nLINKWATCH_DEVICE_ID=${credential.deviceID}\nLINKWATCH_DEVICE_TOKEN=${credential.deviceToken}`;
  const cli = `LINKWATCH_SERVER_URL=${credential.serverURL} LINKWATCH_DEVICE_ID=${credential.deviceID} LINKWATCH_DEVICE_TOKEN=<token> linkwatch-agent run`;
  const field = (key, value) => '<div class="credential-field"><div><dt>' + escapeHtml(i18n.t(key)) + '</dt><dd><code>' + escapeHtml(value) + '</code></dd></div><button type="button" class="secondary-action" data-admin-copy="' + escapeHtml(value) + '">' + escapeHtml(i18n.t("admin.copy")) + '</button></div>';
  return '<div class="admin-credential-backdrop" role="presentation"><section class="admin-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="adminCredentialTitle"><header><div><h2 id="adminCredentialTitle">' + escapeHtml(i18n.t("admin.credentialsTitle")) + '</h2><p>' + escapeHtml(i18n.t("admin.credentialsWarning")) + '</p></div><button type="button" class="icon-close" data-admin-credentials-close aria-label="' + escapeHtml(i18n.t("admin.closeCredentials")) + '">' + iconMarkup("x", { size: 18 }) + '</button></header><dl>' + field("admin.deviceID", credential.deviceID) + field("admin.deviceToken", credential.deviceToken) + field("admin.serverURL", credential.serverURL) + '</dl><label class="credential-example"><span>' + escapeHtml(i18n.t("admin.configExample")) + '</span><textarea readonly>' + escapeHtml(config) + '</textarea><button type="button" class="secondary-action" data-admin-copy="' + escapeHtml(config) + '">' + escapeHtml(i18n.t("admin.copy")) + '</button></label><p class="credential-example-label">' + escapeHtml(i18n.t("admin.cliExample")) + '</p><code class="credential-cli">' + escapeHtml(cli) + '</code><button type="button" class="primary-action" data-admin-credentials-close>' + escapeHtml(i18n.t("admin.closeCredentials")) + '</button></section></div>';
}

function renderAdminDemoControls(view) {
  if (!state.capabilities.has("admin.manage")) return "";
  const busy = view.demoAction !== "idle";
  const error = view.demoError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.demoError)) + "</p>" : "";
  return '<section class="admin-demo-panel"><div><h2>' + escapeHtml(i18n.t("admin.demoTitle")) + '</h2><p>' + escapeHtml(i18n.t("admin.demoDescription")) + '</p></div><div class="admin-demo-actions"><button type="button" class="secondary-action" data-admin-demo="healthy"' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.demoHealthy")) + '</button><button type="button" class="secondary-action" data-admin-demo="degrade"' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.demoDegrade")) + '</button><button type="button" class="secondary-action" data-admin-demo="recover"' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.demoRecover")) + '</button><button type="button" class="secondary-action" data-admin-demo="outage"' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.demoOutage")) + '</button><button type="button" class="secondary-action" data-admin-demo-reset' + (busy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.demoReset")) + '</button></div>' + error + '</section>';
}

function renderAdminOnboardingSurface(root, view, allowedResources, header) {
  const onboarding = view.onboarding;
  const school = onboarding.school || {};
  const relationships = view.relationships || {};
  const providers = Array.isArray(relationships.providers) ? relationships.providers : [];
  const existingOrganization = onboardingOrganization(relationships.organizations, school.school_id || school.registryId);
  const steps = ["organization", "provider", "line", "point", "contract", "activation", "enrollment"];
  const currentStep = onboardingStepLabel(onboarding.step);
  const progress = steps.map((step) => {
    const complete = onboarding.state === "success" || (step === "organization" && existingOrganization);
    const current = onboarding.state === "running" && step === onboarding.step;
    return '<li class="onboarding-step' + (complete ? " complete" : current ? " current" : "") + '"><span>' + (complete ? "✓" : "") + '</span><div><b>' + escapeHtml(onboardingStepLabel(step)) + '</b>' + (current ? '<small>' + escapeHtml(i18n.t("admin.onboardingRunning")) + '</small>' : "") + '</div></li>';
  }).join("");
  const providerOptions = ['<option value="">' + escapeHtml(i18n.t("admin.onboardingNewProvider")) + '</option>'].concat(providers.filter((provider) => provider?.id).map((provider) => '<option value="' + escapeHtml(String(provider.id)) + '">' + escapeHtml(String(provider.name || provider.id)) + '</option>')).join("");
  const result = onboarding.result;
  const enrollment = result?.enrollment;
  const resultPanel = onboarding.state === "success" && result ? '<section class="onboarding-result"><h2>' + escapeHtml(i18n.t("admin.onboardingResult")) + '</h2><dl class="detail-grid"><div><dt>' + escapeHtml(i18n.t("admin.onboardingProviderValue")) + '</dt><dd>' + escapeHtml(result.provider?.name || result.provider?.id || i18n.t("empty.value")) + '</dd></div><div><dt>' + escapeHtml(i18n.t("admin.onboardingLineValue")) + '</dt><dd>' + escapeHtml(result.line?.id || i18n.t("empty.value")) + '</dd></div><div><dt>' + escapeHtml(i18n.t("admin.onboardingPointValue")) + '</dt><dd>' + escapeHtml(result.point?.location || result.point?.id || i18n.t("empty.value")) + '</dd></div><div><dt>' + escapeHtml(i18n.t("admin.onboardingExpires")) + '</dt><dd>' + escapeHtml(presentation.formatDate(enrollment?.expires_at, true)) + '</dd></div></dl><label class="onboarding-code"><span>' + escapeHtml(i18n.t("admin.onboardingEnrollmentCode")) + '</span><div><code>' + escapeHtml(enrollment?.code || i18n.t("empty.value")) + '</code><button type="button" class="secondary-action" data-onboarding-copy>' + escapeHtml(i18n.t("admin.copy")) + '</button></div></label><p class="surface-state" role="status">' + escapeHtml(i18n.t("admin.onboardingSuccess")) + '</p></section>' : "";
  const errorPanel = onboarding.state === "error" ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(onboarding.error || "admin.onboardingFailed")) + (onboarding.step ? '<span>' + escapeHtml(i18n.t("admin.onboardingStep") + ": " + currentStep) + '</span>' : "") + '</p>' : "";
  const running = onboarding.state === "running";
  const form = onboarding.state === "success"
    ? '<div class="onboarding-complete"><p class="detail-muted">' + escapeHtml(i18n.t("admin.onboardingSuccess")) + '</p><button type="button" class="secondary-action" data-school-onboarding-cancel>' + escapeHtml(i18n.t("admin.onboardingCancel")) + '</button></div>'
    : '<form class="school-onboarding-form" data-school-onboarding><fieldset><legend>' + escapeHtml(i18n.t("admin.onboardingProvider")) + '</legend><label>' + escapeHtml(i18n.t("admin.onboardingExistingProvider")) + '<select name="provider_id"' + (running ? " disabled" : "") + '>' + providerOptions + '</select></label><label>' + escapeHtml(i18n.t("admin.onboardingProviderName")) + '<input name="provider_name" type="text"' + (running ? " disabled" : "") + '></label><label>' + escapeHtml(i18n.t("admin.onboardingSupportContact")) + '<input name="support_contact" type="text"' + (running ? " disabled" : "") + '></label></fieldset><fieldset><legend>' + escapeHtml(i18n.t("admin.onboardingLine")) + '</legend><label>' + escapeHtml(i18n.t("admin.onboardingRole")) + '<select name="role"' + (running ? " disabled" : "") + '><option value="PRIMARY">' + escapeHtml(presentation.role("PRIMARY")) + '</option><option value="RESERVE">' + escapeHtml(presentation.role("RESERVE")) + '</option></select></label><label>' + escapeHtml(i18n.t("admin.onboardingTechnology")) + '<input name="technology" value="FIBER" required' + (running ? " disabled" : "") + '></label></fieldset><fieldset><legend>' + escapeHtml(i18n.t("admin.onboardingPoint")) + '</legend><label>' + escapeHtml(i18n.t("admin.onboardingLocation")) + '<input name="location" value="' + escapeHtml(school.address || "") + '" required' + (running ? " disabled" : "") + '></label></fieldset><fieldset><legend>' + escapeHtml(i18n.t("admin.onboardingContract")) + '</legend><label>' + escapeHtml(i18n.t("admin.onboardingContractNo")) + '<input name="contract_no" type="text"' + (running ? " disabled" : "") + '></label><label>' + escapeHtml(i18n.t("admin.onboardingValidFrom")) + '<input name="valid_from" type="datetime-local"' + (running ? " disabled" : "") + '></label><label>' + escapeHtml(i18n.t("admin.onboardingValidTo")) + '<input name="valid_to" type="datetime-local"' + (running ? " disabled" : "") + '></label><label>' + escapeHtml(i18n.t("admin.onboardingContractDate")) + '<input name="contract_date" type="datetime-local"' + (running ? " disabled" : "") + '></label></fieldset><div class="form-actions"><button type="submit" class="primary-action"' + (running ? " disabled" : "") + '>' + escapeHtml(running ? i18n.t("admin.onboardingRunning") : onboarding.state === "error" ? i18n.t("admin.onboardingRetry") : i18n.t("admin.onboardingStart")) + '</button><button type="button" class="secondary-action" data-school-onboarding-cancel' + (running ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.onboardingCancel")) + '</button></div></form>';
  const nav = '<nav class="admin-resource-nav" aria-label="' + escapeHtml(i18n.t("admin.resource")) + '">' + allowedResources.map((resource) => '<button type="button" class="resource-nav-item' + (resource.key === view.resource ? " active" : "") + '" data-admin-onboarding-resource="' + escapeHtml(resource.key) + '"><span>' + escapeHtml(adminResourceLabel(resource.key)) + '</span></button>').join("") + '</nav>';
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="template-screen structural-surface workspace three template-workspace admin-workspace school-onboarding-workspace"><aside class="pane admin-resource-pane">' + header + nav + '</aside><section class="pane onboarding-progress"><h1>' + escapeHtml(i18n.t("admin.onboardingTitle")) + '</h1><p class="surface-state" role="status">' + escapeHtml(i18n.t("admin.loading")) + '</p></section><aside class="inspector admin-editor-pane"></aside></div>';
  } else if (view.state === "error") {
    root.innerHTML = '<div class="template-screen structural-surface workspace three template-workspace admin-workspace school-onboarding-workspace"><aside class="pane admin-resource-pane">' + header + nav + '</aside><section class="pane onboarding-progress"><h1>' + escapeHtml(i18n.t("admin.onboardingTitle")) + '</h1><p class="surface-state error" role="alert">' + escapeHtml(i18n.t("admin.unavailable")) + '</p></section><aside class="inspector admin-editor-pane"></aside></div>';
  } else {
    root.innerHTML = '<div class="template-screen structural-surface workspace three template-workspace admin-workspace school-onboarding-workspace"><aside class="pane admin-resource-pane">' + header + nav + '</aside><section class="pane onboarding-progress"><header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.admin")) + '</span><h1>' + escapeHtml(i18n.t("admin.onboardingTitle")) + '</h1><small>' + escapeHtml(i18n.t("admin.onboardingSubtitle")) + '</small></div></header><section class="onboarding-school-card"><span class="surface-eyebrow">' + escapeHtml(i18n.t("school.registry")) + '</span><h2>' + escapeHtml(popupSchoolName(school)) + '</h2><p>' + escapeHtml(school.school_id || school.registryId || i18n.t("empty.value")) + ' · ' + escapeHtml(school.district || i18n.t("empty.value")) + '</p><p>' + escapeHtml(school.address || i18n.t("empty.value")) + '</p><p>' + escapeHtml(i18n.t("field.coordinates")) + ': ' + escapeHtml(coordinateText(school)) + '</p></section><ol class="onboarding-steps">' + progress + '</ol>' + errorPanel + '</section><aside class="inspector admin-editor-pane">' + form + resultPanel + '</aside></div>';
  }
  root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true, preserveMessage: true }));
  root.querySelector("[data-school-onboarding]")?.addEventListener("submit", runSchoolMonitoringSetup);
  root.querySelector("[data-school-onboarding-cancel]")?.addEventListener("click", cancelSchoolMonitoringSetup);
  root.querySelector("[data-onboarding-copy]")?.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText || !enrollment?.code) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(enrollment.code);
      showToast("admin.copied");
    } catch (error) {
      showToast("admin.copyFailed", "warn");
    }
  });
  root.querySelectorAll("[data-admin-onboarding-resource]").forEach((button) => button.addEventListener("click", () => {
    const resource = button.dataset.adminOnboardingResource;
    if (!resource || resource === view.resource) return;
    view.onboarding = createAdminOnboardingState();
    view.onboardingRegistryId = "";
    view.resource = resource;
    view.selectedId = "";
    view.editorIntent = resource === "devices" ? "register" : resource === "schedule" ? "update" : "create";
    view.draftID = "";
    view.payload = "{}";
    view.message = "";
    loadAdminResource({ force: true });
  }));
}

function renderAdminPreservingScroll() {
  const root = $("#adminSurface");
  const scrollTop = root?.scrollTop || 0;
  renderAdminSurface();
  if (root) root.scrollTop = scrollTop;
}

function renderAdminReadOnlyEditor(resource, item) {
  const presented = presentAdminRecord(resource, item, { i18n, presentation });
  const fields = presented.fields.length
    ? '<dl class="detail-grid">' + presented.fields.map((field) => '<div><dt>' + escapeHtml(field.label) + '</dt><dd>' + escapeHtml(field.value) + '</dd></div>').join("") + '</dl>'
    : '<p class="surface-state">' + escapeHtml(i18n.t("empty.noData")) + '</p>';
  return '<article class="admin-editor admin-readonly-editor"><div class="inspector-top"><div><span class="surface-eyebrow">' + escapeHtml(adminResourceLabel(resource)) + '</span><h2>' + escapeHtml(i18n.t("admin.record")) + '</h2><div class="inspector-sub">' + escapeHtml(i18n.t("admin.resourceCapability")) + '</div></div><span class="status-pill">' + escapeHtml(adminResourceLabel(resource)) + '</span></div>' + fields + '</article>';
}

function renderAdminActionPanel(view, selectedAdminItem) {
  if (["policies", "contracts", "lines"].includes(view.resource)) {
    const proposalKind = view.resource === "contracts" ? "contract" : "policy";
    const proposalSource = selectedAdminItem ? JSON.stringify(selectedAdminItem, null, 2) : "{}";
    return '<section class="admin-action-panel"><div class="sectionhead"><h2>' + escapeHtml(i18n.t("admin.impactPreview")) + '</h2><span>' + escapeHtml(i18n.t("admin.previewReady")) + '</span></div><form data-admin-impact-form><label>' + escapeHtml(i18n.t("field.line")) + '<textarea name="line_ids" required placeholder="line-id-1, line-id-2"></textarea></label><div class="admin-action-dates"><label>' + escapeHtml(i18n.t("reports.from")) + '<input name="from" type="datetime-local" required></label><label>' + escapeHtml(i18n.t("reports.to")) + '<input name="to" type="datetime-local" required></label></div>' + (view.resource === "lines" ? '<label>' + escapeHtml(i18n.t("admin.proposalKind")) + '<select name="proposal_kind"><option value="policy">' + escapeHtml(i18n.t("admin.resources.policies")) + '</option><option value="contract">' + escapeHtml(i18n.t("admin.resources.contracts")) + '</option></select></label>' : '') + '<label>' + escapeHtml(i18n.t("admin.payload")) + '<textarea name="proposal" required spellcheck="false">' + escapeHtml(proposalSource) + '</textarea></label><button type="submit" class="secondary-action"' + (view.mutationState === "saving" ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.impactPreview")) + '</button></form></section>';
  }
  if (["agent-versions", "devices"].includes(view.resource)) {
    return '<section class="admin-action-panel"><div class="sectionhead"><h2>' + escapeHtml(i18n.t("admin.agentUpdate")) + '</h2><span>' + escapeHtml(i18n.t("admin.confirmDestructive")) + '</span></div><form data-admin-agent-update-form><label>' + escapeHtml(i18n.t("admin.payload")) + '<textarea name="manifest" required spellcheck="false" placeholder="{&quot;signed_payload&quot;: ...}"></textarea></label><label>' + escapeHtml(i18n.t("admin.deviceID")) + '<textarea name="device_ids" required placeholder="device-id-1, device-id-2"></textarea></label><button type="submit" class="secondary-action"' + (view.mutationState === "saving" ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.agentUpdate")) + '</button></form></section>';
  }
  return "";
}

function adminRecordMatchesSearch(item, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return true;
  return Object.values(item || {}).filter((value) => ["string", "number"].includes(typeof value)).join(" ").toLocaleLowerCase().includes(needle);
}

function renderAdminSurface() {
  const root = $("#adminSurface");
  if (!root) return;
  const view = state.admin;
  const allowedResources = adminResourceOptions();
  const allowed = state.capabilities.has("admin.manage");
  root.hidden = router.getState().view !== "admin" || !allowed;
  if (root.hidden) return;
  if (!allowedResources.some((resource) => resource.key === view.resource)) view.resource = allowedResources[0]?.key || "organizations";
  const options = allowedResources.map((resource) => '<option value="' + escapeHtml(resource.key) + '"' + (resource.key === view.resource ? " selected" : "") + '>' + escapeHtml(adminResourceLabel(resource.key)) + '</option>').join("");
  const header = '<header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.admin")) + '</span><h1>' + escapeHtml(i18n.t("admin.title")) + '</h1><small>' + escapeHtml(i18n.t("admin.subtitle")) + '</small></div><button type="button" class="icon-button" data-admin-refresh aria-label="' + escapeHtml(i18n.t("admin.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></header>';
  if (view.onboarding?.active) {
    renderAdminOnboardingSurface(root, view, allowedResources, header);
    return;
  }
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="template-screen structural-surface workspace three template-workspace admin-workspace"><aside class="pane admin-resource-pane">' + header + '<p class="surface-state" role="status">' + escapeHtml(i18n.t("admin.loading")) + '</p></aside><section class="pane"></section><aside class="inspector"></aside></div>';
    root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true }));
    return;
  }
  if (view.state === "error") {
    root.innerHTML = '<div class="template-screen structural-surface workspace three template-workspace admin-workspace"><aside class="pane admin-resource-pane">' + header + '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("admin.unavailable")) + '</p></aside><section class="pane"></section><aside class="inspector"></aside></div>';
    root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true }));
    return;
  }
  const mutationBusy = view.mutationState === "saving";
  const resourceDefinition = adminResourceConfig(view.resource);
  const editorMode = adminEditorMode(view.resource, view.selectedId, view.editorIntent);
  const supportsImpactPreview = ["policies", "contracts", "lines"].includes(view.resource);
  const supportsAgentUpdate = ["agent-versions", "devices"].includes(view.resource);
  const resourceContext = supportsImpactPreview ? "impact" : supportsAgentUpdate ? "agent" : "standard";
  const generatedRecordID = editorMode === "create" && resourceDefinition?.writableFields?.includes("id")
    ? (view.draftID || (view.draftID = adminGeneratedID(view.resource)))
    : "";
  const visibleItems = view.items.filter((item) => adminRecordMatchesSearch(item, view.search));
  const rows = visibleItems.map((item) => {
    const id = adminRecordId(item);
    const presented = presentAdminRecord(view.resource, item, { i18n, presentation });
    const cells = presented.fields.map((field) => '<div><dt>' + escapeHtml(field.label) + '</dt><dd>' + escapeHtml(field.value) + "</dd></div>").join("");
    const edit = resourceDefinition?.supportsUpdate && view.resource !== "schedule" && id ? '<button type="button" class="link-action" data-admin-edit="' + escapeHtml(String(id)) + '"' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.edit")) + "</button>" : "";
    const deviceDisabled = mutationBusy ? " disabled" : "";
    const deviceActions = view.resource === "devices" && id ? '<div class="admin-device-actions"><button type="button" class="link-action" data-admin-device-action="block" data-admin-device-id="' + escapeHtml(String(id)) + '"' + deviceDisabled + '>' + escapeHtml(i18n.t("admin.block")) + '</button><button type="button" class="link-action" data-admin-device-action="unblock" data-admin-device-id="' + escapeHtml(String(id)) + '"' + deviceDisabled + '>' + escapeHtml(i18n.t("admin.unblock")) + '</button><button type="button" class="link-action" data-admin-device-action="rotate-token" data-admin-device-id="' + escapeHtml(String(id)) + '"' + deviceDisabled + '>' + escapeHtml(i18n.t("admin.rotateToken")) + "</button></div>" : "";
    return '<article class="admin-record' + (String(view.selectedId) === String(id) ? ' selected' : '') + '" data-admin-select="' + escapeHtml(String(id)) + '"><dl class="detail-grid">' + cells + '</dl><div class="admin-record-actions">' + edit + deviceActions + '</div></article>';
  }).join("");
  const editorTitle = editorMode === "register" ? i18n.t("admin.registerDevice") : editorMode === "update" ? i18n.t("admin.editRecord") : i18n.t("admin.createRecord");
  const submitLabel = editorMode === "register" ? i18n.t("admin.registerDevice") : editorMode === "update" ? i18n.t("admin.saveChanges") : i18n.t("admin.create");
  const message = view.message ? '<p class="admin-message surface-state' + (view.mutationState === "error" ? " error" : "") + '" role="status">' + escapeHtml(i18n.t(view.message)) + "</p>" : "";
  const hiddenRecordID = editorMode === "update" || generatedRecordID ? '<input type="hidden" name="recordId" value="' + escapeHtml(editorMode === "update" ? view.selectedId : generatedRecordID) + '">' : '';
  const selectedAdminItem = view.items.find((item) => String(adminRecordId(item)) === String(view.selectedId));
  const editor = editorMode === "view" && selectedAdminItem
    ? renderAdminReadOnlyEditor(view.resource, selectedAdminItem)
    : editorMode
      ? '<form id="adminEditor" class="admin-editor" data-admin-editor data-admin-mode="' + escapeHtml(editorMode) + '"><h2>' + escapeHtml(editorTitle) + '</h2>' + hiddenRecordID + '<label>' + escapeHtml(i18n.t("admin.payload")) + '<textarea name="payload" required spellcheck="false" hidden>' + escapeHtml(view.payload) + '</textarea></label><p class="form-hint">' + escapeHtml(i18n.t("admin.payloadHint")) + '</p><button type="submit" class="primary-action"' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(submitLabel) + '</button></form>'
      : '<div class="admin-editor"><p class="surface-state">' + escapeHtml(i18n.t("admin.resourceCapability")) + '</p></div>';
  const createLabel = resourceDefinition?.supportsRegistration && view.resource === "devices" ? i18n.t("admin.registerDevice") : i18n.t("admin.createNew");
  const canStartCreate = resourceDefinition?.supportsCreate || (view.resource === "devices" && resourceDefinition?.supportsRegistration);
  const modeHint = editorMode === "update" ? "admin.editModeHint" : editorMode === "view" ? "admin.record" : "admin.createModeHint";
  const modeBar = canStartCreate ? '<div class="admin-mode-bar"><button type="button" class="secondary-action" data-admin-create' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(createLabel) + '</button><span>' + escapeHtml(i18n.t(modeHint)) + '</span></div>' : "";
  const toolbar = '<form class="admin-toolbar" data-admin-filter><label>' + escapeHtml(i18n.t("admin.resource")) + '<select data-admin-resource' + (mutationBusy ? " disabled" : "") + '>' + options + '</select></label><label class="admin-search-field">' + escapeHtml(i18n.t("admin.search")) + '<input type="search" name="search" value="' + escapeHtml(view.search) + '" placeholder="' + escapeHtml(i18n.t("admin.searchPlaceholder")) + '"></label><button type="submit" class="secondary-action">' + escapeHtml(i18n.t("admin.searchAction")) + '</button>' + (view.search ? '<button type="button" class="link-action admin-search-reset" data-admin-search-reset>' + escapeHtml(i18n.t("action.resetFilters")) + '</button>' : "") + '</form>';
  const records = rows ? '<div class="admin-records">' + rows + '</div>' : '<p class="surface-state">' + escapeHtml(i18n.t(view.search ? "admin.noSearchResults" : "admin.empty")) + '</p>';
  const preview = supportsImpactPreview && view.preview ? '<div class="admin-preview"><h2>' + escapeHtml(i18n.t("admin.impactPreview")) + '</h2><p>' + escapeHtml(i18n.t("admin.previewReady")) + '</p><dl class="detail-grid"><div><dt>' + escapeHtml(i18n.t("reports.measurements")) + '</dt><dd>' + escapeHtml(String(view.preview?.result?.measurements ?? view.preview?.input?.measurement_count ?? i18n.t("empty.noData"))) + '</dd></div><div><dt>' + escapeHtml(i18n.t("field.lines")) + '</dt><dd>' + escapeHtml(String(view.preview?.input?.line_count ?? i18n.t("empty.noData"))) + '</dd></div><div><dt>' + escapeHtml(i18n.t("admin.status")) + '</dt><dd>' + escapeHtml(presentation.status(view.preview?.status).label) + '</dd></div></dl></div>' : "";
  const actionPanel = renderAdminActionPanel(view, selectedAdminItem);
  const resourceNav = '<nav class="admin-resource-nav" aria-label="' + escapeHtml(i18n.t("admin.resource")) + '">' + allowedResources.map((resource) => '<button type="button" class="resource-nav-item' + (resource.key === view.resource ? " active" : "") + '" data-admin-resource-choice="' + escapeHtml(resource.key) + '"><span>' + escapeHtml(adminResourceLabel(resource.key)) + '</span><small>' + escapeHtml(resource.key === view.resource ? String(visibleItems.length) : "") + '</small></button>').join("") + '</nav>';
  root.innerHTML = '<div class="template-screen structural-surface workspace three template-workspace admin-workspace" data-admin-resource-context="' + escapeHtml(resourceContext) + '"><aside class="pane admin-resource-pane">' + header + resourceNav + '</aside><section class="pane admin-record-pane"><div class="catalog-toolbar"><div><span class="surface-eyebrow">' + escapeHtml(adminResourceLabel(view.resource)) + '</span><h2>' + escapeHtml(i18n.t("admin.records")) + '</h2></div>' + modeBar + '</div>' + toolbar + renderAdminDemoControls(view) + '<div class="admin-record-list">' + records + '</div></section><aside class="inspector admin-editor-pane">' + editor + actionPanel + message + preview + '</aside></div>' + renderDeviceCredentialDialog(view);
  hydrateRenderedControls(root);
  hydrateAdminEditorFields(root, view, resourceDefinition, editorMode);
  pruneUnavailableDeviceActions(root, view);
  bindAdminSurfaceEvents(root);
}

function bindAdminSurfaceEvents(root) {
  root.querySelector('[data-admin-field="school_id"]')?.addEventListener("change", (event) => {
    if (state.admin.resource !== "organizations" || state.admin.editorIntent !== "create") return;
    const school = (map.state.model?.registry?.schools || []).find((item) => String(item?.registryId || item?.school_id || item?.id || "") === String(event.target.value));
    if (!school) return;
    const values = registrySchoolAdminPayload(school);
    Object.entries(values).forEach(([field, value]) => {
      if (field === "id" || value === undefined) return;
      const control = root.querySelector(`[data-admin-field="${field}"]`);
      if (!control) return;
      if (control.type === "checkbox") control.checked = value === true;
      else control.value = String(value);
    });
    state.admin.onboardingRegistryId = String(values.school_id || "");
  });
  root.querySelector("[data-admin-resource]")?.addEventListener("change", (event) => {
    state.admin.resource = event.target.value;
    state.admin.selectedId = "";
    state.admin.editorIntent = state.admin.resource === "devices" ? "register" : state.admin.resource === "schedule" ? "update" : "create";
    state.admin.draftID = "";
    state.admin.payload = "{}";
    state.admin.search = "";
    state.admin.message = "";
    loadAdminResource({ force: true });
  });
  root.querySelectorAll("[data-admin-resource-choice]").forEach((button) => button.addEventListener("click", () => {
    const resource = button.dataset.adminResourceChoice;
    if (!resource || resource === state.admin.resource) return;
    state.admin.resource = resource;
    state.admin.selectedId = "";
    state.admin.editorIntent = resource === "devices" ? "register" : resource === "schedule" ? "update" : "create";
    state.admin.draftID = "";
    state.admin.payload = "{}";
    state.admin.search = "";
    state.admin.message = "";
    loadAdminResource({ force: true });
  }));
  root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true, preserveMessage: true }));
  root.querySelector("[data-admin-filter]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.admin.search = String(new FormData(event.currentTarget).get("search") || "").trim();
    renderAdminPreservingScroll();
  });
  root.querySelector("[data-admin-search-reset]")?.addEventListener("click", () => {
    state.admin.search = "";
    renderAdminPreservingScroll();
  });
  root.querySelector("[data-admin-create]")?.addEventListener("click", () => {
    const definition = adminResourceConfig(state.admin.resource);
    state.admin.selectedId = "";
    state.admin.editorIntent = state.admin.resource === "devices" && definition?.supportsRegistration ? "register" : "create";
    state.admin.draftID = "";
    state.admin.payload = "{}";
    state.admin.message = "";
    state.admin.onboardingRegistryId = "";
    renderAdminPreservingScroll();
    globalThis.requestAnimationFrame?.(() => root.querySelector("#adminEditor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  });
  root.querySelectorAll("[data-admin-edit]").forEach((button) => button.addEventListener("click", () => {
    const item = state.admin.items.find((candidate) => String(adminRecordId(candidate)) === String(button.dataset.adminEdit));
    if (!item) return;
    const id = String(adminRecordId(item));
    const definition = adminResourceConfig(state.admin.resource);
    if (!definition.supportsUpdate) return;
    state.admin.selectedId = id;
    state.admin.editorIntent = "update";
    state.admin.draftID = "";
    state.admin.payload = JSON.stringify(writableAdminPayload(state.admin.resource, item, { id, operation: "update" }), null, 2);
    state.admin.message = "";
    state.admin.onboardingRegistryId = "";
    renderAdminPreservingScroll();
    globalThis.requestAnimationFrame?.(() => root.querySelector("#adminEditor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }));
  root.querySelectorAll("[data-admin-select]").forEach((record) => record.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea, details")) return;
    const item = state.admin.items.find((candidate) => String(adminRecordId(candidate)) === String(record.dataset.adminSelect));
    const definition = adminResourceConfig(state.admin.resource);
    if (!item || !definition) return;
    const id = String(adminRecordId(item));
    state.admin.selectedId = id;
    state.admin.editorIntent = definition.supportsUpdate ? "update" : "view";
    state.admin.draftID = "";
    state.admin.payload = JSON.stringify(definition.supportsUpdate ? writableAdminPayload(state.admin.resource, item, { id, operation: "update" }) : item, null, 2);
    state.admin.message = "";
    renderAdminPreservingScroll();
  }));
  root.querySelector("[data-admin-editor]")?.addEventListener("submit", submitAdminMutation);
  root.querySelector("[data-admin-impact-form]")?.addEventListener("submit", submitAdminImpactPreview);
  root.querySelector("[data-admin-agent-update-form]")?.addEventListener("submit", submitAdminAgentUpdate);
  root.querySelectorAll("[data-admin-device-action]").forEach((button) => button.addEventListener("click", () => adminDeviceAction(button.dataset.adminDeviceId, button.dataset.adminDeviceAction)));
  root.querySelectorAll("[data-admin-demo]").forEach((button) => button.addEventListener("click", () => runAdminDemoScenario(button.dataset.adminDemo)));
  root.querySelector("[data-admin-demo-reset]")?.addEventListener("click", resetAdminDemo);
  root.querySelectorAll("[data-admin-credentials-close]").forEach((button) => button.addEventListener("click", () => {
    state.admin.credential = null;
    renderAdminPreservingScroll();
  }));
  root.querySelectorAll("[data-admin-copy]").forEach((button) => button.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(button.dataset.adminCopy || "");
      showToast("admin.copied");
    } catch (error) {
      showToast("admin.copyFailed", "warn");
    }
  }));
}

async function refreshAfterAdminDemo() {
  await Promise.allSettled([
    refreshMap(),
    loadIncidents({ force: true }),
    loadReports({ force: true }),
  ]);
}

async function runAdminDemoScenario(scenario) {
  const view = state.admin;
  if (!scenario || view.demoAction !== "idle") return;
  if (["degrade", "outage"].includes(scenario) && !globalThis.confirm?.(i18n.t("admin.demoConfirmDegrade"))) return;
  view.demoAction = scenario;
  view.demoError = "";
  renderAdminPreservingScroll();
  try {
    await boundaries.admin.demoScenario(scenario);
    await refreshAfterAdminDemo();
    view.demoAction = "idle";
    showToast("admin.demoStarted");
  } catch (error) {
    view.demoAction = "idle";
    view.demoError = "admin.demoFailed";
  }
  renderAdminPreservingScroll();
}

async function resetAdminDemo() {
  const view = state.admin;
  if (view.demoAction !== "idle" || !globalThis.confirm?.(i18n.t("admin.demoConfirmReset"))) return;
  view.demoAction = "reset";
  view.demoError = "";
  renderAdminPreservingScroll();
  try {
    await boundaries.admin.resetDemo();
    view.credential = null;
    view.selectedId = "";
    view.draftID = "";
    await Promise.allSettled([
      loadAdminResource({ force: true }),
      refreshAfterAdminDemo(),
    ]);
    view.demoAction = "idle";
    showToast("admin.demoResetDone");
  } catch (error) {
    view.demoAction = "idle";
    view.demoError = "admin.demoFailed";
  }
  renderAdminPreservingScroll();
}

async function loadAdminResource({ force = false, preserveMessage = false } = {}) {
  const view = state.admin;
  if (!session.authenticated || !state.capabilities.has("admin.manage") || router.getState().view !== "admin") return;
  const allowed = adminResourceOptions();
  if (!allowed.some((resource) => resource.key === view.resource)) view.resource = allowed[0]?.key || "organizations";
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderAdminPreservingScroll(); return; }
  view.state = "loading";
  if (!preserveMessage) view.message = "";
  renderAdminPreservingScroll();
  const requestedResource = view.resource;
  const relationResources = [requestedResource, "organizations", "providers", "lines", "monitoring-points"].filter((resource, index, resources) => resources.indexOf(resource) === index);
  view.loadPromise = Promise.allSettled(relationResources.map((resource) => boundaries.admin.list(resource))).then((results) => {
    const records = new Map(relationResources.map((resource, index) => [resource, results[index]]));
    const current = records.get(requestedResource);
    if (view.resource !== requestedResource) return;
    if (current?.status !== "fulfilled") {
      view.items = [];
      view.state = "error";
      view.message = "admin.unavailable";
      return;
    }
    view.items = Array.isArray(current.value) ? current.value : [];
    view.relationships = Object.fromEntries(["organizations", "providers", "lines", "monitoring-points"].map((resource) => {
      const result = records.get(resource);
      return [resource, result?.status === "fulfilled" && Array.isArray(result.value) ? result.value : []];
    }));
    view.state = "ready";
  }).catch(() => { view.items = []; view.state = "error"; view.message = "admin.unavailable"; }).finally(() => { view.loadPromise = null; renderAdminPreservingScroll(); });
  return view.loadPromise;
}

async function submitAdminImpactPreview(event) {
  event.preventDefault();
  const view = state.admin;
  if (view.mutationState === "saving") return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const lineIDs = String(values.line_ids || "").split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const from = new Date(String(values.from || ""));
  const to = new Date(String(values.to || ""));
  let proposal;
  try {
    proposal = JSON.parse(String(values.proposal || "{}"));
  } catch (error) {
    view.mutationState = "error";
    view.message = "admin.payloadInvalid";
    renderAdminPreservingScroll();
    return;
  }
  if (!lineIDs.length || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to) || !proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    view.mutationState = "error";
    view.message = "admin.payloadInvalid";
    renderAdminPreservingScroll();
    return;
  }
  const proposalKind = values.proposal_kind === "contract" ? "contract" : "policy";
  const payload = { line_ids: lineIDs, from: from.toISOString(), to: to.toISOString(), idempotency_key: `linkwatch-impact-${Date.now()}`, [proposalKind]: proposal };
  view.mutationState = "saving";
  view.preview = null;
  view.message = "";
  renderAdminPreservingScroll();
  try {
    view.preview = objectPayload(await boundaries.admin.impactPreview(payload));
    view.message = "admin.previewReady";
    view.mutationState = "success";
  } catch (error) {
    view.preview = null;
    view.message = "admin.actionFailed";
    view.mutationState = "error";
  }
  renderAdminPreservingScroll();
}

async function submitAdminAgentUpdate(event) {
  event.preventDefault();
  const view = state.admin;
  if (view.mutationState === "saving" || !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  let manifest;
  try {
    manifest = JSON.parse(String(values.manifest || "{}"));
  } catch (error) {
    view.mutationState = "error";
    view.message = "admin.payloadInvalid";
    renderAdminPreservingScroll();
    return;
  }
  const deviceIDs = String(values.device_ids || "").split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || deviceIDs.length < 1 || deviceIDs.length > 100) {
    view.mutationState = "error";
    view.message = "admin.payloadInvalid";
    renderAdminPreservingScroll();
    return;
  }
  view.mutationState = "saving";
  view.message = "";
  renderAdminPreservingScroll();
  try {
    const result = objectPayload(await boundaries.admin.agentUpdate({ manifest, device_ids: deviceIDs }));
    view.payload = JSON.stringify(result, null, 2);
    view.message = "admin.mutationSucceeded";
    view.mutationState = "success";
  } catch (error) {
    view.message = "admin.actionFailed";
    view.mutationState = "error";
  }
  renderAdminPreservingScroll();
}

function parseAdminPayload(root) {
  try {
    const fields = [...root.querySelectorAll("[data-admin-field]")];
    const payload = fields.length
      ? Object.fromEntries(fields.map((field) => {
        if (field.type === "checkbox") return [field.dataset.adminField, field.checked];
        const raw = field.value.trim();
        if (!raw) return [field.dataset.adminField, undefined];
        if (field.dataset.adminField === "scopes") {
          const scopes = raw.split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
            const [scopeType, ...scopeID] = value.split(":");
            return { scope_type: String(scopeType || "").trim().toUpperCase(), scope_id: scopeID.join(":").trim() };
          }).filter((scope) => scope.scope_type && scope.scope_id);
          return [field.dataset.adminField, scopes];
        }
        if (ADMIN_EDITOR_STRUCTURED_FIELDS.has(field.dataset.adminField)) return [field.dataset.adminField, JSON.parse(raw)];
        if (adminNumberField(field.dataset.adminField)) {
          const numeric = Number(raw);
          if (!Number.isFinite(numeric) || (adminIntegerField(field.dataset.adminField) && !Number.isInteger(numeric))) throw new Error("number expected");
          return [field.dataset.adminField, numeric];
        }
        if (ADMIN_EDITOR_DATETIME_FIELDS.has(field.dataset.adminField)) {
          const date = new Date(raw);
          if (Number.isNaN(date.getTime())) throw new Error("date expected");
          return [field.dataset.adminField, date.toISOString()];
        }
        return [field.dataset.adminField, raw];
      }).filter(([, value]) => value !== undefined))
      : JSON.parse(root.querySelector("[name=payload]")?.value || "{}");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("object expected");
    return { id: root.querySelector("[name=recordId]")?.value.trim() || "", mode: root.dataset.adminMode || "", payload };
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.payloadInvalid";
    renderAdminPreservingScroll();
    return null;
  }
}

function isDestructiveAdminPayload(resource, payload, action = "save") {
  return action !== "save" || payload?.disabled === true || payload?.active === false || payload?.blocked === true || payload?.status === "DELETED" || (resource === "users" && payload?.password);
}

async function submitAdminMutation(event) {
  event.preventDefault();
  if (state.admin.mutationState === "saving") return;
  const parsed = parseAdminPayload(event.currentTarget);
  if (!parsed) return;
  const { id, mode: requestedMode, payload } = parsed;
  const resource = state.admin.resource;
  const mode = requestedMode || adminEditorMode(resource, id, state.admin.editorIntent);
  if (!mode) return;
  let normalizedPayload;
  try {
    normalizedPayload = mode === "register" ? payload : writableAdminPayload(resource, payload, { id, operation: mode });
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.actionFailed";
    renderAdminPreservingScroll();
    return;
  }
  if (isDestructiveAdminPayload(resource, normalizedPayload) && !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  if (!isDestructiveAdminPayload(resource, payload) && !globalThis.confirm?.(i18n.t("admin.confirmSave"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminPreservingScroll();
  try {
    const result = mode === "register" ? await boundaries.admin.registerDevice(payload) : await boundaries.admin.save(resource, mode === "create" ? "" : id, normalizedPayload);
    const resultPayload = objectPayload(result);
    if (mode === "register" && resultPayload?.device_token) {
      state.admin.credential = { deviceID: resultPayload.device_id || payload.device_id, deviceToken: resultPayload.device_token, serverURL: globalThis.location?.origin || "" };
    }
    state.admin.selectedId = String(adminRecordId(resultPayload) || id || "");
    state.admin.editorIntent = resource === "devices" && mode === "register" ? "register" : adminResourceConfig(resource)?.supportsUpdate && state.admin.selectedId ? "update" : "create";
    state.admin.payload = JSON.stringify(resultPayload || payload, null, 2);
    state.admin.mutationState = "success";
    state.admin.message = "admin.mutationSucceeded";
    const wasOnboarding = Boolean(state.admin.onboardingRegistryId);
    state.admin.onboardingRegistryId = "";
    await loadAdminResource({ force: true, preserveMessage: true });
    if (state.admin.state === "ready") { state.admin.mutationState = "success"; state.admin.message = wasOnboarding ? "admin.schoolAdded" : "admin.mutationSucceeded"; renderAdminPreservingScroll(); }
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.mutationFailed";
    renderAdminPreservingScroll();
  }
}

async function adminDeviceAction(id, action) {
  if (!id || !state.capabilities.has("admin.devices") || state.admin.mutationState === "saving") return;
  if (!globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminPreservingScroll();
  try {
    const result = objectPayload(await boundaries.admin.deviceAction(id, action));
    if (action === "rotate-token" && result?.device_token) {
      state.admin.credential = { deviceID: result.device_id || id, deviceToken: result.device_token, serverURL: globalThis.location?.origin || "" };
    }
    state.admin.payload = JSON.stringify(result || {}, null, 2);
    state.admin.mutationState = "success";
    state.admin.message = "admin.mutationSucceeded";
    await loadAdminResource({ force: true, preserveMessage: true });
    if (state.admin.state === "ready") { state.admin.mutationState = "success"; state.admin.message = "admin.mutationSucceeded"; renderAdminPreservingScroll(); }
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.actionFailed";
    renderAdminPreservingScroll();
  }
}

async function runAdminImpactPreview() {
  if (state.admin.mutationState === "saving") return;
  const parsed = parseAdminPayload($("#adminSurface"));
  if (!parsed) return;
  state.admin.mutationState = "saving";
  state.admin.preview = null;
  state.admin.message = "";
  renderAdminSurface();
  try {
    state.admin.preview = objectPayload(await boundaries.admin.impactPreview(parsed.payload));
    state.admin.message = "admin.previewReady";
    state.admin.mutationState = "success";
  } catch (error) {
    state.admin.preview = null;
    state.admin.message = "admin.actionFailed";
    state.admin.mutationState = "error";
  }
  renderAdminPreservingScroll();
}

async function runAdminAgentUpdate() {
  if (state.admin.mutationState === "saving") return;
  const parsed = parseAdminPayload($("#adminSurface"));
  if (!parsed || !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminPreservingScroll();
  try {
    state.admin.payload = JSON.stringify(objectPayload(await boundaries.admin.agentUpdate(parsed.payload)), null, 2);
    state.admin.message = "admin.mutationSucceeded";
    state.admin.mutationState = "success";
    await loadAdminResource({ force: true, preserveMessage: true });
    if (state.admin.state === "ready") { state.admin.mutationState = "success"; state.admin.message = "admin.mutationSucceeded"; renderAdminPreservingScroll(); }
  } catch (error) {
    state.admin.message = "admin.actionFailed";
    state.admin.mutationState = "error";
  }
  renderAdminPreservingScroll();
}

function auditMatchesSearch(item, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return true;
  const entry = presentAuditItem(item, { i18n, presentation });
  return [entry.actionLabel, entry.objectLabel, entry.actorLabel, entry.rawAction, entry.rawObjectType, entry.rawObject, entry.rawActor]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
}

function renderAuditSelection(item) {
  if (!item) return '<article class="audit-selection" aria-live="polite"><h2>' + escapeHtml(i18n.t("audit.title")) + '</h2><p class="surface-state">' + escapeHtml(i18n.t("audit.selectHint")) + "</p></article>";
  const entry = presentAuditItem(item, { i18n, presentation });
  const changes = entry.changes.length ? '<div class="audit-changes"><h3>' + escapeHtml(i18n.t("audit.changedFields")) + '</h3><dl>' + entry.changes.map((change) => '<div><dt>' + escapeHtml(change.label) + '</dt><dd><span>' + escapeHtml(change.before) + '</span><b class="audit-change-arrow" aria-hidden="true">' + iconMarkup("arrowRight", { size: 14 }) + '</b><span>' + escapeHtml(change.after) + '</span></dd></div>').join("") + '</dl></div>' : "";
  const technicalPayload = entry.payload || {
    action: entry.rawAction,
    object_type: entry.rawObjectType,
    object_id: entry.rawObject,
    actor_id: entry.rawActor,
  };
  const technical = '<details class="audit-technical-card"><summary>' + escapeHtml(i18n.t("audit.systemEvent")) + '</summary><pre>' + escapeHtml(JSON.stringify(technicalPayload, null, 2)) + '</pre></details>';
  return '<article class="audit-selection" aria-live="polite"><h2>' + escapeHtml(entry.actionLabel) + '</h2><dl class="detail-grid">'
    + '<div><dt>' + escapeHtml(i18n.t("audit.description")) + '</dt><dd>' + escapeHtml(entry.description) + '</dd></div>'
    + '<div><dt>' + escapeHtml(i18n.t("audit.action")) + '</dt><dd>' + escapeHtml(entry.actionLabel) + '</dd></div>'
    + '<div><dt>' + escapeHtml(i18n.t("audit.object")) + '</dt><dd>' + escapeHtml(entry.objectLabel) + '</dd></div>'
    + '<div><dt>' + escapeHtml(i18n.t("audit.actor")) + '</dt><dd>' + escapeHtml(entry.actorLabel) + '</dd></div>'
    + '<div><dt>' + escapeHtml(i18n.t("audit.at")) + '</dt><dd>' + escapeHtml(entry.atLabel) + '</dd></div></dl>' + changes + technical + '</article>';
}

function renderAuditVersionDetail() {
  const view = state.audit;
  const raw = view.versions.find((item) => String(item?.version) === String(view.selectedVersion));
  if (!raw) return '<div class="empty-state"><strong>' + escapeHtml(i18n.t("audit.agentVersions")) + '</strong><span>' + escapeHtml(i18n.t("audit.selectHint")) + '</span></div>';
  const version = presentAgentVersion(raw, { i18n, presentation });
  return '<article class="audit-version-detail"><div class="inspector-top"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("audit.agentVersions")) + '</span><h2>' + escapeHtml(version.version) + '</h2><div class="inspector-sub">' + escapeHtml(version.sourceLabel) + '</div></div><span class="status-pill">' + escapeHtml(i18n.t("audit.devices")) + '</span></div><dl class="facts"><div class="fact"><span>' + escapeHtml(i18n.t("audit.devices")) + '</span><b>' + escapeHtml(String(version.deviceCount)) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("audit.lastSeen")) + '</span><b>' + escapeHtml(version.lastSeenLabel) + '</b></div></dl><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("audit.devices")) + '</h3><span>' + escapeHtml(version.version) + '</span></div>' + renderAuditDevices() + '</section></article>';
}

function renderAuditSurface() {
  const root = $("#auditSurface");
  if (!root) return;
  const view = state.audit;
  root.hidden = router.getState().view !== "audit" || !state.capabilities.has("audit.read");
  if (root.hidden) return;
  const header = '<header class="panehead template-panehead"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.audit")) + '</span><h1>' + escapeHtml(i18n.t("audit.title")) + '</h1><small>' + escapeHtml(i18n.t("audit.subtitle")) + '</small></div><button type="button" class="icon-button" data-audit-refresh aria-label="' + escapeHtml(i18n.t("audit.refresh")) + '">' + iconMarkup("refresh", { size: 17 }) + '</button></header>';
  const tabs = '<div class="segmented template-segmented audit-tabs"><button type="button" class="' + (view.tab === "log" ? "on" : "") + '" data-audit-tab="log">' + escapeHtml(i18n.t("audit.title")) + '</button><button type="button" class="' + (view.tab === "versions" ? "on" : "") + '" data-audit-tab="versions">' + escapeHtml(i18n.t("audit.agentVersions")) + '</button></div>';
  if (view.tab === "versions") {
    const content = view.versionsState === "loading" ? '<p class="surface-state" role="status">' + escapeHtml(i18n.t("audit.versionsLoading")) + '</p>' : view.versionsState === "error" ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("audit.versionsUnavailable")) + '</p>' : view.versions.length ? view.versions.map((item) => { const version = presentAgentVersion(item, { i18n, presentation }); const selected = String(view.selectedVersion) === String(version.version); return '<button type="button" class="listitem audit-version-row' + (selected ? ' selected sel' : '') + '" data-audit-version="' + escapeHtml(version.version) + '"><h3>' + escapeHtml(version.version) + '</h3><p>' + escapeHtml(version.sourceLabel) + '</p><div class="meta"><span>' + escapeHtml(i18n.t("audit.devices")) + ': ' + escapeHtml(String(version.deviceCount)) + '</span><span class="sep"></span><span>' + escapeHtml(version.lastSeenLabel) + '</span></div></button>'; }).join("") : '<p class="surface-state">' + escapeHtml(i18n.t("audit.versionsEmpty")) + '</p>';
    root.innerHTML = '<div class="template-screen structural-surface workspace split template-workspace audit-workspace"><aside class="pane audit-list-pane">' + header + tabs + '<div class="list template-list audit-version-list">' + content + '</div></aside><section class="inspector template-inspector audit-inspector">' + renderAuditVersionDetail() + '</section></div>';
  } else {
    const actionOptions = [...new Set(view.items.map((item) => item?.action || item?.event_type).filter(Boolean))].map((value) => { const action = presentAuditItem({ action: value }, { i18n, presentation }); return '<option value="' + escapeHtml(value) + '"' + (view.filters.action === value ? " selected" : "") + '>' + escapeHtml(action.actionLabel) + "</option>"; }).join("");
    const objectOptions = [...new Set(view.items.map((item) => item?.object_type).filter(Boolean))].map((value) => { const object = presentAuditItem({ object_type: value }, { i18n, presentation }); return '<option value="' + escapeHtml(value) + '"' + (view.filters.object_type === value ? " selected" : "") + '>' + escapeHtml(object.objectLabel) + "</option>"; }).join("");
    const filteredItems = view.items.filter((item) => auditMatchesSearch(item, view.search));
    const selected = filteredItems.find((item) => String(item?.id) === String(view.selectedId)) || null;
    const rows = filteredItems.map((item) => {
      const entry = presentAuditItem(item, { i18n, presentation });
      const selectedClass = String(view.selectedId) === String(entry.id) ? " selected" : "";
      return '<article class="audit-record' + selectedClass + '"><button type="button" class="audit-record-trigger" data-audit-select="' + escapeHtml(entry.id) + '" aria-pressed="' + String(String(view.selectedId) === String(entry.id)) + '"><span class="audit-record-head"><strong>' + escapeHtml(entry.actionLabel) + '</strong><span>' + escapeHtml(entry.atLabel) + '</span></span><span class="audit-record-description">' + escapeHtml(entry.description) + '</span><span class="audit-record-summary"><span>' + escapeHtml(i18n.t("audit.object")) + ': ' + escapeHtml(entry.objectLabel) + '</span><span>' + escapeHtml(i18n.t("audit.actor")) + ': ' + escapeHtml(entry.actorLabel) + '</span></span></button></article>';
    }).join("");
    const content = view.state === "loading" ? '<p class="surface-state" role="status">' + escapeHtml(i18n.t("audit.loading")) + '</p>' : view.state === "error" ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("audit.unavailable")) + '</p>' : rows || '<p class="surface-state">' + escapeHtml(i18n.t(view.search ? "audit.noSearchResults" : "audit.empty")) + '</p>';
    const loadMore = view.hasMore ? '<button type="button" class="secondary-action audit-load-more" data-audit-load-more' + (view.loadingMore ? " disabled" : "") + '>' + escapeHtml(i18n.t(view.loadingMore ? "audit.loadingMore" : "audit.loadMore")) + '</button>' : "";
    const loadMoreError = view.loadMoreError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.loadMoreError)) + '</p>' : "";
    const filterForm = '<form class="audit-filters" data-audit-filters><label>' + escapeHtml(i18n.t("audit.search")) + '<input type="search" name="search" value="' + escapeHtml(view.search) + '" placeholder="' + escapeHtml(i18n.t("audit.searchPlaceholder")) + '" /></label><label>' + escapeHtml(i18n.t("audit.action")) + '<select name="action"><option value="">' + escapeHtml(i18n.t("audit.anyAction")) + '</option>' + actionOptions + '</select></label><label>' + escapeHtml(i18n.t("audit.object")) + '<select name="object_type"><option value="">' + escapeHtml(i18n.t("audit.anyObject")) + '</option>' + objectOptions + '</select></label><button type="submit" class="secondary-action">' + escapeHtml(i18n.t("audit.applyFilters")) + '</button><button type="button" class="link-action audit-reset" data-audit-reset>' + escapeHtml(i18n.t("audit.resetFilters")) + '</button></form>';
    root.innerHTML = '<div class="template-screen structural-surface workspace split template-workspace audit-workspace"><aside class="pane audit-list-pane">' + header + tabs + filterForm + '<div class="list template-list audit-record-list">' + content + '</div>' + loadMoreError + loadMore + '</aside><section class="inspector template-inspector audit-inspector">' + renderAuditSelection(selected) + '</section></div>';
  }
  bindAuditSurfaceEvents(root);
}

function renderAuditDevices() {
  const view = state.audit;
  if (view.devicesState === "loading") return '<p class="surface-state" role="status">' + escapeHtml(i18n.t("audit.versionsLoading")) + '</p>';
  if (view.devicesState === "error") return '<p class="surface-state error">' + escapeHtml(i18n.t("audit.devicesUnavailable")) + '</p>';
  if (!view.devices.length) return '<p class="surface-state">' + escapeHtml(i18n.t("audit.devicesEmpty")) + '</p>';
  return '<ul class="audit-device-list">' + view.devices.map((device) => '<li><strong>' + escapeHtml(device.display_name || device.hostname || device.device_id || i18n.t("empty.noData")) + '</strong><span>' + escapeHtml(device.school_name || device.organization_name || i18n.t("empty.noData")) + '</span><time>' + escapeHtml(presentation.formatDate(device.last_seen, true)) + '</time></li>').join("") + '</ul>';
}

function bindAuditSurfaceEvents(root) {
  root.querySelector("[data-audit-refresh]")?.addEventListener("click", () => state.audit.tab === "versions" ? loadAgentVersions({ force: true }) : loadAuditLog({ force: true }));
  root.querySelectorAll("[data-audit-tab]").forEach((button) => button.addEventListener("click", () => { state.audit.tab = button.dataset.auditTab; if (state.audit.tab === "versions") loadAgentVersions(); else loadAuditLog(); }));
  root.querySelector("[data-audit-filters]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    state.audit.search = String(values.search || "");
    state.audit.filters = { action: String(values.action || ""), object_type: String(values.object_type || "") };
    state.audit.selectedId = "";
    loadAuditLog({ force: true });
  });
  root.querySelector("[data-audit-reset]")?.addEventListener("click", () => {
    state.audit.search = "";
    state.audit.filters = { action: "", object_type: "" };
    state.audit.selectedId = "";
    loadAuditLog({ force: true });
  });
  root.querySelectorAll("[data-audit-select]").forEach((button) => button.addEventListener("click", () => {
    state.audit.selectedId = button.dataset.auditSelect || "";
    renderAuditSurface();
    root.querySelector("[data-audit-select][aria-pressed=\"true\"]")?.focus();
  }));
  root.querySelector("[data-audit-load-more]")?.addEventListener("click", () => loadMoreAudit());
  root.querySelectorAll("[data-audit-version]").forEach((button) => button.addEventListener("click", () => loadVersionDevices(button.dataset.auditVersion)));
}

async function loadAuditLog({ force = false } = {}) {
  const view = state.audit;
  if (!session.authenticated || !state.capabilities.has("audit.read") || router.getState().view !== "audit") return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderAuditSurface(); return; }
  view.nextBeforeId = "";
  view.hasMore = false;
  view.loadingMore = false;
  view.loadMoreError = "";
  view.state = "loading";
  renderAuditSurface();
  view.loadPromise = boundaries.audit.list({ limit: "50", ...view.filters, search: view.search }).then((response) => {
    view.items = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
    view.nextBeforeId = response?.next_before_id || "";
    view.hasMore = response?.has_more === true && Boolean(view.nextBeforeId);
    view.state = "ready";
  }).catch(() => { view.items = []; view.state = "error"; }).finally(() => { view.loadPromise = null; renderAuditSurface(); });
  return view.loadPromise;
}

async function loadMoreAudit() {
  const view = state.audit;
  if (!session.authenticated || !state.capabilities.has("audit.read") || router.getState().view !== "audit" || !view.hasMore || !view.nextBeforeId || view.loadingMore) return;
  view.loadingMore = true;
  view.loadMoreError = "";
  renderAuditSurface();
  try {
    const response = await boundaries.audit.list({ limit: "50", ...view.filters, search: view.search, before_id: view.nextBeforeId });
    const nextItems = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
    const knownIDs = new Set(view.items.map((item) => String(item?.id || "")));
    view.items = view.items.concat(nextItems.filter((item) => {
      const id = String(item?.id || "");
      return id && !knownIDs.has(id);
    }));
    view.nextBeforeId = response?.next_before_id || "";
    view.hasMore = response?.has_more === true && Boolean(view.nextBeforeId);
  } catch (error) {
    view.loadMoreError = "audit.unavailable";
  } finally {
    view.loadingMore = false;
    renderAuditSurface();
  }
}

async function loadAgentVersions({ force = false } = {}) {
  const view = state.audit;
  if (!session.authenticated || !state.capabilities.has("audit.read") || router.getState().view !== "audit") return;
  if (view.versionsState === "loading") return;
  if (view.versionsState === "ready" && !force) { renderAuditSurface(); return; }
  view.versionsState = "loading";
  renderAuditSurface();
  try { view.versions = await boundaries.audit.agentVersions("limit=50"); view.versionsState = "ready"; } catch (error) { view.versions = []; view.versionsState = "error"; }
  renderAuditSurface();
}

async function loadVersionDevices(version) {
  const view = state.audit;
  view.selectedVersion = version;
  view.devicesState = "loading";
  renderAuditSurface();
  try { view.devices = await boundaries.audit.versionDevices(version); view.devicesState = "ready"; } catch (error) { view.devices = []; view.devicesState = "error"; }
  renderAuditSurface();
}

function renderIncidentActionControls(detail) {
  const view = incidentSurfaceState();
  const available = incidentActions(detail, state.capabilities, "idle");
  const actions = incidentActions(detail, state.capabilities, view.actionState);
  const disabled = actions.isPending ? " disabled" : "";
  const statusControls = [];
  const assigneeControls = [];
  const actionControls = [];
  if (available.canMarkProviderFixed) {
    actionControls.push('<form class="incident-action-form" data-incident-action-form data-incident-action="provider_fixed"><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(actionCopy("incidentProviderFixed")) + "</button></form>");
  }
  if (available.canSendToProvider) {
    actionControls.push('<form class="incident-action-form" data-incident-action-form data-incident-action="send_to_provider"><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(actionCopy("incidentSendToProvider")) + "</button></form>");
  }
  if (available.canAssign) {
    assigneeControls.push('<form class="incident-action-form" data-incident-action-form data-incident-action="assign"><label>' + escapeHtml(i18n.t("field.assignee")) + '<input name="note" required maxlength="255" value="' + escapeHtml(detail?.assignee || "") + '"' + disabled + '></label><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(actionCopy("incidentAssign")) + "</button></form>");
  }
  if (available.canChangeStatus) {
    const options = INCIDENT_STATUS_OPTIONS.map((status) => '<option value="' + escapeHtml(status) + '"' + (status === String(detail?.status || "").toUpperCase() ? " selected" : "") + ">" + escapeHtml(presentation.incidentStatus(status)) + "</option>").join("");
    statusControls.push('<form class="incident-action-form" data-incident-action-form data-incident-action="status"><label>' + escapeHtml(i18n.t("field.status")) + '<select name="status" required' + disabled + '>' + options + '</select></label><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(actionCopy("incidentStatus")) + "</button></form>");
  }
  if (!statusControls.length && !assigneeControls.length && !actionControls.length && !view.actionError && !view.actionMessage) return "";
  const error = view.actionError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.actionError)) + "</p>" : "";
  const success = view.actionMessage ? '<p class="action-feedback success" role="status">' + escapeHtml(i18n.t(view.actionMessage)) + "</p>" : "";
  const group = (controls, className) => controls.length ? '<div class="incident-action-group ' + className + '">' + controls.join("") + "</div>" : "";
  return '<section class="incident-actions"><h3>' + escapeHtml(i18n.t("incidents.workflow")) + "</h3><div class=\"incident-action-controls\">" + group(statusControls, "incident-status-group") + group(assigneeControls, "incident-assignee-group") + group(actionControls, "incident-actions-group") + "</div>" + success + error + "</section>";
}

function renderIncidentDetail() {
  const view = incidentSurfaceState();
  if (!view.selectedId) return '<p class="surface-state">' + escapeHtml(i18n.t("incidents.select")) + "</p>";
  if (view.detailState === "loading") return '<p class="surface-state">' + escapeHtml(i18n.t("incidents.detailLoading")) + "</p>";
  if (view.detailState === "error" || !view.detail) return '<p class="surface-state error">' + escapeHtml(i18n.t("incidents.detailUnavailable")) + "</p>";
  if (view.selectedSituationId) return renderSituationDetail();

  const detail = view.detail;
  const incident = presentIncident(detail, { i18n, presentation });
  const incidentActionsState = incidentActions(detail, state.capabilities, view.actionState);
  const recovery = presentRecovery(detail, { i18n });
  const confirmation = detail?.evidence_chain?.confirmation;
  const evidenceCount = Number(confirmation?.count);
  const confirmed = Number.isFinite(evidenceCount) && evidenceCount > 0
    ? i18n.t("incidents.evidenceCount", { count: evidenceCount })
    : i18n.t("incidents.evidenceUnavailable");
  const events = presentTimeline(detail.events, { i18n, presentation });
  const timeline = events.length ? events.map((event) => '<li><time>' + escapeHtml(event.atLabel) + '</time><div><strong>' + escapeHtml(event.label) + "</strong>" + (event.note ? '<p>' + escapeHtml(event.note) + "</p>" : "") + (event.status ? '<small>' + escapeHtml(event.status) + "</small>" : "") + (event.actor ? '<small class="timeline-actor">' + escapeHtml(event.actor) + "</small>" : "") + "</div></li>").join("") : '<p class="surface-state">' + escapeHtml(i18n.t("incidents.timelineEmpty")) + "</p>";
  const lineAvailable = Boolean(map.getLine(detail.line_id));
  const canComment = incidentActionsState.canComment;
  const commentFeedback = view.commentMessage ? '<p class="action-feedback ' + (view.commentState === "error" ? "error" : "success") + '" role="status">' + escapeHtml(i18n.t(view.commentMessage)) + "</p>" : "";
  const commentForm = canComment ? '<form class="incident-comment-form" data-incident-comment><label class="visually-hidden" for="incidentComment">' + escapeHtml(i18n.t("incidents.comment")) + '</label><textarea id="incidentComment" required maxlength="4000" placeholder="' + escapeHtml(i18n.t("incidents.commentPlaceholder")) + '"></textarea><button class="secondary-action" type="submit"' + (view.commentState === "saving" ? " disabled" : "") + '>' + escapeHtml(i18n.t(view.commentState === "success" ? "incidents.commentSent" : "incidents.sendComment")) + "</button>" + commentFeedback + "</form>" : "";
  const closedNotice = incidentActionsState.closed ? '<p class="closed-readonly" role="status">' + escapeHtml(i18n.t("incidents.closedReadOnly")) + "</p>" : "";
  return '<div class="inspector-top"><div><span class="surface-eyebrow">' + escapeHtml(incident.severityLabel) + '</span><h2>' + escapeHtml(incident.school) + ' · ' + escapeHtml(incident.typeLabel) + '</h2><div class="inspector-sub">' + escapeHtml(incident.number) + ' · ' + escapeHtml(incident.startedLabel) + '</div></div><span class="status-pill severity-' + escapeHtml(incident.severity.toLowerCase()) + '">' + escapeHtml(incident.statusLabel) + '</span></div>' + closedNotice + '<div class="facts"><div class="fact"><span>' + escapeHtml(i18n.t("field.assignee")) + '</span><b>' + escapeHtml(detail.assignee || i18n.t("empty.noData")) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("field.line")) + '</span><b>' + escapeHtml(incident.line) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("incidents.confirmed")) + '</span><b>' + escapeHtml(confirmed) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("incidents.recovery")) + '</span><b>' + escapeHtml(recovery.label) + '</b></div></div><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("incidents.what")) + '</h3><span>' + escapeHtml(incident.source || i18n.t("empty.noData")) + '</span></div><p class="inspector-copy">' + escapeHtml(incident.description || incident.typeLabel) + '</p>' + (lineAvailable ? '<button class="secondary-action" type="button" data-incident-open-line="' + escapeHtml(detail.line_id) + '">' + escapeHtml(i18n.t("incidents.openLine")) + '</button>' : '') + '</section><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("incidents.timelineGroup")) + '</h3><span>' + escapeHtml(incident.lastUpdateLabel) + '</span></div><ol class="timeline incident-timeline">' + timeline + '</ol></section><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("incidents.comment")) + '</h3></div><div class="composer">' + commentForm + '</div></section>' + renderIncidentActionControls(detail) + renderProviderCaseContext(detail) + renderSituationContext(detail.id);
}

function renderProviderCaseContext(incident) {
  const view = incidentSurfaceState();
  const providerView = view.providerCase;
  const cases = Array.isArray(incident.provider_cases) ? incident.provider_cases : [];
  const canPrepare = providerCaseActions({ incident }, state.capabilities).canPrepare && incidentActions(incident, state.capabilities).closed !== true;
  const list = cases.length ? '<ul class="case-summary">' + cases.map((item) => {
    const current = String(providerView.selectedId) === String(item.id);
    return '<li><button class="link-action" type="button" data-provider-case-id="' + escapeHtml(item.id) + '"' + (current ? ' aria-current="true"' : "") + '>' + escapeHtml(i18n.t("field.providerCase")) + " #" + escapeHtml(item.ticket_no || item.external_ticket_no || item.id) + ' <span>' + escapeHtml(presentation.deliveryStatus(item.delivery_status)) + "</span></button></li>";
  }).join("") + "</ul>" : '<p class="detail-muted">' + escapeHtml(i18n.t("incidents.noRelatedCases")) + "</p>";
  const providerBusy = providerView.actionState !== "idle";
  const create = canPrepare
    ? '<button class="secondary-action provider-case-prepare" type="button" data-provider-case-prepare' + (providerBusy ? " disabled" : "") + ">" + escapeHtml(i18n.t(cases.length ? "providerCase.prepareAnother" : "providerCase.prepare")) + "</button>"
    : !cases.length ? '<p class="detail-muted">' + escapeHtml(i18n.t("providerCase.unavailable")) + "</p>" : "";
  const actionError = !providerView.selectedId && providerView.actionError ? '<p class="provider-case-error" role="alert">' + escapeHtml(i18n.t(providerView.actionError)) + "</p>" : "";
  return '<section class="section provider-case-context"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("incidents.relatedCases")) + '</h3><span>' + escapeHtml(i18n.t("providerCase.steps")) + '</span></div>' + list + create + actionError + '</section>';
}

function renderSelectedProviderCase() {
  const providerView = incidentSurfaceState().providerCase;
  if (!providerView.selectedId) return "";
  if (providerView.state === "loading") return '<p class="detail-muted" role="status">' + escapeHtml(i18n.t("providerCase.loading")) + "</p>";
  if (providerView.state === "error" || !providerView.detail) return '<p class="provider-case-error" role="alert">' + escapeHtml(i18n.t("providerCase.detailUnavailable")) + "</p>";
  const item = presentProviderCase(providerView.detail, { i18n, presentation });
  const actions = providerCaseActions(providerView.detail, state.capabilities);
  const detail = providerView.detail;
  const summary = incidentSurfaceState().cases.find((candidate) => String(candidate?.id) === String(providerView.selectedId)) || {};
  const schoolName = detail.organization_name || detail.school_name || summary.organization_name || summary.school_name || i18n.t("school.noOfficialName");
  const providerName = detail.provider_name || summary.provider_name || i18n.t("empty.value");
  const lineID = detail.line_id || summary.line_id || detail.incident?.line_id || i18n.t("empty.value");
  const incidentReference = detail.incident_no || summary.incident_no || detail.incident?.incident_no || (detail.incident_id || summary.incident_id ? i18n.t("incidents.number") + " #" + (detail.incident_id || summary.incident_id) : "");
  const metadata = '<div class="facts"><div class="fact"><span>' + escapeHtml(i18n.t("providerCase.source")) + '</span><b>' + escapeHtml(item.sourceLabel) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("providerCase.status")) + '</span><b>' + escapeHtml(item.statusLabel) + ' · ' + escapeHtml(item.deliveryLabel) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("field.school")) + '</span><b>' + escapeHtml(schoolName) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("field.provider")) + '</span><b>' + escapeHtml(providerName) + '</b></div><div class="fact"><span>' + escapeHtml(i18n.t("field.line")) + '</span><b>' + escapeHtml(lineID) + '</b></div>' + (incidentReference ? '<div class="fact"><span>' + escapeHtml(i18n.t("field.incident")) + '</span><b>' + escapeHtml(incidentReference) + '</b></div>' : "") + '<div class="fact"><span>' + escapeHtml(i18n.t("providerCase.createdAt")) + '</span><b>' + escapeHtml(item.createdAtLabel) + '</b></div></div><dl class="detail-grid provider-case-fields"><div><dt>' + escapeHtml(i18n.t("providerCase.lastVerified")) + '</dt><dd>' + escapeHtml(item.lastVerifiedLabel) + '</dd></div><div><dt>' + escapeHtml(i18n.t("providerCase.provenance")) + '</dt><dd>' + escapeHtml(item.provenanceLabel) + '</dd></div>' + (item.externalReference ? '<div><dt>' + escapeHtml(i18n.t("providerCase.reference")) + '</dt><dd>' + escapeHtml(item.externalReference) + '</dd></div>' : '') + (item.status === "SENT" ? '<div><dt>' + escapeHtml(i18n.t("providerCase.sentAt")) + '</dt><dd>' + escapeHtml(item.sentAtLabel) + '</dd></div>' : '') + '</dl>';
  const automatic = providerView.generated?.provider ? '<p class="detail-muted">' + escapeHtml(i18n.t("providerCase.automaticDraft")) + "</p>" : "";
  const closedNotice = actions.parentClosed ? '<p class="closed-readonly" role="status">' + escapeHtml(i18n.t("providerCase.closedReadOnly")) + "</p>" : "";
  const draft = item.text ? '<label class="provider-case-text"><span>' + escapeHtml(i18n.t("providerCase.text")) + '</span><textarea data-provider-case-text maxlength="32768"' + (actions.canEdit ? "" : " readonly") + ">" + escapeHtml(item.text) + "</textarea></label>" : '<p class="provider-case-error">' + escapeHtml(i18n.t("providerCase.textUnavailable")) + "</p>";
  const generate = actions.canGenerate ? '<button class="secondary-action" type="button" data-provider-case-generate' + (providerView.actionState !== "idle" ? " disabled" : "") + ">" + escapeHtml(i18n.t("providerCase.prepareAutomatic")) + "</button>" : "";
  const save = actions.canEdit && item.text ? '<button class="secondary-action" type="button" data-provider-case-save' + (providerView.actionState !== "idle" ? " disabled" : "") + ">" + escapeHtml(i18n.t("providerCase.saveDraft")) + "</button>" : "";
  const sent = item.status === "SENT" ? '<span class="provider-case-sent" role="status">' + escapeHtml(i18n.t("providerCase.sent")) + "</span>" : "";
  const send = actions.canSend && item.text ? '<form class="provider-case-send" data-provider-case-send><label><input type="checkbox" data-provider-case-reviewed required' + (providerView.actionState !== "idle" ? " disabled" : "") + ' /> ' + escapeHtml(i18n.t("providerCase.reviewed")) + '</label><button class="primary-action" type="submit" data-provider-case-submit' + (providerView.actionState !== "idle" ? " disabled" : "") + ' disabled>' + escapeHtml(i18n.t(actions.isRetry ? "providerCase.retry" : "providerCase.send")) + "</button></form>" : sent;
  const actionFeedback = providerView.actionError ? '<p class="provider-case-error" role="alert">' + escapeHtml(i18n.t(providerView.actionError)) + "</p>" : providerView.actionMessage ? '<p class="action-feedback success" role="status">' + escapeHtml(i18n.t(providerView.actionMessage)) + "</p>" : "";
  const delivery = item.deliveryError ? '<div class="provider-case-delivery" role="alert"><strong>' + escapeHtml(i18n.t("providerCase.deliveryFailed")) + "</strong><p>" + escapeHtml(i18n.t("providerCase.deliveryAttempts", { count: item.deliveryAttempts })) + (item.nextAttemptLabel !== i18n.t("empty.value") ? " · " + escapeHtml(i18n.t("providerCase.nextAttempt", { at: item.nextAttemptLabel })) : "") + "</p><p>" + escapeHtml(i18n.t("providerCase.deliveryErrorHint")) + "</p></div>" : "";
  const timelineItems = Array.isArray(detail.timeline) ? detail.timeline : [];
  const timeline = timelineItems.length ? '<ol class="timeline">' + timelineItems.map((event) => '<li><time>' + escapeHtml(presentation.formatDate(event?.created_at || event?.at, true)) + '</time><div><strong>' + escapeHtml(event?.event_type || event?.status || i18n.t("providerCase.status")) + '</strong>' + (event?.note ? '<p>' + escapeHtml(event.note) + '</p>' : '') + '</div></li>').join('') + '</ol>' : '<p class="detail-muted">' + escapeHtml(i18n.t("incidents.timelineEmpty")) + '</p>';
  return '<article class="provider-case-detail template-case-editor"><div class="inspector-top"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.cases")) + '</span><h2>' + escapeHtml(i18n.t("providerCase.title", { reference: item.reference })) + '</h2><div class="inspector-sub">' + escapeHtml(i18n.t("providerCase.steps")) + '</div></div><span class="status-pill provider-case-delivery">' + escapeHtml(item.deliveryLabel) + '</span></div>' + metadata + closedNotice + automatic + '<section class="section case-paper"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("providerCase.text")) + '</h3></div>' + draft + '<div class="provider-case-actions">' + generate + save + '</div>' + send + actionFeedback + delivery + '</section><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("incidents.timeline")) + '</h3></div>' + timeline + '</section></article>';
}

function renderSituationContext(incidentId) {
  const view = incidentSurfaceState();
  if (view.situationsState === "loading" || view.situationsState === "idle") return '<section><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3><p class=\"detail-muted\">" + escapeHtml(i18n.t("situation.loading")) + "</p></section>";
  if (view.situationsState === "error") return '<section><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3><p class=\"detail-muted\">" + escapeHtml(i18n.t("situation.unavailable")) + "</p></section>";
  const situations = relatedSituations(view.situations, incidentId);
  const rows = situations.length ? situations.map((item) => {
    const situation = presentSituation(item, { i18n, presentation, capabilities: state.capabilities, actionState: view.situationActionState });
    return '<li><button class="link-action" type="button" data-situation-id="' + escapeHtml(situation.id) + '"><strong>' + escapeHtml(situation.title) + "</strong><span>" + escapeHtml(i18n.t("situation.members", { count: situation.affectedCount })) + " · " + escapeHtml(situation.typeLabel) + "</span></button></li>";
  }).join("") : '<p class="detail-muted">' + escapeHtml(i18n.t("situation.empty")) + "</p>";
  return '<section class="situation-context"><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3><p class=\"detail-muted\">" + escapeHtml(i18n.t("situation.contextHint")) + "</p><ul>" + rows + "</ul></section>";
}

const SITUATION_FACTOR_LABELS = Object.freeze({
  provider_id: "field.provider",
  provider: "field.provider",
  violation_type: "incidents.createType",
  source_type: "field.source",
  manual_review: "situation.manualReview",
  participant_count: "situation.participants",
  affected_participants: "situation.participants",
  evidence_state: "situation.evidence",
});

function situationFactorEntries(situation) {
  const factors = situation?.factors && typeof situation.factors === "object" ? situation.factors : {};
  return Object.entries(factors)
    .filter(([key, value]) => !/^(object|objects|object_id|object_type)$/i.test(key) && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const normalized = String(key).toLowerCase();
      const labelKey = SITUATION_FACTOR_LABELS[normalized];
      const label = labelKey && i18n.has(labelKey)
        ? i18n.t(labelKey)
        : normalized.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
      let display = value;
      if (normalized === "provider_id") display = situation.provider_name || i18n.t("empty.noData");
      else if (normalized === "violation_type") {
        const type = String(value).toUpperCase();
        display = i18n.has("incidentType." + type) ? i18n.t("incidentType." + type) : value;
      } else if (normalized === "manual_review" && typeof value === "boolean") display = i18n.t(value ? "admin.yes" : "admin.no");
      else if (typeof value === "object") display = value.label || value.name || value.title || i18n.t("empty.noData");
      return [label, String(display)];
    });
}

function renderSituationActionControls(situation, members) {
  const view = incidentSurfaceState();
  const available = situationActions(situation, state.capabilities, "idle");
  const actions = situationActions(situation, state.capabilities, view.situationActionState);
  if (!available.hasMutation) return "";
  const disabled = actions.isPending ? " disabled" : "";
  const controls = [];
  if (actions.canLiveVerify) {
    controls.push('<form class="situation-action-form situation-live-verify" data-situation-action-form data-situation-action="live-verify"><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(actionCopy("situationLiveVerify")) + "</button></form>");
  }
  const mergeTargets = view.situations.filter((item) => String(item?.id) !== String(situation?.id) && String(item?.status || "OPEN").toUpperCase() === "OPEN");
  if (actions.canMerge && mergeTargets.length) {
    const options = mergeTargets.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(i18n.t("situation.untitled") + " #" + item.id) + "</option>").join("");
    controls.push('<form class="situation-action-form" data-situation-action-form data-situation-action="merge"><label>' + escapeHtml(actionCopy("situationMergeTargets")) + '<select name="situation_ids" multiple size="' + Math.min(4, mergeTargets.length) + '"' + disabled + '>' + options + '</select></label><label>' + escapeHtml(actionCopy("situationReason")) + '<input name="reason" required maxlength="1000"' + disabled + '></label><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(i18n.t("action.situation.merge")) + "</button></form>");
  }
  if (actions.canSplit && members.length > 1) {
    const checkboxes = members.map((item) => '<label><input type="checkbox" name="incident_ids" value="' + escapeHtml(item.id) + '"' + disabled + ' /> ' + escapeHtml(item.incident_no || item.number || item.id) + " · " + escapeHtml(item.school_name || item.organization_name || i18n.t("school.noOfficialName")) + "</label>").join("");
    controls.push('<form class="situation-action-form" data-situation-action-form data-situation-action="split"><fieldset><legend>' + escapeHtml(actionCopy("situationSplitMembers")) + "</legend>" + checkboxes + '</fieldset><label>' + escapeHtml(actionCopy("situationReason")) + '<input name="reason" required maxlength="1000"' + disabled + '></label><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(i18n.t("action.situation.split")) + "</button></form>");
  }
  if (!controls.length && !view.situationActionError && !view.situationActionMessage) return "";
  const error = view.situationActionError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.situationActionError)) + "</p>" : "";
  const success = view.situationActionMessage ? '<p class="action-feedback success" role="status">' + escapeHtml(i18n.t(view.situationActionMessage)) + "</p>" : "";
  return '<section class="situation-actions"><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3>" + controls.join("") + success + error + "</section>";
}

function renderSituationComparisonRows(title, rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const body = rows.map((row) => {
    const availability = row.average_availability == null ? i18n.t("empty.noData") : formatReportAvailability(row.average_availability, i18n);
    const completeness = row.completeness?.status || i18n.t("empty.noData");
    return '<tr><td>' + escapeHtml(row.organization_name || row.school_id || i18n.t("empty.noData")) + '<small>' + escapeHtml(row.line_id || i18n.t("empty.noData")) + '</small></td><td>' + escapeHtml(String(row.measurement_count ?? i18n.t("empty.noData"))) + '</td><td>' + escapeHtml(availability) + '</td><td>' + escapeHtml(String(row.valid_evidence_count ?? i18n.t("empty.noData"))) + '</td><td>' + escapeHtml(completeness) + '</td></tr>';
  }).join("");
  return '<div class="comparison-group"><div class="sectionhead"><h4>' + escapeHtml(title) + '</h4><span>' + escapeHtml(String(rows.length)) + '</span></div><div class="comparison-table"><table><thead><tr><th>' + escapeHtml(i18n.t("field.school")) + '</th><th>' + escapeHtml(i18n.t("reports.measurements")) + '</th><th>' + escapeHtml(i18n.t("reports.availability")) + '</th><th>' + escapeHtml(i18n.t("situation.evidenceCount")) + '</th><th>' + escapeHtml(i18n.t("field.status")) + '</th></tr></thead><tbody>' + body + '</tbody></table></div></div>';
}

function renderSituationDetail() {
  const view = incidentSurfaceState();
  if (view.situationState === "loading") return '<p class="surface-state">' + escapeHtml(i18n.t("situation.loading")) + "</p>";
  if (view.situationState === "error" || !view.situation) return '<p class="surface-state error">' + escapeHtml(i18n.t("situation.unavailable")) + "</p>";
  const situation = view.situation;
  const members = Array.isArray(situation.incidents) ? situation.incidents : [];
  const evidence = situation.evidence?.state || "UNKNOWN";
  const comparison = view.situationComparison;
  const treatmentRows = Array.isArray(comparison?.treatment) ? comparison.treatment : [];
  const controlRows = Array.isArray(comparison?.controls) ? comparison.controls : [];
  const comparisonBody = view.comparisonState === "loading"
    ? '<p class="detail-muted" role="status">' + escapeHtml(i18n.t("situation.loading")) + '</p>'
    : view.comparisonState === "error"
      ? '<p class="surface-state error">' + escapeHtml(i18n.t("situation.unavailable")) + '</p>'
      : treatmentRows.length || controlRows.length
        ? renderSituationComparisonRows(i18n.t("situation.treatment"), treatmentRows) + renderSituationComparisonRows(i18n.t("situation.controls"), controlRows)
        : '<p class="detail-muted">' + escapeHtml(i18n.t("reports.empty")) + '</p>';
  const factorEntries = situationFactorEntries(situation);
  const back = router.getState().view === "incidents" ? '<button class="link-action back-action" type="button" data-situation-back>' + escapeHtml(i18n.t("situation.backToIncident")) + '</button>' : "";
  return '<article class="inspector">' + back + '<div class="inspector-top"><div><span class="surface-eyebrow">' + escapeHtml(i18n.t("nav.situations")) + '</span><h2>' + escapeHtml(i18n.t("situation.detailTitle")) + ' #' + escapeHtml(situation.id) + '</h2><div class="inspector-sub">' + escapeHtml(i18n.t("situation.readOnly")) + '</div></div><span class="status-pill">' + escapeHtml(String(situation.status || evidence)) + '</span></div><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("situation.factors")) + '</h3><span>' + escapeHtml(i18n.t("situation.evidence")) + '</span></div><div class="factorgrid">' + (factorEntries.length ? factorEntries.map(([key, value]) => '<div class="factor"><span>' + escapeHtml(key) + '</span><b>' + escapeHtml(value) + '</b></div>').join('') : '<p class="detail-muted">' + escapeHtml(i18n.t("empty.noData")) + '</p>') + '</div></section><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("situation.evidence")) + '</h3><span>' + escapeHtml(i18n.has("situation.evidence." + evidence) ? i18n.t("situation.evidence." + evidence) : i18n.t("situation.evidence.UNKNOWN")) + '</span></div><p class="inspector-copy">' + escapeHtml(situation.reason || i18n.t("situation.readOnly")) + '</p></section><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("situation.memberIncidents")) + '</h3><span>' + escapeHtml(String(members.length)) + '</span></div><div class="memberlist">' + (members.length ? members.map((item) => '<button class="member" type="button" data-situation-incident-id="' + escapeHtml(item.id) + '"><span><b>' + escapeHtml(item.incident_no || item.number || item.id) + '</b><small>' + escapeHtml(item.school_name || item.organization_name || i18n.t("school.noOfficialName")) + '</small></span><span class="status-pill">' + escapeHtml(presentation.incidentStatus(item.status)) + '</span></button>').join('') : '<p class="detail-muted">' + escapeHtml(i18n.t("situation.empty")) + '</p>') + '</div></section><section class="section"><div class="sectionhead"><h3>' + escapeHtml(i18n.t("reports.analytics")) + '</h3><button class="secondary-action" type="button" data-situation-comparison>' + escapeHtml(i18n.t("reports.apply")) + '</button></div>' + comparisonBody + '</section>' + renderSituationActionControls(situation, members) + '</article>';
}

function incidentActionAllowed(actions, action) {
  return {
    provider_fixed: actions.canMarkProviderFixed,
    send_to_provider: actions.canSendToProvider,
    assign: actions.canAssign,
    status: actions.canChangeStatus,
  }[action] === true;
}

async function submitIncidentAction(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  const detail = view.detail;
  const action = event.currentTarget.dataset.incidentAction;
  const actions = incidentActions(detail, state.capabilities, view.actionState);
  if (!detail || !view.selectedId || !incidentActionAllowed(actions, action)) return;
  const note = event.currentTarget.elements.note?.value.trim() || "";
  const status = event.currentTarget.elements.status?.value || "";
  if (action === "assign" && !note) { showToast("error.422", "warn"); return; }
  if (action === "status" && !INCIDENT_STATUS_OPTIONS.includes(status)) { showToast("error.422", "warn"); return; }
  const confirmationKey = {
    provider_fixed: "confirmIncidentProviderFixed",
    send_to_provider: "confirmIncidentSendToProvider",
    assign: "confirmIncidentAssign",
    status: "confirmIncidentStatus",
  }[action];
  if (!confirmAction(confirmationKey)) return;
  const incidentID = view.selectedId;
  view.actionState = action;
  view.actionError = "";
  view.actionMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const response = objectPayload(await boundaries.incidents.addEvent(incidentID, { event_type: action, note, status }));
    const readback = objectPayload(await boundaries.incidents.get(incidentID));
    if (String(view.selectedId) !== String(incidentID)) return;
    const next = readback && typeof readback === "object" ? readback : response;
    if (!next || typeof next !== "object") throw new Error("incident readback unavailable");
    view.detail = next;
    const index = view.items.findIndex((item) => String(item.id) === String(incidentID));
    if (index >= 0) view.items[index] = next;
    view.detailState = "ready";
    view.actionState = "idle";
    view.actionMessage = "incidents.actionSucceeded";
  } catch (error) {
    if (String(view.selectedId) !== String(incidentID)) return;
    view.actionState = "idle";
    view.actionError = errorMessageKey(error);
  }
  renderIncidentsPreservingScroll();
}

function createdSituationID(result) {
  const ids = result?.created_ids || result?.CreatedIDs || result?.createdIDs;
  return Array.isArray(ids) && ids.length ? ids[0] : "";
}

function situationActionAllowed(actions, action) {
  return {
    "live-verify": actions.canLiveVerify,
    merge: actions.canMerge,
    split: actions.canSplit,
  }[action] === true;
}

async function submitSituationAction(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  const situation = view.situation;
  const action = event.currentTarget.dataset.situationAction;
  const actions = situationActions(situation, state.capabilities, view.situationActionState);
  if (!situation || !view.selectedSituationId || !situationActionAllowed(actions, action)) return;
  const form = event.currentTarget;
  const reason = form.elements.reason?.value.trim() || "";
  const situationIDs = [...(form.elements.situation_ids ? form.elements.situation_ids.selectedOptions : [])].map((option) => option.value);
  const incidentIDs = [...form.querySelectorAll('input[name="incident_ids"]:checked')].map((input) => input.value);
  if (action !== "live-verify" && !reason) { showToast("error.422", "warn"); return; }
  if (action === "merge" && !situationIDs.length) { showToast("error.422", "warn"); return; }
  const members = Array.isArray(situation.incidents) ? situation.incidents : [];
  if (action === "split" && (!incidentIDs.length || incidentIDs.length >= members.length)) { showToast("error.422", "warn"); return; }
  const confirmationKey = action === "live-verify" ? "confirmSituationLiveVerify" : action === "merge" ? "confirmSituationMerge" : "confirmSituationSplit";
  if (!confirmAction(confirmationKey)) return;
  const situationID = view.selectedSituationId;
  view.situationActionState = action === "live-verify" ? "live-verifying" : action === "merge" ? "merging" : "splitting";
  view.situationActionError = "";
  view.situationActionMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const result = action === "live-verify"
      ? objectPayload(await boundaries.incidents.liveVerify(situationID))
      : objectPayload(await boundaries.incidents.manageSituation(situationID, action, { reason, situation_ids: situationIDs, incident_ids: incidentIDs }));
    const readbackID = createdSituationID(result) || situationID;
    const readback = objectPayload(await boundaries.incidents.situation(readbackID));
    const freshSituations = await boundaries.incidents.situations();
    if (String(view.selectedSituationId) !== String(situationID)) return;
    if (!readback || typeof readback !== "object") throw new Error("situation readback unavailable");
    view.situations = Array.isArray(freshSituations) ? freshSituations : view.situations;
    view.selectedSituationId = readbackID;
    view.situation = readback;
    view.situationState = "ready";
    view.situationActionState = "idle";
    view.situationActionMessage = "incidents.actionSucceeded";
  } catch (error) {
    if (String(view.selectedSituationId) !== String(situationID)) return;
    view.situationActionState = "idle";
    view.situationActionError = errorMessageKey(error);
  }
  renderIncidentsPreservingScroll();
}

function cancelIncidentCreate() {
  const view = incidentSurfaceState();
  view.createOpen = false;
  view.createState = "idle";
  view.createError = "";
  view.createDraft = { line_id: "", violation_type: "MANUAL_REVIEW", description: "", assignee: "" };
  renderIncidentsPreservingScroll();
}

function cancelProviderCaseCreate() {
  const view = incidentSurfaceState();
  view.caseCreateOpen = false;
  view.caseCreateState = "idle";
  view.caseCreateError = "";
  view.caseCreateDraft = { line_id: "", comment: "" };
  renderIncidentsPreservingScroll();
}

async function submitProviderCaseCreate(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  if (!state.capabilities.has("provider_case.draft") || view.caseCreateState === "saving") return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  view.caseCreateDraft = { line_id: String(values.line_id || ""), comment: String(values.comment || "").trim() };
  if (!view.caseCreateDraft.line_id) {
    view.caseCreateError = "error.422";
    renderIncidentsPreservingScroll();
    return;
  }
  view.caseCreateState = "saving";
  view.caseCreateError = "";
  renderIncidentsPreservingScroll();
  try {
    const created = objectPayload(await boundaries.providerCases.create({ line_id: view.caseCreateDraft.line_id, comment: view.caseCreateDraft.comment, locale: i18n.locale }));
    view.caseCreateOpen = false;
    view.caseCreateState = "idle";
    view.caseCreateDraft = { line_id: "", comment: "" };
    await loadProviderCases({ force: true });
    if (created?.id !== undefined && created?.id !== null) await selectProviderCaseFromRoute(created.id);
  } catch (error) {
    view.caseCreateState = "error";
    view.caseCreateError = errorMessageKey(error);
  }
  renderIncidentsPreservingScroll();
}

async function submitIncidentCreate(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  if (!state.capabilities.has("incident.create") || view.createState === "saving") return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  view.createDraft = {
    line_id: String(values.line_id || ""),
    violation_type: String(values.violation_type || "MANUAL_REVIEW"),
    description: String(values.description || "").trim(),
    assignee: String(values.assignee || "").trim(),
  };
  if (!view.createDraft.line_id || !view.createDraft.description) {
    view.createError = "error.422";
    renderIncidentsPreservingScroll();
    return;
  }
  view.createState = "saving";
  view.createError = "";
  renderIncidentsPreservingScroll();
  try {
    const payload = { line_id: view.createDraft.line_id, violation_type: view.createDraft.violation_type, description: view.createDraft.description, source: "MANUAL" };
    if (view.createDraft.assignee) payload.assignee = view.createDraft.assignee;
    const created = objectPayload(await boundaries.incidents.create(payload));
    const createdID = created?.id;
    view.createOpen = false;
    view.createState = "idle";
    view.createError = "";
    view.createDraft = { line_id: "", violation_type: "MANUAL_REVIEW", description: "", assignee: "" };
    view.selectedId = null;
    view.detail = null;
    view.detailState = "idle";
    await loadIncidents({ force: true });
    if (createdID !== undefined && createdID !== null) await selectIncident(createdID);
    view.actionMessage = "incidents.created";
    renderIncidentsPreservingScroll();
  } catch (error) {
    view.createState = "error";
    view.createError = "incidents.createFailed";
    renderIncidentsPreservingScroll();
  }
}

function bindIncidentSurfaceEvents(root) {
  root.querySelector("[data-incidents-refresh]")?.addEventListener("click", () => loadIncidents({ force: true }));
  root.querySelector("[data-provider-cases-refresh]")?.addEventListener("click", () => loadProviderCases({ force: true }));
  root.querySelector("[data-provider-case-create-open]")?.addEventListener("click", () => {
    const view = incidentSurfaceState();
    view.caseCreateOpen = true;
    view.caseCreateError = "";
    if (!view.caseCreateDraft.line_id) view.caseCreateDraft.line_id = incidentCreateLines()[0]?.id || "";
    renderIncidentsPreservingScroll();
  });
  root.querySelectorAll("[data-provider-case-create-cancel]").forEach((button) => button.addEventListener("click", cancelProviderCaseCreate));
  root.querySelector("[data-provider-case-create]")?.addEventListener("submit", submitProviderCaseCreate);
  root.querySelectorAll("[data-incident-filter-button]").forEach((button) => button.addEventListener("click", () => {
    incidentSurfaceState().filters.status = button.dataset.incidentFilterButton || "";
    renderIncidentsPreservingScroll();
  }));
  root.querySelector("[data-incident-create-open]")?.addEventListener("click", () => {
    const view = incidentSurfaceState();
    view.createOpen = true;
    view.createError = "";
    if (!view.createDraft.line_id) view.createDraft.line_id = incidentCreateLines()[0]?.id || "";
    renderIncidentsPreservingScroll();
  });
  root.querySelectorAll("[data-incident-create-cancel]").forEach((button) => button.addEventListener("click", cancelIncidentCreate));
  root.querySelector("[data-incident-create]")?.addEventListener("submit", submitIncidentCreate);
  root.querySelectorAll("[data-incident-filter]").forEach((control) => control.addEventListener("change", () => {
    incidentSurfaceState().filters[control.dataset.incidentFilter] = control.value;
    renderIncidentsPreservingScroll();
  }));
  root.querySelector("[data-case-search]")?.addEventListener("input", (event) => {
    incidentSurfaceState().caseFilters.search = event.target.value;
    renderIncidentsPreservingScroll();
    const input = $("[data-case-search]", root);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  root.querySelectorAll("[data-case-filter]").forEach((control) => control.addEventListener("change", () => {
    incidentSurfaceState().caseFilters[control.dataset.caseFilter] = control.value;
    renderIncidentsPreservingScroll();
  }));
  root.querySelector("[data-situation-search]")?.addEventListener("input", (event) => {
    incidentSurfaceState().situationSearch = event.target.value;
    renderIncidentsPreservingScroll();
    const input = $("[data-situation-search]", root);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  root.querySelectorAll("[data-incident-id]").forEach((control) => control.addEventListener("click", () => selectIncident(control.dataset.incidentId)));
  root.querySelectorAll("[data-situation-incident-id]").forEach((control) => control.addEventListener("click", () => {
    router.navigate("incidents");
    void selectIncident(control.dataset.situationIncidentId);
  }));
  root.querySelectorAll("[data-situation-id]").forEach((control) => control.addEventListener("click", () => selectSituation(control.dataset.situationId)));
  root.querySelectorAll("[data-provider-case-id]").forEach((control) => control.addEventListener("click", () => {
    if (router.getState().view === "cases") {
      void selectProviderCaseFromRoute(control.dataset.providerCaseId);
      return;
    }
    router.navigate("cases");
    void selectProviderCaseFromRoute(control.dataset.providerCaseId);
  }));
  root.querySelectorAll("[data-incident-action-form]").forEach((form) => form.addEventListener("submit", submitIncidentAction));
  root.querySelector("[data-provider-case-prepare]")?.addEventListener("click", createIncidentProviderCase);
  root.querySelector("[data-provider-case-generate]")?.addEventListener("click", generateProviderCaseDraft);
  root.querySelector("[data-provider-case-reviewed]")?.addEventListener("change", (event) => {
    const submit = root.querySelector("[data-provider-case-submit]");
    if (submit) submit.disabled = !event.currentTarget.checked;
  });
  root.querySelector("[data-provider-case-save]")?.addEventListener("click", saveProviderCaseDraft);
  root.querySelector("[data-provider-case-send]")?.addEventListener("submit", sendProviderCase);
  root.querySelectorAll("[data-situation-action-form]").forEach((form) => form.addEventListener("submit", submitSituationAction));
  root.querySelector("[data-situation-comparison]")?.addEventListener("click", loadSituationComparison);
  root.querySelector("[data-situation-back]")?.addEventListener("click", () => { const view = incidentSurfaceState(); view.selectedSituationId = null; view.situation = null; view.situationState = "idle"; view.situationActionState = "idle"; view.situationActionError = ""; renderIncidentsPreservingScroll(); });
  root.querySelector("[data-incident-open-line]")?.addEventListener("click", () => openIncidentLine(root.querySelector("[data-incident-open-line]").dataset.incidentOpenLine));
  root.querySelector("[data-incident-comment]")?.addEventListener("submit", submitIncidentComment);
}

async function loadIncidents({ force = false, background = false } = {}) {
  const view = incidentSurfaceState();
  if (!session.authenticated) return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderIncidentsPreservingScroll(); return; }
  if (!background) {
    view.state = "loading";
    renderIncidentsPreservingScroll();
  }
  view.loadPromise = Promise.allSettled([boundaries.incidents.list(), boundaries.incidents.situations()]).then(async ([incidentsResult, situationsResult]) => {
    if (incidentsResult.status !== "fulfilled") {
      if (!background) {
        view.state = "error";
        renderIncidentsPreservingScroll();
      }
      return;
    }
    view.items = incidentsResult.value;
    view.state = "ready";
    view.situations = situationsResult.status === "fulfilled" ? situationsResult.value : [];
    view.situationsState = situationsResult.status === "fulfilled" ? "ready" : "error";
    if (view.selectedId && !view.items.some((item) => String(item.id) === String(view.selectedId))) {
      view.selectedId = null;
      view.detail = null;
      view.detailState = "idle";
      view.selectedSituationId = null;
    }
    renderIncidentsPreservingScroll();
    if (view.selectedId) await loadIncidentDetail(view.selectedId);
  }).finally(() => { view.loadPromise = null; });
  return view.loadPromise;
}

async function loadProviderCases({ force = false } = {}) {
  const view = incidentSurfaceState();
  if (!session.authenticated || !state.capabilities.canAny(["provider_case.draft", "provider_case.send"])) return;
  if (view.casesState === "loading") return view.casesLoadPromise;
  if (view.casesState === "ready" && !force) { renderIncidentsSurface(); return; }
  view.casesState = "loading";
  renderIncidentsSurface();
  view.casesLoadPromise = boundaries.providerCases.list().then((items) => {
    view.cases = Array.isArray(items) ? items : [];
    view.casesState = "ready";
  }).catch(() => {
    view.cases = [];
    view.casesState = "error";
  }).finally(() => {
    view.casesLoadPromise = null;
    renderIncidentsSurface();
  });
  return view.casesLoadPromise;
}

async function selectIncident(id) {
  const view = incidentSurfaceState();
  view.selectedId = id;
  view.detail = null;
  view.detailState = "loading";
  view.actionState = "idle";
  view.actionError = "";
  view.actionMessage = "";
  view.commentState = "idle";
  view.commentMessage = "";
  view.selectedSituationId = null;
  view.situation = null;
  view.situationState = "idle";
  view.situationActionState = "idle";
  view.situationActionError = "";
  view.situationActionMessage = "";
  view.providerCase = { selectedId: null, state: "idle", detail: null, actionState: "idle", actionError: "", actionMessage: "", generated: null };
  renderIncidentsSurface();
  await loadIncidentDetail(id);
}

async function loadIncidentDetail(id) {
  const view = incidentSurfaceState();
  try {
    const response = await boundaries.incidents.get(id);
    if (String(view.selectedId) !== String(id)) return;
    view.detail = objectPayload(response);
    view.detailState = "ready";
    const cases = Array.isArray(view.detail.provider_cases) ? view.detail.provider_cases : [];
    if (view.providerCase.selectedId && !cases.some((item) => String(item.id) === String(view.providerCase.selectedId))) {
      view.providerCase = { selectedId: null, state: "idle", detail: null, actionState: "idle", actionError: "", actionMessage: "", generated: null };
    }
  } catch (error) {
    if (String(view.selectedId) !== String(id)) return;
    view.detail = null;
    view.detailState = "error";
  }
  renderIncidentsPreservingScroll();
}

async function selectProviderCase(id) {
  const view = incidentSurfaceState();
  if (!view.detail || !view.selectedId) return;
  view.providerCase = { selectedId: id, state: "loading", detail: null, actionState: "idle", actionError: "", actionMessage: "", generated: null };
  renderIncidentsPreservingScroll();
  try {
    const detail = objectPayload(await boundaries.providerCases.get(id));
    if (String(view.providerCase.selectedId) !== String(id) || String(view.selectedId) !== String(view.detail?.id)) return;
    if (String(detail.incident_id) !== String(view.selectedId)) throw Object.assign(new Error("provider case context mismatch"), { status: 404 });
    const summary = view.cases.find((item) => String(item?.id) === String(id));
    view.providerCase.detail = summary ? { ...summary, ...detail } : detail;
    view.providerCase.state = "ready";
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(id)) return;
    view.providerCase.state = "error";
  }
  renderIncidentsPreservingScroll();
}

async function selectProviderCaseFromRoute(id) {
  const view = incidentSurfaceState();
  if (!session.authenticated || view.providerCase.actionState !== "idle") return;
  view.providerCase = { selectedId: id, state: "loading", detail: null, actionState: "idle", actionError: "", actionMessage: "", generated: null };
  view.selectedId = null;
  view.detail = null;
  view.detailState = "idle";
  view.selectedSituationId = null;
  view.situation = null;
  renderIncidentsPreservingScroll();
  try {
    const detail = objectPayload(await boundaries.providerCases.get(id));
    if (String(view.providerCase.selectedId) !== String(id)) return;
    const summary = view.cases.find((item) => String(item?.id) === String(id));
    view.providerCase.detail = summary ? { ...summary, ...detail } : detail;
    const incidentID = Number(detail?.incident_id);
    view.selectedId = state.capabilities.canRead("incident") && Number.isFinite(incidentID) && incidentID > 0 ? incidentID : null;
    if (view.selectedId && state.capabilities.canRead("incident")) {
      await loadIncidentDetail(view.selectedId);
      if (String(view.providerCase.selectedId) !== String(id)) return;
    }
    view.providerCase.state = "ready";
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(id)) return;
    view.providerCase.state = "error";
  }
  renderIncidentsPreservingScroll();
}

async function createIncidentProviderCase() {
  const view = incidentSurfaceState();
  if (!view.selectedId || !view.detail || view.providerCase.actionState !== "idle" || !providerCaseActions({ incident: view.detail }, state.capabilities).canPrepare) return;
  if (!globalThis.confirm?.(i18n.t("providerCase.confirmPrepare"))) return;
  view.providerCase.actionState = "creating";
  view.providerCase.actionError = "";
  view.providerCase.actionMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const created = objectPayload(await boundaries.incidents.createProviderCaseDraft(view.selectedId, { locale: i18n.locale }));
    await loadIncidentDetail(view.selectedId);
    view.providerCase.actionState = "idle";
    router.navigate("cases");
    await loadProviderCases({ force: true });
    await selectProviderCaseFromRoute(created.id);
    view.providerCase.actionMessage = "providerCase.prepared";
    renderIncidentsPreservingScroll();
  } catch (error) {
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = "providerCase.prepareFailed";
    renderIncidentsPreservingScroll();
  }
}

async function generateProviderCaseDraft() {
  const view = incidentSurfaceState();
  const detail = view.providerCase.detail;
  if (!detail || view.providerCase.actionState !== "idle" || !providerCaseActions(detail, state.capabilities).canGenerate) return;
  if (!globalThis.confirm?.(i18n.t("providerCase.confirmAutomatic"))) return;
  view.providerCase.actionState = "generating";
  view.providerCase.actionError = "";
  view.providerCase.actionMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const generated = objectPayload(await boundaries.providerCases.aiDraft(detail.id, undefined, i18n.locale));
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.detail = { ...detail, ...generated };
    view.providerCase.generated = generated;
    view.providerCase.actionState = "idle";
    view.providerCase.actionMessage = "providerCase.generated";
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = "providerCase.automaticFailed";
  }
  renderIncidentsPreservingScroll();
}

async function saveProviderCaseDraft() {
  const view = incidentSurfaceState();
  const detail = view.providerCase.detail;
  const textControl = $("[data-provider-case-text]", $("#incidentsSurface"));
  const draftText = textControl?.value.trim() || "";
  const actions = providerCaseActions(detail, state.capabilities, view.providerCase.actionState);
  if (!detail || !draftText || !actions.canEdit) return;
  view.providerCase.actionState = "saving";
  view.providerCase.actionError = "";
  view.providerCase.actionMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const saved = objectPayload(await boundaries.providerCases.saveDraft(detail.id, { draft_text: draftText }));
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.detail = { ...detail, ...saved, draft_text: saved?.draft_text || draftText, final_text: saved?.final_text || null };
    view.providerCase.actionState = "idle";
    view.providerCase.actionMessage = "providerCase.draftSaved";
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = "providerCase.draftSaveFailed";
  }
  renderIncidentsPreservingScroll();
}

async function sendProviderCase(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  const detail = view.providerCase.detail;
  const finalText = event.currentTarget.closest(".provider-case-detail")?.querySelector("[data-provider-case-text]")?.value.trim();
  const reviewed = event.currentTarget.querySelector("[data-provider-case-reviewed]")?.checked === true;
  if (!detail || view.providerCase.actionState !== "idle" || !reviewed || !finalText || !providerCaseActions(detail, state.capabilities).canSend) return;
  if (!globalThis.confirm?.(i18n.t("providerCase.confirmSend"))) return;
  const request = providerCaseDeliveryRequest(detail, { finalText, incidentId: view.selectedId, reviewed: true });
  view.providerCase.actionState = request.operation === "retry" ? "retrying" : "sending";
  view.providerCase.actionError = "";
  view.providerCase.actionMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const delivered = request.operation === "retry"
      ? await boundaries.providerCases.retry(detail.id, request.payload)
      : await boundaries.providerCases.send(detail.id, request.payload);
    const sent = objectPayload(delivered);
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.detail = { ...detail, ...sent };
    view.providerCase.actionState = "idle";
    if (view.selectedId) {
      await loadIncidentDetail(view.selectedId);
      await selectProviderCase(detail.id);
    } else {
      const refreshed = objectPayload(await boundaries.providerCases.get(detail.id));
      view.providerCase.detail = refreshed;
      view.providerCase.state = "ready";
    }
    if (router.getState().view === "cases") await loadProviderCases({ force: true });
    view.providerCase.actionMessage = "providerCase.sent";
    renderIncidentsPreservingScroll();
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = "providerCase.sendFailed";
    try {
      const refreshed = objectPayload(await boundaries.providerCases.get(detail.id));
      if (String(view.providerCase.selectedId) === String(detail.id)) {
        view.providerCase.detail = refreshed;
        view.providerCase.state = "ready";
      }
    } catch (refreshError) {
      view.providerCase.state = "error";
    }
    renderIncidentsPreservingScroll();
  }
}

async function selectSituation(id) {
  const view = incidentSurfaceState();
  view.selectedSituationId = id;
  view.situation = null;
  view.situationState = "loading";
  view.situationComparison = null;
  view.comparisonState = "idle";
  view.situationActionState = "idle";
  view.situationActionError = "";
  renderIncidentsPreservingScroll();
  try {
    const response = objectPayload(await boundaries.incidents.situation(id));
    if (String(view.selectedSituationId) !== String(id)) return;
    view.situation = response;
    view.situationState = "ready";
  } catch (error) {
    if (String(view.selectedSituationId) !== String(id)) return;
    view.situationState = "error";
  }
  renderIncidentsPreservingScroll();
}

async function loadSituationComparison() {
  const view = incidentSurfaceState();
  if (!view.selectedSituationId || view.comparisonState === "loading") return;
  view.comparisonState = "loading";
  renderIncidentsPreservingScroll();
  try {
    const response = objectPayload(await boundaries.incidents.situationComparison(view.selectedSituationId, "window_minutes=15"));
    view.situationComparison = response && typeof response === "object" ? response : {};
    view.comparisonState = "ready";
  } catch (error) {
    view.situationComparison = null;
    view.comparisonState = "error";
  }
  renderIncidentsPreservingScroll();
}

async function openIncidentLine(lineID) {
  if (!map.getLine(lineID)) return;
  router.navigate("map");
  await openLine(lineID);
}

async function submitIncidentComment(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  const note = event.currentTarget.querySelector("textarea")?.value.trim();
  if (!note || !view.selectedId || !view.detail || !incidentActions(view.detail, state.capabilities).canComment) return;
  if (!globalThis.confirm?.(i18n.t("incidents.confirmComment"))) return;
  view.commentState = "saving";
  view.commentMessage = "";
  renderIncidentsPreservingScroll();
  try {
    const response = objectPayload(await boundaries.incidents.addEvent(view.selectedId, { event_type: "comment", note }));
    const readback = objectPayload(await boundaries.incidents.get(view.selectedId));
    const next = readback && typeof readback === "object" ? readback : response;
    if (!next || typeof next !== "object") throw new Error("incident readback unavailable");
    view.detail = next;
    const index = view.items.findIndex((item) => String(item.id) === String(view.selectedId));
    if (index >= 0) view.items[index] = next;
    view.detailState = "ready";
    view.commentState = "success";
    view.commentMessage = "incidents.commentSent";
    renderIncidentsPreservingScroll();
  } catch (error) {
    view.commentState = "error";
    view.commentMessage = "incidents.commentFailed";
    renderIncidentsPreservingScroll();
  }
}

async function openIncident(id) {
  if (!state.capabilities.canRead("incident")) return;
  if (state.notifications.open) closeNotifications(false);
  router.navigate("incidents");
  await loadIncidents();
  await selectIncident(id);
}

function closeDrawer(restoreFocus = true) {
  state.drawerRequestID += 1;
  $("#detailDrawer")?.classList.remove("open");
  if ($("#detailDrawer")) $("#detailDrawer").hidden = true;
  if ($("#drawerBackdrop")) $("#drawerBackdrop").hidden = true;
  if ($("#detailDrawer")) $("#detailDrawer").setAttribute("aria-hidden", "true");
  const trigger = state.drawerTrigger;
  state.drawerTrigger = null;
  state.drawerFocusSet = false;
  if (restoreFocus) trigger?.focus?.();
}
async function refreshMap() {
  if (!session.authenticated) return;
  state.mapLoaded = false;
  state.mapLoadPromise = null;
  await loadAuthenticatedMap();
}

function mapControlAction(action) {
  const mapInstance = globalThis.LinkwatchMap?.getMap?.();
  const method = mapInstance?.[action];
  if (typeof method !== "function") return false;
  method.call(mapInstance);
  return true;
}

function trapOverlayFocus(event) {
  if (event.key !== "Tab") return;
  const overlay = !$("#authBackdrop")?.hidden ? $("#loginForm") : !$("#detailDrawer")?.hidden ? $("#detailDrawer") : state.notifications.open ? $("#notificationsSurface") : !$("#mapPopup")?.hidden ? $("#mapPopup") : null;
  if (!overlay) return;
  const focusable = [...overlay.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hidden && element.offsetParent !== null);
  if (!focusable.length) { event.preventDefault(); overlay.focus?.(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
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
  $("#logoutButton")?.addEventListener("click", async () => { try { await session.logout(); } catch (error) { showToast("auth.logoutFailed", "warn"); } });
  $("#themeToggle")?.addEventListener("click", () => theme.toggle());
  $("#notificationsButton")?.addEventListener("click", toggleNotifications);
  $("#refreshButton")?.addEventListener("click", refreshMap);
  $("#mapFilter")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const firstResult = map.searchResults()[0];
    if (firstResult) selectSearchResult(firstResult.school.registryId);
  });
  document.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", () => {
    if (router.navigate(button.dataset.route)) {
      $("#accountControl")?.removeAttribute("open");
      $("#navOverflow")?.removeAttribute("open");
    }
  }));
  document.querySelectorAll("[data-locale]").forEach((button) => button.addEventListener("click", () => i18n.setLocale(button.dataset.locale)));
  $("#mapListMode")?.addEventListener("change", async (event) => {
    const mode = event.target.value === "historical" ? "historical" : "current";
    if (mode === "current") map.setMode(mode);
    else { try { await map.loadHistorical("period=week"); } catch (error) { showToast("map.historicalUnavailable", "warn"); } }
    renderMapStatus();
  });
  $("#coverageFilter")?.addEventListener("change", (event) => { map.setCoverage(event.target.value); renderMapStatus(); });
  $("#districtFilter")?.addEventListener("change", applyMapFilters);
  $("#providerFilter")?.addEventListener("change", applyMapFilters);
  $("#statusFilter")?.addEventListener("change", applyMapFilters);
  $("#mapQuickFilters")?.addEventListener("click", (event) => {
    const control = event.target.closest("[data-map-quick-filter]");
    if (!control) return;
    const [kind, ...parts] = control.dataset.mapQuickFilter.split(":");
    const value = parts.join(":");
    map.setFilters({
      status: kind === "status" ? value : "",
      provider: kind === "provider" ? value : "",
    });
    renderMapStatus();
  });
  $("#schoolSearch")?.addEventListener("input", (event) => { state.searchActiveIndex = -1; map.setFilters({ query: event.target.value }); renderMapStatus(); });
  $("#schoolSearch")?.addEventListener("keydown", handleSchoolSearchKeydown);
  $("#mapFiltersReset")?.addEventListener("click", () => { map.resetFilters(); renderMapStatus(); });
  $("#mapPopupClose")?.addEventListener("click", () => closeMapPopup());
  $("#mapPopupOpenLine")?.addEventListener("click", openSelectedSchoolDetail);
  $("#mapPopupAddMonitoring")?.addEventListener("click", startSchoolMonitoringSetup);
  $("#drawerClose")?.addEventListener("click", closeDrawer);
  $("#drawerBackdrop")?.addEventListener("click", closeDrawer);
  $("#mapZoomIn")?.addEventListener("click", () => mapControlAction("zoomIn"));
  $("#mapZoomOut")?.addEventListener("click", () => mapControlAction("zoomOut"));
  $("#mapReset")?.addEventListener("click", () => globalThis.LinkwatchMap?.resetView());
  document.addEventListener("keydown", (event) => { trapOverlayFocus(event); if (event.key === "Escape") { if (state.notifications.open) closeNotifications(); else if (!$("#mapPopup")?.hidden) closeMapPopup(); else if (!$("#detailDrawer")?.hidden) closeDrawer(); } });
  globalThis.addEventListener?.("linkwatch:map-cluster-expanded", () => {
    if (state.mapPopupContext?.kind === "registry-cluster") closeMapPopup(false);
  });
  globalThis.addEventListener?.("focus", () => {
    if (session?.authenticated && state.capabilities.has("notification.read")) void loadNotifications({ force: true, background: true });
    if (session?.authenticated) void refreshOperationalWorkspace();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && session?.authenticated && state.capabilities.has("notification.read")) void loadNotifications({ force: true, background: true });
    if (document.visibilityState === "visible" && session?.authenticated) void refreshOperationalWorkspace();
  });
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
  if (state.selectedSchool && !$("#detailDrawer")?.hidden) renderSchoolDrawer(state.selectedSchool);
  renderIncidentsSurface();
  renderNotificationsSurface();
  renderAdminSurface();
  renderAuditSurface();
}

async function boot() {
  localizeStaticContent();
  bindEvents();
  i18n.subscribe(refreshLocale);
  theme.subscribe(refreshTheme);
  const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  reducedMotionQuery?.addEventListener?.("change", applyReducedMotionToMap);
  renderSession();
  if (!session.hasToken()) return;
  try {
    await session.bootstrap();
    const requestedRoute = globalThis.location?.hash?.slice(1);
    if (requestedRoute) router.navigate(requestedRoute, { replace: true });
  } catch (error) {
    showLogin(error.status === 401 || error.status === 403 ? "auth.invalidSession" : "auth.serviceUnavailable");
  }
}

globalThis.LinkwatchApp = { i18n, presentation, theme, router, state, boundaries, refreshMap, openLine, openIncident, openMapPopup, mapControlAction };
document.addEventListener("DOMContentLoaded", boot);
