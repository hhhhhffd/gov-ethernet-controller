import { createApiClient } from "./core/api.mjs";
import { createCapabilityState } from "./core/capabilities.mjs";
import { createI18n } from "./core/i18n.mjs";
import { createPresentation, escapeHtml } from "./core/presentation.mjs";
import { createShellRouter } from "./core/router.mjs";
import { createSession } from "./core/session.mjs";
import { createMapPresentationAdapter } from "./core/map-presentation.mjs";
import { createThemeState } from "./core/theme.mjs";
import { createMapIntegration } from "./integration/map-integration.mjs";
import { adminResourceDefinition, createAdminBoundary, writableAdminPayload } from "./features/admin.mjs";
import { createAuditBoundary } from "./features/audit.mjs";
import { createIncidentsBoundary } from "./features/incidents.mjs";
import { createLinesBoundary } from "./features/lines.mjs";
import { createNotificationsBoundary, NOTIFICATION_POLL_INTERVAL_MS, notificationKey, notificationSeenStorageKey, notificationIsServerRead, notificationSummary, readNotificationSeenIDs, readNotificationSoundMuted, writeNotificationSeenIDs, writeNotificationSoundMuted } from "./features/notifications.mjs";
import { createProviderCaseBoundary } from "./features/provider-case.mjs";
import { createReportsBoundary } from "./features/reports.mjs";
import { defaultReportFilters, reportAvailability as formatReportAvailability, reportContextFilters, reportEvidenceSummary, reportFilterOptions, reportQuery, reportState } from "./features/reports-presentation.mjs";
import { filterIncidents, incidentActions, incidentSeverityValues, incidentStatusValues, presentIncident, presentRecovery, presentSituation, presentTimeline, relatedSituations, situationActions } from "./features/incidents-presentation.mjs";
import { presentProviderCase, providerCaseActions, providerCaseDeliveryRequest } from "./features/provider-case-presentation.mjs";
import { activeIncident, availableMetrics, createSelectedSchool, mergeLineDetail, selectedLine, selectSchoolLine } from "./features/school-detail.mjs";
import { adminResourceDefinitions, presentAdminRecord, presentAgentVersion, presentAuditItem, presentNotification } from "./features/secondary-presentation.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const state = {
  capabilities: createCapabilityState(null), mapPopupContext: null, mapPopupTrigger: null, mapPopupAnchor: null, selectedSchool: null,
  mapInitialized: false, mapLoaded: false, mapLoadPromise: null, toastTimer: null, drawerTrigger: null, drawerFocusSet: false,
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

function createIncidentSurfaceState() {
  return {
    state: "idle", items: [], filters: { status: "", severity: "" }, selectedId: null, detail: null, detailState: "idle",
    situations: [], situationsState: "idle", selectedSituationId: null, situation: null, situationState: "idle",
    actionState: "idle", actionError: "", situationActionState: "idle", situationActionError: "",
    providerCase: { selectedId: null, state: "idle", detail: null, actionState: "idle", actionError: "", generated: null },
  };
}

function createReportsSurfaceState() {
  return {
    state: "idle", filters: defaultReportFilters(), aggregate: null, analytics: null, passport: null,
    aggregateState: "idle", analyticsState: "idle", passportState: "idle", preview: null, previewState: "idle", loadPromise: null,
  };
}

function createNotificationsSurfaceState() {
  return {
    open: false, state: "idle", items: [], loadPromise: null, actionId: null, actionState: "idle", actionError: "", actionErrorId: null,
    seenIDs: new Set(), knownIDs: new Set(), baselineInitialized: false, storageKey: "", pollTimer: null,
    soundMuted: readNotificationSoundMuted(globalThis.localStorage), audioContext: null, soundUnavailable: false,
  };
}

function createAdminSurfaceState() {
  return { state: "idle", resource: "organizations", items: [], selectedId: "", payload: "{}", mutationState: "idle", message: "", loadPromise: null, preview: null };
}

function createAuditSurfaceState() {
  return { state: "idle", tab: "log", items: [], filters: { action: "", object_type: "" }, search: "", nextBeforeId: "", hasMore: false, loadingMore: false, selectedId: "", versionsState: "idle", versions: [], selectedVersion: "", devicesState: "idle", devices: [], loadPromise: null };
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
  view.soundMuted = readNotificationSoundMuted(browserStorage());
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

function startNotificationPolling() {
  stopNotificationPolling();
  if (!session?.authenticated || !state.capabilities.has("notification.read")) return;
  const interval = globalThis.setInterval;
  if (typeof interval !== "function") return;
  state.notifications.pollTimer = interval(() => {
    if (session?.authenticated && state.capabilities.has("notification.read")) void loadNotifications({ force: true, background: true });
  }, NOTIFICATION_POLL_INTERVAL_MS);
}

function playNotificationSound() {
  const view = state.notifications;
  if (view.soundMuted || view.soundUnavailable) return;
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContext !== "function") {
    view.soundUnavailable = true;
    return;
  }
  try {
    const context = view.audioContext || new AudioContext();
    view.audioContext = context;
    const resume = context.state === "suspended" ? context.resume?.() : null;
    resume?.catch?.(() => { view.soundUnavailable = true; });
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(720, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.12);
  } catch (error) {
    view.soundUnavailable = true;
  }
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
  if (snapshot.view === "incidents") loadIncidents();
  if (snapshot.view === "reports") loadReports();
  if (snapshot.view === "admin") loadAdminResource();
  if (snapshot.view === "audit") loadAuditLog();
  renderIncidentsSurface();
  renderReportsSurface();
  renderNotificationsSurface();
  renderAdminSurface();
  renderAuditSurface();
}

function renderPrimaryNav() {
  const destinations = { map: true, incidents: state.capabilities.canRead("incident"), reports: state.capabilities.canRead("report") };
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
}

async function loadAuthenticatedMap() {
  if (state.mapLoadPromise) return state.mapLoadPromise;
  renderMapStatus();
  const requestGeneration = session.generation;
  const loadPromise = map.loadCurrent()
    .then(() => {
      if (session.generation !== requestGeneration || !session.authenticated) return;
      state.mapLoaded = true;
      renderMapStatus();
    })
    .catch((error) => {
      if (session.generation !== requestGeneration || !session.authenticated) return;
      state.mapLoaded = true;
      renderMapStatus();
      showToast(error.status === 403 ? "map.forbidden" : "map.temporarilyUnavailable", "warn");
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
    return '<button type="button" class="map-member" data-popup-line-id="' + escapeHtml(line.id) + '" aria-pressed="' + active + '">'
      + escapeHtml(line.id) + " · " + escapeHtml(presentation.status(line.linkwatchStatus || line.status).label) + "</button>";
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
  const workspace = $("#mapWrap");
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
  const fields = $("#mapPopupFields");
  if (!popup || !fields) return;
  const school = context.school;
  const selection = state.selectedSchool;
  const stateElement = $("#mapPopupState");
  let title = context.label || popupSchoolName(school, context.lines?.[0]);
  let summary = "";
  openLineButton.hidden = true;
  openLineButton.textContent = "";
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

function openMapPopup(context, trigger = null) {
  state.mapPopupContext = context;
  state.mapPopupTrigger = trigger?.getLatLng?.() ? trigger : markerForMapContext(context) || (document.activeElement !== document.body ? document.activeElement : null);
  state.selectedSchool = context.kind === "registry-cluster" ? null : createSelectedSchool(context);
  renderPopup(context);
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
  $("#drawerSubtitle").textContent = school?.registryId ? i18n.t("school.registryNumber", { number: school.registryId }) : presentation.empty();
  drawerState.textContent = selection.detailState === "loading" ? i18n.t("school.detailLoading") : selection.detailState === "error" ? i18n.t("school.detailUnavailable") : "";
  drawerState.className = "selection-state" + (selection.detailState === "error" ? " error" : "");
  $("#drawerContext").innerHTML = mapFields([
    [i18n.t("field.officialIdentity"), popupSchoolName(school, line)],
    [i18n.t("field.registryNumber"), school?.registryId],
    [i18n.t("field.address"), knownValue(school?.address)],
    [i18n.t("field.coordinates"), coordinateText(school)],
    [i18n.t("field.coordinateSource"), presentation.coordinateSource(school?.coordinateSource)],
    [i18n.t("field.registryProvenance"), registryProvenance(school)],
  ]);
  if (!selected) {
    $("#drawerStatus").innerHTML = selection.registryOnly
      ? '<span class="status-badge no-data">' + escapeHtml(presentation.status("NOT_MONITORED").label) + "</span><p>" + escapeHtml(presentation.statusDescription("NOT_MONITORED")) + "</p>"
      : "<p>" + escapeHtml(i18n.t("school.chooseLine")) + "</p>";
    $("#drawerLine").innerHTML = lineSelector(selection.lines, null);
    $("#drawerMetrics").innerHTML = "";
    $("#drawerIncident").innerHTML = "";
  } else {
    const status = presentation.status(line.linkwatchStatus || line.status);
    $("#drawerStatus").innerHTML = '<span class="status-badge ' + escapeHtml(status.tone) + '">' + escapeHtml(status.label) + "</span><p>" + escapeHtml(presentation.statusDescription(status.code)) + "</p>";
    const contractNumber = line.contract?.contract_no;
    $("#drawerLine").innerHTML = lineSelector(selection.lines, selected.id) + mapFields([
      [i18n.t("field.line"), line.id], [i18n.t("field.provider"), knownValue(line.provider === "—" ? null : line.provider)],
      [i18n.t("field.connectionType"), presentation.connectionType(line.technology)], [i18n.t("field.lineRole"), presentation.role(line.role)],
      [i18n.t("field.lastObserved"), line.latest?.at ? presentation.formatDate(line.latest.at, true) : i18n.t("school.notObserved")],
      ...(contractNumber ? [[i18n.t("field.contract"), contractNumber]] : []),
    ]);
    const metricLabels = { download: ["field.download", "unit.mbps"], upload: ["field.upload", "unit.mbps"], ping: ["field.ping", "unit.ms"], jitter: ["field.jitter", "unit.ms"], loss: ["field.loss", "unit.percent"] };
    const metrics = availableMetrics(line);
    $("#drawerMetrics").innerHTML = metrics.length
      ? mapFields(metrics.map(([metric, value]) => [i18n.t(metricLabels[metric][0]), presentation.formatNumber(value, i18n.t(metricLabels[metric][1]))]))
      : mapFields([[i18n.t("field.metrics"), i18n.t("school.metricsUnavailable")]]);
    const incident = activeIncident(line);
    $("#drawerIncident").innerHTML = incident ? mapFields([[i18n.t("field.activeIncident"), incident.incident_no || incident.number || incident.id], [i18n.t("field.incidentStatus"), presentation.incidentStatus(incident.status)]]) + '<button class="link-action" type="button" data-open-incident-id="' + escapeHtml(incident.id) + '">' + escapeHtml(i18n.t("nav.incidents")) + "</button>" : "";
  }
  $("#drawerBackdrop").hidden = false;
  $("#detailDrawer").hidden = false;
  $("#detailDrawer").classList.add("open");
  $("#detailDrawer").setAttribute("aria-hidden", "false");
  if (state.drawerTrigger && !state.drawerFocusSet) { $("#detailDrawer")?.focus(); state.drawerFocusSet = true; }
  $("#detailDrawer").querySelectorAll("[data-popup-line-id]").forEach((button) => button.addEventListener("click", async () => {
    state.selectedSchool = selectSchoolLine(state.selectedSchool, button.dataset.popupLineId);
    renderSchoolDrawer();
    if (state.mapPopupContext) renderPopup(state.mapPopupContext);
    await openSelectedSchoolDetail();
  }));
  $("#detailDrawer").querySelector("[data-open-incident-id]")?.addEventListener("click", () => openIncident($("#detailDrawer").querySelector("[data-open-incident-id]").dataset.openIncidentId));
}

async function openSelectedSchoolDetail() {
  let selection = state.selectedSchool;
  if (!selection) return;
  if (!state.drawerTrigger) state.drawerTrigger = state.mapPopupTrigger || (document.activeElement !== document.body ? document.activeElement : null);
  closeMapPopup(false, true);
  const line = selectedLine(selection);
  if (!line) { renderSchoolDrawer(selection); return; }
  selection = { ...selection, detailState: "loading", detail: null };
  state.selectedSchool = selection;
  renderSchoolDrawer(selection);
  try {
    const response = await lines.get(line.id);
    state.selectedSchool = { ...selection, detail: mergeLineDetail(line, response), detailState: "ready" };
  } catch (error) {
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

function renderIncidentsSurface() {
  const root = $("#incidentsSurface");
  if (!root) return;
  const view = incidentSurfaceState();
  const active = router.getState().view === "incidents";
  root.hidden = !active;
  if (!active) return;
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="incidents-shell"><p class="surface-state" role="status">' + escapeHtml(i18n.t("incidents.loading")) + "</p></div>";
    return;
  }
  if (view.state === "error") {
    root.innerHTML = '<div class="incidents-shell"><h1>' + escapeHtml(i18n.t("incidents.title")) + '</h1><p class="surface-state error" role="alert">' + escapeHtml(i18n.t("incidents.unavailable")) + '</p><button class="secondary-action" type="button" data-incidents-refresh>' + escapeHtml(i18n.t("incidents.refresh")) + "</button></div>";
    bindIncidentSurfaceEvents(root);
    return;
  }

  const statuses = incidentStatusValues(view.items);
  const severities = incidentSeverityValues(view.items);
  if (!statuses.includes(view.filters.status)) view.filters.status = "";
  if (!severities.includes(view.filters.severity)) view.filters.severity = "";
  const items = filterIncidents(view.items, view.filters);
  const filters = '<label>' + escapeHtml(i18n.t("incidents.filterStatus")) + '<select data-incident-filter="status"><option value="">' + escapeHtml(i18n.t("incidents.anyStatus")) + "</option>" + statuses.map((status) => '<option value="' + escapeHtml(status) + '"' + (view.filters.status === status ? " selected" : "") + ">" + escapeHtml(presentation.incidentStatus(status)) + "</option>").join("") + '</select></label>'
    + '<label>' + escapeHtml(i18n.t("incidents.filterSeverity")) + '<select data-incident-filter="severity"><option value="">' + escapeHtml(i18n.t("incidents.anySeverity")) + "</option>" + severities.map((severity) => '<option value="' + escapeHtml(severity) + '"' + (view.filters.severity === severity ? " selected" : "") + ">" + escapeHtml(i18n.has("severity." + severity) ? i18n.t("severity." + severity) : i18n.t("severity.UNKNOWN")) + "</option>").join("") + "</select></label>";
  const list = items.length ? items.map((item) => {
    const incident = presentIncident(item, { i18n, presentation });
    return '<button class="incident-row' + (String(view.selectedId) === String(incident.id) ? " selected" : "") + '" type="button" data-incident-id="' + escapeHtml(incident.id) + '"><span class="incident-row-status severity-' + escapeHtml(incident.severity.toLowerCase()) + '">' + escapeHtml(incident.statusLabel) + "</span><span><strong>" + escapeHtml(incident.school) + "</strong><small>" + escapeHtml(incident.typeLabel) + "</small></span><span>" + escapeHtml(incident.line) + "</span><span>" + escapeHtml(incident.startedLabel) + "</span><span>" + escapeHtml(incident.durationLabel) + "</span><span>" + escapeHtml(incident.lastUpdateLabel) + "</span></button>";
  }).join("") : '<p class="surface-state">' + escapeHtml(i18n.t("incidents.empty")) + "</p>";

  root.innerHTML = '<div class="incidents-shell"><header class="incidents-header"><div><h1>' + escapeHtml(i18n.t("incidents.title")) + "</h1><p>" + escapeHtml(i18n.t("incidents.subtitle")) + '</p></div><button class="secondary-action" type="button" data-incidents-refresh>' + escapeHtml(i18n.t("incidents.refresh")) + '</button></header><div class="incident-filters">' + filters + '<span class="incident-count">' + escapeHtml(i18n.t("incidents.count", { count: items.length })) + '</span></div><div class="incidents-layout"><section class="incidents-list" aria-label="' + escapeHtml(i18n.t("incidents.title")) + '"><div class="incident-row incident-row-head" aria-hidden="true"><span>' + escapeHtml(i18n.t("field.status")) + "</span><span>" + escapeHtml(i18n.t("field.school")) + "</span><span>" + escapeHtml(i18n.t("field.line")) + "</span><span>" + escapeHtml(i18n.t("incidents.started")) + "</span><span>" + escapeHtml(i18n.t("incidents.duration")) + "</span><span>" + escapeHtml(i18n.t("incidents.lastUpdate")) + "</span></div>" + list + '</section><aside class="incident-detail" aria-live="polite">' + renderIncidentDetail() + "</aside></div></div>";
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

function reportTechnicalDetails(diagnostics) {
  if (!diagnostics.length) return "";
  return '<details><summary>' + escapeHtml(i18n.t("audit.technical")) + '</summary><pre>' + escapeHtml(JSON.stringify(diagnostics, null, 2)) + "</pre></details>";
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

function renderReportsSurface() {
  const root = $("#reportsSurface");
  if (!root) return;
  const view = reportSurfaceState();
  const active = router.getState().view === "reports";
  root.hidden = !active;
  if (!active) return;
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="reports-shell"><p class="surface-state" role="status">' + escapeHtml(i18n.t("reports.loading")) + "</p></div>";
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
  const qualityPanel = view.passportState === "error" ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.quality")) + '</h2><p class="surface-state error">' + escapeHtml(i18n.t("reports.unavailable")) + "</p></section>" : '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.quality")) + '</h2><dl class="report-grid"><div><dt>' + escapeHtml(i18n.t("reports.baseline")) + "</dt><dd>" + escapeHtml(reportAvailability(passport?.baseline_compliance, i18n)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.contract")) + "</dt><dd>" + escapeHtml(reportAvailability(passport?.contract_compliance, i18n)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.incidents")) + "</dt><dd>" + escapeHtml(reportNumber(passport?.incidents?.count)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.evidenceCount")) + "</dt><dd>" + escapeHtml(reportNumber(evidence.count)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.evidenceProvenance")) + "</dt><dd>" + escapeHtml(evidence.provenance) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.lastVerified")) + "</dt><dd>" + escapeHtml(evidence.lastVerified) + "</dd></div></dl>" + (passport?.sufficient_data === false ? '<p class="report-note">' + escapeHtml(i18n.t("reports.insufficient")) + "</p>" : "") + '<div class="report-evidence-action"><button class="secondary-action" type="button" data-evidence-preview>' + escapeHtml(i18n.t("reports.evidencePreview")) + '</button><p class="report-note">' + escapeHtml(i18n.t("reports.evidenceHtmlOnly")) + "</p></div></section>";
  const canExport = state.capabilities.has("report.export");
  const preview = view.preview;
  const previewText = view.previewState === "error" ? i18n.t("reports.previewUnavailable") : preview ? i18n.t(preview.limited ? "reports.previewLimited" : "reports.previewRows", { count: preview.count }) : "";
  const exportPanel = '<section class="report-panel report-export"><h2>' + escapeHtml(i18n.t("reports.export")) + (canExport ? "</h2><form data-report-export><label>" + escapeHtml(i18n.t("reports.exportKind")) + '<select name="kind"><option value="raw">' + escapeHtml(i18n.t("reports.exportRaw")) + '</option><option value="aggregate">' + escapeHtml(i18n.t("reports.exportAggregate")) + '</option></select></label><label>' + escapeHtml(i18n.t("reports.exportFormat")) + '<select name="format"><option value="csv">CSV</option><option value="xlsx">XLSX</option><option value="json">JSON</option></select></label><button class="secondary-action" type="button" data-export-preview>' + escapeHtml(i18n.t("reports.preview")) + '</button><button class="primary-action" type="submit">' + escapeHtml(i18n.t("reports.download")) + "</button></form>" + (previewText ? '<p class="surface-state' + (view.previewState === "error" ? " error" : "") + '">' + escapeHtml(previewText) + (preview?.columns?.length ? " " + escapeHtml(i18n.t("reports.previewColumns")) + ": " + escapeHtml(preview.columns.join(", ")) : "") + "</p>" : "") : '</h2><p class="surface-state">' + escapeHtml(i18n.t("reports.exportUnavailable")) + "</p>") + "</section>";
  root.innerHTML = '<div class="reports-shell"><header class="incidents-header"><div><h1>' + escapeHtml(i18n.t("reports.title")) + "</h1><p>" + escapeHtml(i18n.t("reports.subtitle")) + "</p></div></header>" + form + '<div class="report-overview">' + aggregatePanel + qualityPanel + "</div>" + analyticsPanel + exportPanel + "</div>";
  const reportDetails = reportTechnicalDetails(reportDiagnostics);
  if (reportDetails) root.querySelector(".reports-shell")?.insertAdjacentHTML("beforeend", reportDetails);
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
  const request = reportExportQuery(event.currentTarget);
  if (request.error || !state.capabilities.has("report.export")) return;
  try { triggerDownload(await reports.exportData(request.query), `linkwatch-report.${event.currentTarget.elements.format.value}`); }
  catch (error) { showToast("reports.exportFailed", "warn"); }
}

function triggerDownload(response, filename) {
  response.blob().then((blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }).catch(() => showToast("reports.exportFailed", "warn"));
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
  const icon = document.createElement("span");
  icon.textContent = "♢";
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);
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

function notificationSoundControl(view) {
  const key = view.soundMuted ? "notification.soundUnmute" : "notification.soundMute";
  const stateKey = view.soundMuted ? "notification.soundMuted" : "notification.soundEnabled";
  return '<button type="button" class="link-action notification-sound-control" data-notification-mute aria-pressed="' + String(view.soundMuted) + '" title="' + escapeHtml(i18n.t(key)) + '">' + escapeHtml(i18n.t(stateKey)) + "</button>";
}

function notificationHeader(view, withRefresh = false) {
  const refresh = withRefresh ? '<button type="button" class="secondary-action utility-refresh" data-notifications-refresh>' + escapeHtml(i18n.t("notification.refresh")) + "</button>" : "";
  return '<header class="utility-header"><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><div>' + notificationSoundControl(view) + refresh + '<button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(notificationCloseLabel()) + '">×</button></div></header>';
}

function ingestNotifications(items, { playSound = true } = {}) {
  const view = state.notifications;
  const nextItems = Array.isArray(items) ? items : [];
  const summary = notificationSummary(nextItems, view.seenIDs);
  const fresh = view.baselineInitialized
    ? summary.unseen.filter((item) => !view.knownIDs.has(notificationKey(item)))
    : [];
  nextItems.map(notificationKey).filter(Boolean).forEach((id) => view.knownIDs.add(id));
  view.items = nextItems;
  view.baselineInitialized = true;
  if (playSound && fresh.length > 0) playNotificationSound();
  if (view.open) markNotificationsSeen(nextItems);
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
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = notificationHeader(view) + '<p class="surface-state" role="status">' + escapeHtml(i18n.t("notification.loading")) + "</p>";
  } else if (view.state === "error") {
    root.innerHTML = notificationHeader(view, true) + '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("notification.unavailable")) + "</p>";
  } else {
    const rows = view.items.map((item) => {
      const pending = view.actionState !== "idle" && String(view.actionId) === String(item?.id);
      const availableNotification = presentNotification(item, { i18n, presentation, capabilities: state.capabilities });
      const notification = presentNotification(item, { i18n, presentation, capabilities: state.capabilities, pending });
      const serverRead = notificationIsServerRead(item);
      const scope = notification.scopeAvailable ? "" : '<p class="notification-scope">' + escapeHtml(i18n.t("notification.scopeUnavailable")) + "</p>";
      const attempts = notification.attempts == null ? "" : '<small>' + escapeHtml(i18n.t("notification.attempts", { count: notification.attempts })) + "</small>";
      const next = notification.nextAttemptLabel ? '<small>' + escapeHtml(i18n.t("notification.nextAttempt")) + ": " + escapeHtml(notification.nextAttemptLabel) + "</small>" : "";
      const dispatch = availableNotification.actions?.canDispatch && notification.id != null ? '<button type="button" class="secondary-action" data-notification-dispatch="' + escapeHtml(notification.id) + '"' + (pending ? " disabled" : "") + '>' + escapeHtml(notificationDispatchLabel()) + "</button>" : "";
      const actionError = String(view.actionErrorId) === String(item?.id) && view.actionError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.actionError)) + "</p>" : "";
      const technical = notification.technical ? '<details><summary>' + escapeHtml(i18n.t("audit.technical")) + '</summary><pre>' + escapeHtml(JSON.stringify(notification.technical, null, 2)) + "</pre></details>" : "";
      return '<article class="notification-item" data-server-read="' + String(serverRead) + '"><div class="notification-item-head"><strong>' + escapeHtml(notification.sourceLabel) + '</strong><span>' + escapeHtml(notification.deliveryLabel) + '</span></div><p>' + escapeHtml(notification.message) + '</p><small>' + escapeHtml(notification.generatedLabel) + '</small>' + attempts + next + scope + dispatch + actionError + technical + '</article>';
    }).join("");
    root.innerHTML = notificationHeader(view, true) + (rows || '<p class="surface-state">' + escapeHtml(i18n.t("notification.empty")) + "</p>");
  }
  root.querySelector("[data-notifications-close]")?.addEventListener("click", closeNotifications);
  root.querySelector("[data-notifications-refresh]")?.addEventListener("click", () => loadNotifications({ force: true }));
  root.querySelector("[data-notification-mute]")?.addEventListener("click", () => {
    view.soundMuted = !view.soundMuted;
    writeNotificationSoundMuted(browserStorage(), view.soundMuted);
    renderNotificationsSurface();
  });
  root.querySelectorAll("[data-notification-dispatch]").forEach((button) => button.addEventListener("click", () => dispatchNotification(button.dataset.notificationDispatch)));
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
    ingestNotifications(readback, { playSound: false });
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

function adminEditorMode(resource, id = "") {
  const definition = adminResourceConfig(resource);
  if (!definition) return "";
  if (resource === "devices" && !id && definition.supportsRegistration) return "register";
  if (id && definition.supportsUpdate) return "update";
  if (!id && definition.supportsCreate) return "create";
  if (!id && resource === "schedule" && definition.supportsUpdate) return "update";
  return "";
}

const ADMIN_EDITOR_FIELD_KEYS = Object.freeze({
  id: "admin.recordId", school_id: "field.school", organization_id: "field.school", provider_id: "field.provider", line_id: "field.line",
  name: "field.officialIdentity", district: "field.district", district_id: "field.district", address: "field.address", active: "admin.status",
  role: "field.lineRole", technology: "field.connectionType", technology_id: "field.connectionType", status: "field.status", location: "field.address",
  is_primary: "admin.status", username: "field.username", password: "field.password", disabled: "admin.status", scopes: "field.registryProvenance",
  display_name: "admin.identity", agent_version: "audit.version", tests_per_day: "admin.identity", performance_tests_per_day: "admin.identity",
  jitter_minutes: "field.jitter", light_checks_between: "admin.status", scope_type: "field.registryProvenance", scope_id: "field.registryNumber",
  version: "audit.version", valid_from: "audit.at", valid_to: "audit.at", contract_no: "field.contract", contract_date: "audit.at",
  download_min: "field.download", upload_min: "field.upload", ping_max: "field.ping", jitter_max: "field.jitter", packet_loss_max: "field.loss",
  availability_min: "field.metrics", confirm_count: "field.metrics", confirm_minutes: "field.metrics", confirm_duration_minutes: "field.metrics",
  recovery_count: "field.metrics", recovery_minutes: "field.metrics", freshness_seconds: "field.lastObserved", reason: "field.reason",
  recommended: "admin.status", minimum_supported: "admin.status", release_at: "audit.at", checksum: "admin.details", artifact_url: "admin.details",
});
const ADMIN_EDITOR_STRUCTURED_FIELDS = new Set(["scopes", "manifest", "line_ids", "device_ids", "policy", "contract"]);
const ADMIN_EDITOR_BOOLEAN_FIELDS = new Set(["active", "disabled", "is_primary", "recommended", "minimum_supported"]);

function adminEditorFieldLabel(field) {
  return i18n.t(ADMIN_EDITOR_FIELD_KEYS[field] || "admin.details");
}

function adminEditorSource(view) {
  try {
    const value = JSON.parse(view.payload || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    return {};
  }
}

function hydrateAdminEditorFields(root, view, definition, editorMode) {
  const payloadControl = root.querySelector("[name=payload]");
  const payloadLabel = payloadControl?.closest("label");
  const form = root.querySelector("[data-admin-editor]");
  if (!payloadControl || !payloadLabel || !form || !definition) return;
  const source = adminEditorSource(view);
  const fields = (editorMode === "register" ? definition.registrationFields : definition.writableFields)
    .filter((field) => !(editorMode === "update" && field === "id"));
  const fieldGroup = document.createElement("div");
  fieldGroup.className = "admin-fields";
  fields.forEach((field) => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = adminEditorFieldLabel(field);
    label.appendChild(text);
    const value = source[field];
    if (ADMIN_EDITOR_BOOLEAN_FIELDS.has(field)) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.adminField = field;
      input.checked = value === true || value === "true";
      label.appendChild(input);
    } else if (ADMIN_EDITOR_STRUCTURED_FIELDS.has(field)) {
      const input = document.createElement("textarea");
      input.dataset.adminField = field;
      input.rows = 4;
      input.spellcheck = false;
      input.value = value === undefined || value === "" ? "" : JSON.stringify(value, null, 2);
      label.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.dataset.adminField = field;
      input.type = field === "password" ? "password" : "text";
      input.value = value === undefined || value === null ? "" : String(value);
      if (field === "password") input.autocomplete = "new-password";
      label.appendChild(input);
    }
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
  const header = '<header class="surface-header"><div><h1>' + escapeHtml(i18n.t("admin.title")) + '</h1><p>' + escapeHtml(i18n.t("admin.subtitle")) + '</p></div><button type="button" class="secondary-action" data-admin-refresh>' + escapeHtml(i18n.t("admin.refresh")) + "</button></header>";
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="secondary-shell">' + header + '<p class="surface-state" role="status">' + escapeHtml(i18n.t("admin.loading")) + "</p></div>";
    root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true }));
    return;
  }
  if (view.state === "error") {
    root.innerHTML = '<div class="secondary-shell">' + header + '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("admin.unavailable")) + "</p></div>";
    root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true }));
    return;
  }
  const mutationBusy = view.mutationState === "saving";
  const resourceDefinition = adminResourceConfig(view.resource);
  const editorMode = adminEditorMode(view.resource, view.selectedId);
  const rows = view.items.map((item) => {
    const id = adminRecordId(item);
    const presented = presentAdminRecord(view.resource, item, { i18n, presentation });
    const cells = presented.fields.map((field) => '<div><dt>' + escapeHtml(field.label) + '</dt><dd>' + escapeHtml(field.value) + "</dd></div>").join("");
    const edit = resourceDefinition?.supportsUpdate && view.resource !== "schedule" && id ? '<button type="button" class="link-action" data-admin-edit="' + escapeHtml(String(id)) + '"' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.update")) + "</button>" : "";
    const deviceDisabled = mutationBusy ? " disabled" : "";
    const deviceActions = view.resource === "devices" && id ? '<div class="admin-device-actions"><button type="button" class="link-action" data-admin-device-action="block" data-admin-device-id="' + escapeHtml(String(id)) + '"' + deviceDisabled + '>' + escapeHtml(i18n.t("admin.block")) + '</button><button type="button" class="link-action" data-admin-device-action="unblock" data-admin-device-id="' + escapeHtml(String(id)) + '"' + deviceDisabled + '>' + escapeHtml(i18n.t("admin.unblock")) + '</button><button type="button" class="link-action" data-admin-device-action="rotate-token" data-admin-device-id="' + escapeHtml(String(id)) + '"' + deviceDisabled + '>' + escapeHtml(i18n.t("admin.rotateToken")) + "</button></div>" : "";
    return '<article class="admin-record"><dl class="detail-grid">' + cells + '</dl>' + edit + deviceActions + '<details><summary>' + escapeHtml(i18n.t("admin.details")) + '</summary><pre>' + escapeHtml(JSON.stringify(presented.technical, null, 2)) + "</pre></details></article>";
  }).join("");
  const payloadLabel = editorMode === "register" ? i18n.t("admin.registerDevice") : editorMode === "update" ? i18n.t("admin.update") : i18n.t("admin.create");
  const message = view.message ? '<p class="surface-state' + (view.mutationState === "error" ? " error" : "") + '" role="status">' + escapeHtml(i18n.t(view.message)) + "</p>" : "";
  const impactControl = ["policies", "contracts", "lines"].includes(view.resource) ? '<button type="button" class="secondary-action" data-admin-impact' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.impactPreview")) + '</button>' : "";
  const agentControl = ["agent-versions", "devices"].includes(view.resource) ? '<button type="button" class="secondary-action" data-admin-agent-update' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(i18n.t("admin.agentUpdate")) + '</button>' : "";
  const editor = editorMode ? '<form class="admin-editor" data-admin-editor><h2>' + escapeHtml(payloadLabel) + '</h2><label>' + escapeHtml(i18n.t("admin.recordId")) + '<input name="recordId" value="' + escapeHtml(view.selectedId) + '" placeholder="' + escapeHtml(i18n.t("empty.value")) + '"' + (editorMode === "update" ? " readonly" : "") + '></label><label>' + escapeHtml(i18n.t("admin.payload")) + '<textarea name="payload" required spellcheck="false">' + escapeHtml(view.payload) + '</textarea></label><p class="form-hint">' + escapeHtml(i18n.t("admin.payloadHint")) + '</p><button type="submit" class="primary-action"' + (mutationBusy ? " disabled" : "") + '>' + escapeHtml(payloadLabel) + '</button>' + impactControl + agentControl + '</form>' : '<div class="admin-editor"><p class="surface-state">' + escapeHtml(i18n.t("admin.resourceCapability")) + '</p>' + impactControl + agentControl + '</div>';
  const preview = view.preview ? '<div class="admin-preview"><h2>' + escapeHtml(i18n.t("admin.impactPreview")) + '</h2><p>' + escapeHtml(i18n.t("admin.previewReady")) + '</p><details><summary>' + escapeHtml(i18n.t("admin.details")) + '</summary><pre>' + escapeHtml(JSON.stringify(view.preview, null, 2)) + '</pre></details></div>' : "";
  root.innerHTML = '<div class="secondary-shell">' + header + '<div class="admin-toolbar"><label>' + escapeHtml(i18n.t("admin.resource")) + '<select data-admin-resource' + (mutationBusy ? " disabled" : "") + '>' + options + "</select></label></div>" + (rows || '<p class="surface-state">' + escapeHtml(i18n.t("admin.empty")) + '</p>') + editor + message + preview + '</div>';
  hydrateAdminEditorFields(root, view, resourceDefinition, editorMode);
  pruneUnavailableDeviceActions(root, view);
  bindAdminSurfaceEvents(root);
}

function bindAdminSurfaceEvents(root) {
  root.querySelector("[data-admin-resource]")?.addEventListener("change", (event) => {
    state.admin.resource = event.target.value;
    state.admin.selectedId = "";
    state.admin.payload = "{}";
    state.admin.message = "";
    loadAdminResource({ force: true });
  });
  root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true }));
  root.querySelectorAll("[data-admin-edit]").forEach((button) => button.addEventListener("click", () => {
    const item = state.admin.items.find((candidate) => String(adminRecordId(candidate)) === String(button.dataset.adminEdit));
    if (!item) return;
    const id = String(adminRecordId(item));
    const definition = adminResourceDefinition(state.admin.resource);
    if (!definition.supportsUpdate) return;
    state.admin.selectedId = id;
    state.admin.payload = JSON.stringify(writableAdminPayload(state.admin.resource, item, { id, operation: "update" }), null, 2);
    state.admin.message = "";
    renderAdminSurface();
    root.querySelector("[name=payload]")?.focus();
  }));
  root.querySelector("[data-admin-editor]")?.addEventListener("submit", submitAdminMutation);
  root.querySelectorAll("[data-admin-device-action]").forEach((button) => button.addEventListener("click", () => adminDeviceAction(button.dataset.adminDeviceId, button.dataset.adminDeviceAction)));
  root.querySelector("[data-admin-impact]")?.addEventListener("click", runAdminImpactPreview);
  root.querySelector("[data-admin-agent-update]")?.addEventListener("click", runAdminAgentUpdate);
}

async function loadAdminResource({ force = false } = {}) {
  const view = state.admin;
  if (!session.authenticated || !state.capabilities.has("admin.manage") || router.getState().view !== "admin") return;
  const allowed = adminResourceOptions();
  if (!allowed.some((resource) => resource.key === view.resource)) view.resource = allowed[0]?.key || "organizations";
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderAdminSurface(); return; }
  view.state = "loading";
  view.message = "";
  renderAdminSurface();
  view.loadPromise = boundaries.admin.list(view.resource).then((items) => { view.items = Array.isArray(items) ? items : []; view.state = "ready"; }).catch(() => { view.items = []; view.state = "error"; view.message = "admin.unavailable"; }).finally(() => { view.loadPromise = null; renderAdminSurface(); });
  return view.loadPromise;
}

function parseAdminPayload(root) {
  try {
    const fields = [...root.querySelectorAll("[data-admin-field]")];
    const payload = fields.length
      ? Object.fromEntries(fields.map((field) => {
        if (field.type === "checkbox") return [field.dataset.adminField, field.checked];
        const raw = field.value.trim();
        if (!raw) return [field.dataset.adminField, undefined];
        if (ADMIN_EDITOR_STRUCTURED_FIELDS.has(field.dataset.adminField)) return [field.dataset.adminField, JSON.parse(raw)];
        return [field.dataset.adminField, raw];
      }).filter(([, value]) => value !== undefined))
      : JSON.parse(root.querySelector("[name=payload]")?.value || "{}");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("object expected");
    return { id: root.querySelector("[name=recordId]")?.value.trim() || "", payload };
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.payloadInvalid";
    renderAdminSurface();
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
  const { id, payload } = parsed;
  const resource = state.admin.resource;
  const mode = adminEditorMode(resource, id);
  if (!mode) return;
  let normalizedPayload;
  try {
    normalizedPayload = mode === "register" ? payload : writableAdminPayload(resource, payload, { id, operation: mode });
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.actionFailed";
    renderAdminSurface();
    return;
  }
  if (isDestructiveAdminPayload(resource, normalizedPayload) && !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  if (!isDestructiveAdminPayload(resource, payload) && !globalThis.confirm?.(i18n.t("admin.confirmSave"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminSurface();
  try {
    const result = mode === "register" ? await boundaries.admin.registerDevice(payload) : await boundaries.admin.save(resource, id, normalizedPayload);
    state.admin.selectedId = String(adminRecordId(result) || id || "");
    state.admin.payload = JSON.stringify(result || payload, null, 2);
    state.admin.mutationState = "success";
    state.admin.message = "admin.mutationSucceeded";
    await loadAdminResource({ force: true });
    if (state.admin.state === "ready") { state.admin.mutationState = "success"; state.admin.message = "admin.mutationSucceeded"; renderAdminSurface(); }
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.mutationFailed";
    renderAdminSurface();
  }
}

async function adminDeviceAction(id, action) {
  if (!id || !state.capabilities.has("admin.devices") || state.admin.mutationState === "saving") return;
  if (!globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminSurface();
  try {
    const result = objectPayload(await boundaries.admin.deviceAction(id, action));
    state.admin.payload = JSON.stringify(result || {}, null, 2);
    state.admin.mutationState = "success";
    state.admin.message = "admin.mutationSucceeded";
    await loadAdminResource({ force: true });
    if (state.admin.state === "ready") { state.admin.mutationState = "success"; state.admin.message = "admin.mutationSucceeded"; renderAdminSurface(); }
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.actionFailed";
    renderAdminSurface();
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
  renderAdminSurface();
}

async function runAdminAgentUpdate() {
  if (state.admin.mutationState === "saving") return;
  const parsed = parseAdminPayload($("#adminSurface"));
  if (!parsed || !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminSurface();
  try {
    state.admin.payload = JSON.stringify(objectPayload(await boundaries.admin.agentUpdate(parsed.payload)), null, 2);
    state.admin.message = "admin.mutationSucceeded";
    state.admin.mutationState = "success";
    await loadAdminResource({ force: true });
    if (state.admin.state === "ready") { state.admin.mutationState = "success"; state.admin.message = "admin.mutationSucceeded"; renderAdminSurface(); }
  } catch (error) {
    state.admin.message = "admin.actionFailed";
    state.admin.mutationState = "error";
  }
  renderAdminSurface();
}

function auditMatchesSearch(item, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return true;
  const entry = presentAuditItem(item, { i18n, presentation });
  return [entry.actionLabel, entry.objectLabel, entry.actorLabel, entry.rawAction, entry.rawObjectType, entry.rawObject, entry.rawActor]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
}

function renderAuditSurface() {
  const root = $("#auditSurface");
  if (!root) return;
  const view = state.audit;
  root.hidden = router.getState().view !== "audit" || !state.capabilities.has("audit.read");
  if (root.hidden) return;
  const header = '<header class="surface-header"><div><h1>' + escapeHtml(i18n.t("audit.title")) + '</h1><p>' + escapeHtml(i18n.t("audit.subtitle")) + '</p></div><button type="button" class="secondary-action" data-audit-refresh>' + escapeHtml(i18n.t("audit.refresh")) + "</button></header>";
  const tabs = '<div class="secondary-tabs"><button type="button" class="secondary-action" data-audit-tab="log"' + (view.tab === "log" ? ' aria-current="page"' : "") + '>' + escapeHtml(i18n.t("audit.title")) + '</button><button type="button" class="secondary-action" data-audit-tab="versions"' + (view.tab === "versions" ? ' aria-current="page"' : "") + '>' + escapeHtml(i18n.t("audit.agentVersions")) + "</button></div>";
  if (view.tab === "versions") {
    const content = view.versionsState === "loading" ? '<p class="surface-state" role="status">' + escapeHtml(i18n.t("audit.versionsLoading")) + '</p>' : view.versionsState === "error" ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("audit.versionsUnavailable")) + '</p>' : view.versions.length ? '<div class="audit-records">' + view.versions.map((item) => { const version = presentAgentVersion(item, { i18n, presentation }); return '<article class="audit-record"><div class="audit-record-head"><strong>' + escapeHtml(version.version) + '</strong><span>' + escapeHtml(version.sourceLabel) + '</span></div><dl class="detail-grid"><div><dt>' + escapeHtml(i18n.t("audit.devices")) + '</dt><dd>' + escapeHtml(String(version.deviceCount)) + '</dd></div><div><dt>' + escapeHtml(i18n.t("audit.lastSeen")) + '</dt><dd>' + escapeHtml(version.lastSeenLabel) + '</dd></div></dl><button type="button" class="link-action" data-audit-version="' + escapeHtml(version.version) + '">' + escapeHtml(i18n.t("audit.openDevices")) + '</button>' + (view.selectedVersion === version.version ? renderAuditDevices() : "") + '</article>'; }).join("") + '</div>' : '<p class="surface-state">' + escapeHtml(i18n.t("audit.versionsEmpty")) + '</p>';
    root.innerHTML = '<div class="secondary-shell">' + header + tabs + content + "</div>";
  } else {
    const actionOptions = [...new Set(view.items.map((item) => item?.action || item?.event_type).filter(Boolean))].map((value) => '<option value="' + escapeHtml(value) + '"' + (view.filters.action === value ? " selected" : "") + '>' + escapeHtml(presentation.action(value)) + "</option>").join("");
    const objectOptions = [...new Set(view.items.map((item) => item?.object_type).filter(Boolean))].map((value) => { const object = presentAuditItem({ object_type: value }, { i18n, presentation }); return '<option value="' + escapeHtml(value) + '"' + (view.filters.object_type === value ? " selected" : "") + '>' + escapeHtml(object.objectLabel) + "</option>"; }).join("");
    const rows = view.items.filter((item) => auditMatchesSearch(item, view.search)).map((item) => { const entry = presentAuditItem(item, { i18n, presentation }); const technical = { action: entry.rawAction, object_type: entry.rawObjectType, object_id: entry.rawObject, actor_type: entry.rawActorType, actor_id: entry.rawActor, payload: entry.payload }; return '<article class="audit-record"><div class="audit-record-head"><strong>' + escapeHtml(entry.actionLabel) + '</strong><span>' + escapeHtml(entry.atLabel) + '</span></div><dl class="detail-grid"><div><dt>' + escapeHtml(i18n.t("audit.object")) + '</dt><dd>' + escapeHtml(entry.objectLabel) + '</dd></div><div><dt>' + escapeHtml(i18n.t("audit.actor")) + '</dt><dd>' + escapeHtml(entry.actorLabel) + '</dd></div></dl>' + (entry.rawAction || entry.rawObjectType || entry.rawObject || entry.rawActorType || entry.rawActor || entry.payload ? '<details><summary>' + escapeHtml(i18n.t("audit.technical")) + '</summary><pre>' + escapeHtml(JSON.stringify(technical, null, 2)) + '</pre></details>' : "") + '</article>'; }).join("");
    const content = view.state === "loading" ? '<p class="surface-state" role="status">' + escapeHtml(i18n.t("audit.loading")) + '</p>' : view.state === "error" ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("audit.unavailable")) + '</p>' : rows || '<p class="surface-state">' + escapeHtml(i18n.t(view.search ? "audit.noSearchResults" : "audit.empty")) + '</p>';
    root.innerHTML = '<div class="secondary-shell">' + header + tabs + '<form class="audit-filters" data-audit-filters><label>' + escapeHtml(i18n.t("audit.action")) + '<select name="action"><option value="">' + escapeHtml(i18n.t("audit.anyAction")) + '</option>' + actionOptions + '</select></label><label>' + escapeHtml(i18n.t("audit.object")) + '<select name="object_type"><option value="">' + escapeHtml(i18n.t("audit.anyObject")) + '</option>' + objectOptions + '</select></label><button type="submit" class="secondary-action">' + escapeHtml(i18n.t("admin.refresh")) + '</button></form><div class="audit-records">' + content + '</div></div>';
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
  root.querySelector("[data-audit-filters]")?.addEventListener("submit", (event) => { event.preventDefault(); state.audit.filters = Object.fromEntries(new FormData(event.currentTarget)); loadAuditLog({ force: true }); });
  root.querySelectorAll("[data-audit-version]").forEach((button) => button.addEventListener("click", () => loadVersionDevices(button.dataset.auditVersion)));
}

async function loadAuditLog({ force = false } = {}) {
  const view = state.audit;
  if (!session.authenticated || !state.capabilities.has("audit.read") || router.getState().view !== "audit") return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderAuditSurface(); return; }
  view.state = "loading";
  renderAuditSurface();
  view.loadPromise = boundaries.audit.list({ limit: "50", ...view.filters }).then((response) => { view.items = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []); view.nextBeforeId = response?.next_before_id || ""; view.state = "ready"; }).catch(() => { view.items = []; view.state = "error"; }).finally(() => { view.loadPromise = null; renderAuditSurface(); });
  return view.loadPromise;
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
  if (!statusControls.length && !assigneeControls.length && !actionControls.length && !view.actionError) return "";
  const error = view.actionError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.actionError)) + "</p>" : "";
  const group = (title, controls, className) => controls.length ? '<section class="incident-action-group ' + className + '"><h4>' + escapeHtml(i18n.t(title)) + '</h4>' + controls.join("") + "</section>" : "";
  return '<section class="incident-actions"><h3>' + escapeHtml(i18n.t("incidents.workflow")) + "</h3>" + group("incidents.statusGroup", statusControls, "incident-status-group") + group("incidents.assigneeGroup", assigneeControls, "incident-assignee-group") + group("incidents.actionsGroup", actionControls, "incident-actions-group") + error + "</section>";
}

function renderIncidentDetail() {
  const view = incidentSurfaceState();
  if (!view.selectedId) return '<p class="surface-state">' + escapeHtml(i18n.t("incidents.select")) + "</p>";
  if (view.detailState === "loading") return '<p class="surface-state">' + escapeHtml(i18n.t("incidents.detailLoading")) + "</p>";
  if (view.detailState === "error" || !view.detail) return '<p class="surface-state error">' + escapeHtml(i18n.t("incidents.detailUnavailable")) + "</p>";
  if (view.selectedSituationId) return renderSituationDetail();

  const detail = view.detail;
  const incident = presentIncident(detail, { i18n, presentation });
  const recovery = presentRecovery(detail, { i18n });
  const confirmation = detail?.evidence_chain?.confirmation;
  const evidenceCount = Number(confirmation?.count);
  const confirmed = Number.isFinite(evidenceCount) && evidenceCount > 0
    ? i18n.t("incidents.evidenceCount", { count: evidenceCount })
    : i18n.t("incidents.evidenceUnavailable");
  const events = presentTimeline(detail.events, { i18n, presentation });
  const timeline = events.length ? events.map((event) => '<li><time>' + escapeHtml(event.atLabel) + '</time><div><strong>' + escapeHtml(event.label) + "</strong>" + (event.note ? '<p>' + escapeHtml(event.note) + "</p>" : "") + (event.status ? '<small>' + escapeHtml(event.status) + "</small>" : "") + (event.actor ? '<small class="timeline-actor">' + escapeHtml(event.actor) + "</small>" : "") + "</div></li>").join("") : '<p class="surface-state">' + escapeHtml(i18n.t("incidents.timelineEmpty")) + "</p>";
  const lineAvailable = Boolean(map.getLine(detail.line_id));
  const canComment = state.capabilities.has("incident.update");
  const commentForm = canComment ? '<form class="incident-comment-form" data-incident-comment><label for="incidentComment">' + escapeHtml(i18n.t("incidents.comment")) + '</label><textarea id="incidentComment" required maxlength="4000" placeholder="' + escapeHtml(i18n.t("incidents.commentPlaceholder")) + '"></textarea><button class="secondary-action" type="submit">' + escapeHtml(i18n.t("incidents.sendComment")) + "</button></form>" : "";
  return '<header class="incident-detail-head"><span class="severity-' + escapeHtml(incident.severity.toLowerCase()) + '">' + escapeHtml(incident.severityLabel) + "</span><h2>" + escapeHtml(incident.number) + "</h2><p>" + escapeHtml(incident.statusLabel) + "</p></header><section><h3>" + escapeHtml(i18n.t("incidents.what")) + "</h3><p>" + escapeHtml(incident.typeLabel) + '</p></section><dl class="detail-grid"><div><dt>' + escapeHtml(i18n.t("incidents.where")) + "</dt><dd>" + escapeHtml(incident.school) + " · " + escapeHtml(incident.line) + "</dd></div><div><dt>" + escapeHtml(i18n.t("incidents.when")) + "</dt><dd>" + escapeHtml(incident.startedLabel) + " · " + escapeHtml(incident.durationLabel) + "</dd></div><div><dt>" + escapeHtml(i18n.t("incidents.confirmed")) + "</dt><dd>" + escapeHtml(confirmed) + "</dd></div><div><dt>" + escapeHtml(i18n.t("incidents.recovery")) + "</dt><dd>" + escapeHtml(recovery.label) + "</dd></div>" + (detail.assignee ? "<div><dt>" + escapeHtml(i18n.t("field.assignee")) + "</dt><dd>" + escapeHtml(detail.assignee) + "</dd></div>" : "") + "</dl>" + (lineAvailable ? '<button class="secondary-action" type="button" data-incident-open-line="' + escapeHtml(detail.line_id) + '">' + escapeHtml(i18n.t("incidents.openLine")) + "</button>" : "") + '<section><h3>' + escapeHtml(i18n.t("incidents.timelineGroup")) + "</h3><ol class=\"incident-timeline\">" + timeline + "</ol>" + commentForm + "</section>" + renderIncidentActionControls(detail) + renderProviderCaseContext(detail) + renderSituationContext(detail.id);
}

function renderProviderCaseContext(incident) {
  const view = incidentSurfaceState();
  const providerView = view.providerCase;
  const cases = Array.isArray(incident.provider_cases) ? incident.provider_cases : [];
  const canPrepare = providerCaseActions(null, state.capabilities).canPrepare;
  const list = cases.length ? '<ul class="case-summary">' + cases.map((item) => {
    const current = String(providerView.selectedId) === String(item.id);
    return '<li><button class="link-action" type="button" data-provider-case-id="' + escapeHtml(item.id) + '"' + (current ? ' aria-current="true"' : "") + '>' + escapeHtml(i18n.t("field.providerCase")) + " #" + escapeHtml(item.ticket_no || item.external_ticket_no || item.id) + ' <span>' + escapeHtml(presentation.deliveryStatus(item.delivery_status)) + "</span></button></li>";
  }).join("") + "</ul>" : '<p class="detail-muted">' + escapeHtml(i18n.t("incidents.noRelatedCases")) + "</p>";
  const providerBusy = providerView.actionState !== "idle";
  const create = !cases.length && canPrepare
    ? '<button class="secondary-action" type="button" data-provider-case-prepare' + (providerBusy ? " disabled" : "") + ">" + escapeHtml(i18n.t("providerCase.prepare")) + "</button>"
    : !cases.length ? '<p class="detail-muted">' + escapeHtml(i18n.t("providerCase.unavailable")) + "</p>" : "";
  const actionError = providerView.actionError ? '<p class="provider-case-error" role="alert">' + escapeHtml(i18n.t(providerView.actionError)) + "</p>" : "";
  return '<section class="provider-case-context"><h3>' + escapeHtml(i18n.t("incidents.relatedCases")) + "</h3>" + list + create + actionError + renderSelectedProviderCase() + "</section>";
}

function renderSelectedProviderCase() {
  const providerView = incidentSurfaceState().providerCase;
  if (!providerView.selectedId) return "";
  if (providerView.state === "loading") return '<p class="detail-muted" role="status">' + escapeHtml(i18n.t("providerCase.loading")) + "</p>";
  if (providerView.state === "error" || !providerView.detail) return '<p class="provider-case-error" role="alert">' + escapeHtml(i18n.t("providerCase.detailUnavailable")) + "</p>";
  const item = presentProviderCase(providerView.detail, { i18n, presentation });
  const actions = providerCaseActions(providerView.detail, state.capabilities);
  const metadata = '<dl class="detail-grid provider-case-fields"><div><dt>' + escapeHtml(i18n.t("providerCase.source")) + "</dt><dd>" + escapeHtml(item.sourceLabel) + "</dd></div><div><dt>" + escapeHtml(i18n.t("providerCase.status")) + "</dt><dd>" + escapeHtml(item.statusLabel) + " · " + escapeHtml(item.deliveryLabel) + "</dd></div><div><dt>" + escapeHtml(i18n.t("providerCase.createdAt")) + "</dt><dd>" + escapeHtml(item.createdAtLabel) + "</dd></div><div><dt>" + escapeHtml(i18n.t("providerCase.lastVerified")) + "</dt><dd>" + escapeHtml(item.lastVerifiedLabel) + "</dd></div><div><dt>" + escapeHtml(i18n.t("providerCase.provenance")) + "</dt><dd>" + escapeHtml(item.provenanceLabel) + "</dd></div>" + (item.externalReference ? "<div><dt>" + escapeHtml(i18n.t("providerCase.reference")) + "</dt><dd>" + escapeHtml(item.externalReference) + "</dd></div>" : "") + (item.status === "SENT" ? "<div><dt>" + escapeHtml(i18n.t("providerCase.sentAt")) + "</dt><dd>" + escapeHtml(item.sentAtLabel) + "</dd></div>" : "") + "</dl>";
  const automatic = providerView.generated?.provider ? '<p class="detail-muted">' + escapeHtml(i18n.t("providerCase.automaticDraft")) + "</p>" : "";
  const draft = item.text ? '<label class="provider-case-text"><span>' + escapeHtml(i18n.t("providerCase.text")) + '</span><textarea data-provider-case-text maxlength="32768"' + (actions.canSend ? "" : " readonly") + ">" + escapeHtml(item.text) + "</textarea></label>" : '<p class="provider-case-error">' + escapeHtml(i18n.t("providerCase.textUnavailable")) + "</p>";
  const generate = actions.canGenerate ? '<button class="secondary-action" type="button" data-provider-case-generate' + (providerView.actionState !== "idle" ? " disabled" : "") + ">" + escapeHtml(i18n.t("providerCase.prepareAutomatic")) + "</button>" : "";
  const send = actions.canSend && item.text ? '<form class="provider-case-send" data-provider-case-send><label><input type="checkbox" data-provider-case-reviewed required' + (providerView.actionState !== "idle" ? " disabled" : "") + ' /> ' + escapeHtml(i18n.t("providerCase.reviewed")) + '</label><button class="primary-action" type="submit" data-provider-case-submit' + (providerView.actionState !== "idle" ? " disabled" : "") + ' disabled>' + escapeHtml(i18n.t(actions.isRetry ? "providerCase.retry" : "providerCase.send")) + "</button></form>" : "";
  const delivery = item.deliveryError ? '<details class="provider-case-delivery"><summary>' + escapeHtml(i18n.t("providerCase.deliveryFailed")) + "</summary><p>" + escapeHtml(i18n.t("providerCase.deliveryAttempts", { count: item.deliveryAttempts })) + (item.nextAttemptLabel !== i18n.t("empty.value") ? " · " + escapeHtml(i18n.t("providerCase.nextAttempt", { at: item.nextAttemptLabel })) : "") + "</p><p>" + escapeHtml(item.deliveryError) + "</p></details>" : "";
  return '<article class="provider-case-detail"><h4>' + escapeHtml(i18n.t("providerCase.title", { reference: item.reference })) + "</h4>" + metadata + automatic + draft + '<div class="provider-case-actions">' + generate + "</div>" + send + delivery + "</article>";
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

function renderSituationActionControls(situation, members) {
  const view = incidentSurfaceState();
  const available = situationActions(situation, state.capabilities, "idle");
  const actions = situationActions(situation, state.capabilities, view.situationActionState);
  if (!available.hasMutation) return "";
  const disabled = actions.isPending ? " disabled" : "";
  const controls = [];
  if (actions.canLiveVerify) {
    controls.push('<form class="situation-action-form" data-situation-action-form data-situation-action="live-verify"><button class="secondary-action" type="submit"' + disabled + '>' + escapeHtml(actionCopy("situationLiveVerify")) + "</button></form>");
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
  if (!controls.length && !view.situationActionError) return "";
  const error = view.situationActionError ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t(view.situationActionError)) + "</p>" : "";
  return '<section class="situation-actions"><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3>" + controls.join("") + error + "</section>";
}

function renderSituationDetail() {
  const view = incidentSurfaceState();
  if (view.situationState === "loading") return '<p class="surface-state">' + escapeHtml(i18n.t("situation.loading")) + "</p>";
  if (view.situationState === "error" || !view.situation) return '<p class="surface-state error">' + escapeHtml(i18n.t("situation.unavailable")) + "</p>";
  const situation = view.situation;
  const factors = situation.factors || {};
  const members = Array.isArray(situation.incidents) ? situation.incidents : [];
  const evidence = situation.evidence?.state || "UNKNOWN";
  return '<button class="link-action back-action" type="button" data-situation-back>' + escapeHtml(i18n.t("situation.backToIncident")) + '</button><header class="incident-detail-head"><h2>' + escapeHtml(i18n.t("situation.detailTitle")) + " #" + escapeHtml(situation.id) + "</h2><p>" + escapeHtml(i18n.t("situation.readOnly")) + '</p></header><section><h3>' + escapeHtml(i18n.t("situation.factors")) + "</h3><dl class=\"detail-grid\"><div><dt>" + escapeHtml(i18n.t("field.district")) + "</dt><dd>" + escapeHtml(factors.district || i18n.t("empty.noData")) + "</dd></div><div><dt>" + escapeHtml(i18n.t("field.type")) + "</dt><dd>" + escapeHtml(i18n.has("incidentType." + String(factors.violation_type || "").toUpperCase()) ? i18n.t("incidentType." + String(factors.violation_type).toUpperCase()) : i18n.t("incidentType.UNKNOWN")) + "</dd></div></dl></section><section><h3>" + escapeHtml(i18n.t("situation.evidence")) + "</h3><p>" + escapeHtml(i18n.has("situation.evidence." + evidence) ? i18n.t("situation.evidence." + evidence) : i18n.t("situation.evidence.UNKNOWN")) + "</p></section><section><h3>" + escapeHtml(i18n.t("situation.memberIncidents")) + "</h3><ul class=\"situation-members\">" + members.map((item) => '<li><button class="link-action" type="button" data-incident-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.incident_no || item.number || item.id) + " · " + escapeHtml(item.school_name || item.organization_name || i18n.t("school.noOfficialName")) + "</button></li>").join("") + "</ul></section>" + renderSituationActionControls(situation, members);
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
  renderIncidentsSurface();
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
  } catch (error) {
    if (String(view.selectedId) !== String(incidentID)) return;
    view.actionState = "idle";
    view.actionError = errorMessageKey(error);
  }
  renderIncidentsSurface();
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
  renderIncidentsSurface();
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
  } catch (error) {
    if (String(view.selectedSituationId) !== String(situationID)) return;
    view.situationActionState = "idle";
    view.situationActionError = errorMessageKey(error);
  }
  renderIncidentsSurface();
}

function bindIncidentSurfaceEvents(root) {
  root.querySelector("[data-incidents-refresh]")?.addEventListener("click", () => loadIncidents({ force: true }));
  root.querySelectorAll("[data-incident-filter]").forEach((control) => control.addEventListener("change", () => {
    incidentSurfaceState().filters[control.dataset.incidentFilter] = control.value;
    renderIncidentsSurface();
  }));
  root.querySelectorAll("[data-incident-id]").forEach((control) => control.addEventListener("click", () => selectIncident(control.dataset.incidentId)));
  root.querySelectorAll("[data-situation-id]").forEach((control) => control.addEventListener("click", () => selectSituation(control.dataset.situationId)));
  root.querySelectorAll("[data-provider-case-id]").forEach((control) => control.addEventListener("click", () => selectProviderCase(control.dataset.providerCaseId)));
  root.querySelectorAll("[data-incident-action-form]").forEach((form) => form.addEventListener("submit", submitIncidentAction));
  root.querySelector("[data-provider-case-prepare]")?.addEventListener("click", createIncidentProviderCase);
  root.querySelector("[data-provider-case-generate]")?.addEventListener("click", generateProviderCaseDraft);
  root.querySelector("[data-provider-case-reviewed]")?.addEventListener("change", (event) => {
    const submit = root.querySelector("[data-provider-case-submit]");
    if (submit) submit.disabled = !event.currentTarget.checked;
  });
  root.querySelector("[data-provider-case-send]")?.addEventListener("submit", sendProviderCase);
  root.querySelectorAll("[data-situation-action-form]").forEach((form) => form.addEventListener("submit", submitSituationAction));
  root.querySelector("[data-situation-back]")?.addEventListener("click", () => { const view = incidentSurfaceState(); view.selectedSituationId = null; view.situation = null; view.situationState = "idle"; view.situationActionState = "idle"; view.situationActionError = ""; renderIncidentsSurface(); });
  root.querySelector("[data-incident-open-line]")?.addEventListener("click", () => openIncidentLine(root.querySelector("[data-incident-open-line]").dataset.incidentOpenLine));
  root.querySelector("[data-incident-comment]")?.addEventListener("submit", submitIncidentComment);
}

async function loadIncidents({ force = false } = {}) {
  const view = incidentSurfaceState();
  if (!session.authenticated) return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderIncidentsSurface(); return; }
  view.state = "loading";
  renderIncidentsSurface();
  view.loadPromise = Promise.allSettled([boundaries.incidents.list(), boundaries.incidents.situations()]).then(async ([incidentsResult, situationsResult]) => {
    if (incidentsResult.status !== "fulfilled") {
      view.state = "error";
      renderIncidentsSurface();
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
    renderIncidentsSurface();
    if (view.selectedId) await loadIncidentDetail(view.selectedId);
  }).finally(() => { view.loadPromise = null; });
  return view.loadPromise;
}

async function selectIncident(id) {
  const view = incidentSurfaceState();
  view.selectedId = id;
  view.detail = null;
  view.detailState = "loading";
  view.actionState = "idle";
  view.actionError = "";
  view.selectedSituationId = null;
  view.situation = null;
  view.situationState = "idle";
  view.situationActionState = "idle";
  view.situationActionError = "";
  view.providerCase = { selectedId: null, state: "idle", detail: null, actionState: "idle", actionError: "", generated: null };
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
      view.providerCase = { selectedId: null, state: "idle", detail: null, actionState: "idle", actionError: "", generated: null };
    }
  } catch (error) {
    if (String(view.selectedId) !== String(id)) return;
    view.detail = null;
    view.detailState = "error";
  }
  renderIncidentsSurface();
}

async function selectProviderCase(id) {
  const view = incidentSurfaceState();
  if (!view.detail || !view.selectedId) return;
  view.providerCase = { selectedId: id, state: "loading", detail: null, actionState: "idle", actionError: "", generated: null };
  renderIncidentsSurface();
  try {
    const detail = objectPayload(await boundaries.providerCases.get(id));
    if (String(view.providerCase.selectedId) !== String(id) || String(view.selectedId) !== String(view.detail?.id)) return;
    if (String(detail.incident_id) !== String(view.selectedId)) throw Object.assign(new Error("provider case context mismatch"), { status: 404 });
    view.providerCase.detail = detail;
    view.providerCase.state = "ready";
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(id)) return;
    view.providerCase.state = "error";
  }
  renderIncidentsSurface();
}

async function createIncidentProviderCase() {
  const view = incidentSurfaceState();
  if (!view.selectedId || !view.detail || view.providerCase.actionState !== "idle" || !providerCaseActions(null, state.capabilities).canPrepare) return;
  if (!globalThis.confirm?.(i18n.t("providerCase.confirmPrepare"))) return;
  view.providerCase.actionState = "creating";
  view.providerCase.actionError = "";
  renderIncidentsSurface();
  try {
    const created = objectPayload(await boundaries.incidents.createProviderCaseDraft(view.selectedId));
    await loadIncidentDetail(view.selectedId);
    await selectProviderCase(created.id);
  } catch (error) {
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = "providerCase.prepareFailed";
    renderIncidentsSurface();
  }
}

async function generateProviderCaseDraft() {
  const view = incidentSurfaceState();
  const detail = view.providerCase.detail;
  if (!detail || view.providerCase.actionState !== "idle" || !providerCaseActions(detail, state.capabilities).canGenerate) return;
  if (!globalThis.confirm?.(i18n.t("providerCase.confirmAutomatic"))) return;
  view.providerCase.actionState = "generating";
  view.providerCase.actionError = "";
  renderIncidentsSurface();
  try {
    const generated = objectPayload(await boundaries.providerCases.aiDraft(detail.id));
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.detail = { ...detail, ...generated };
    view.providerCase.generated = generated;
    view.providerCase.actionState = "idle";
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = "providerCase.automaticFailed";
  }
  renderIncidentsSurface();
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
  renderIncidentsSurface();
  try {
    const delivered = request.operation === "retry"
      ? await boundaries.providerCases.retry(detail.id, request.payload)
      : await boundaries.providerCases.send(detail.id, request.payload);
    const sent = objectPayload(delivered);
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.detail = { ...detail, ...sent };
    view.providerCase.actionState = "idle";
    await loadIncidentDetail(view.selectedId);
    await selectProviderCase(detail.id);
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
    renderIncidentsSurface();
  }
}

async function selectSituation(id) {
  const view = incidentSurfaceState();
  view.selectedSituationId = id;
  view.situation = null;
  view.situationState = "loading";
  view.situationActionState = "idle";
  view.situationActionError = "";
  renderIncidentsSurface();
  try {
    const response = objectPayload(await boundaries.incidents.situation(id));
    if (String(view.selectedSituationId) !== String(id)) return;
    view.situation = response;
    view.situationState = "ready";
  } catch (error) {
    if (String(view.selectedSituationId) !== String(id)) return;
    view.situationState = "error";
  }
  renderIncidentsSurface();
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
  if (!note || !view.selectedId || !view.detail || !state.capabilities.has("incident.update")) return;
  if (!globalThis.confirm?.(i18n.t("incidents.confirmComment"))) return;
  const submit = event.currentTarget.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
  try {
    const response = objectPayload(await boundaries.incidents.addEvent(view.selectedId, { event_type: "comment", note }));
    const readback = objectPayload(await boundaries.incidents.get(view.selectedId));
    const next = readback && typeof readback === "object" ? readback : response;
    if (!next || typeof next !== "object") throw new Error("incident readback unavailable");
    view.detail = next;
    const index = view.items.findIndex((item) => String(item.id) === String(view.selectedId));
    if (index >= 0) view.items[index] = next;
    view.detailState = "ready";
    renderIncidentsSurface();
  } catch (error) {
    showToast("incidents.commentFailed", "warn");
    if (submit) submit.disabled = false;
  }
}

async function openIncident(id) {
  if (!state.capabilities.canRead("incident")) return;
  router.navigate("incidents");
  await loadIncidents();
  await selectIncident(id);
}

function closeDrawer(restoreFocus = true) {
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
  $("#schoolSearch")?.addEventListener("input", (event) => { state.searchActiveIndex = -1; map.setFilters({ query: event.target.value }); renderMapStatus(); });
  $("#schoolSearch")?.addEventListener("keydown", handleSchoolSearchKeydown);
  $("#mapFiltersReset")?.addEventListener("click", () => { map.resetFilters(); renderMapStatus(); });
  $("#mapPopupClose")?.addEventListener("click", () => closeMapPopup());
  $("#mapPopupOpenLine")?.addEventListener("click", openSelectedSchoolDetail);
  $("#drawerClose")?.addEventListener("click", closeDrawer);
  $("#drawerBackdrop")?.addEventListener("click", closeDrawer);
  $("#mapZoomIn")?.addEventListener("click", () => mapControlAction("zoomIn"));
  $("#mapZoomOut")?.addEventListener("click", () => mapControlAction("zoomOut"));
  $("#mapReset")?.addEventListener("click", () => globalThis.LinkwatchMap?.resetView());
  document.addEventListener("keydown", (event) => { trapOverlayFocus(event); if (event.key === "Escape") { if (state.notifications.open) closeNotifications(); else if (!$("#mapPopup")?.hidden) closeMapPopup(); else if (!$("#detailDrawer")?.hidden) closeDrawer(); } });
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
