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
import { defaultReportFilters, reportAvailability, reportContextFilters, reportEvidenceSummary, reportFilterOptions, reportQuery, reportState } from "./features/reports-presentation.mjs";
import { filterIncidents, incidentSeverityValues, incidentStatusValues, presentIncident, presentRecovery, presentSituation, presentTimeline, relatedSituations } from "./features/incidents-presentation.mjs";
import { presentProviderCase, providerCaseActions } from "./features/provider-case-presentation.mjs";
import { activeIncident, availableMetrics, createSelectedSchool, mergeLineDetail, selectedLine, selectSchoolLine } from "./features/school-detail.mjs";
import { adminResourceDefinitions, presentAgentVersion, presentAuditItem, presentNotification } from "./features/secondary-presentation.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const state = {
  capabilities: createCapabilityState(null), mapPopupContext: null, mapPopupTrigger: null, selectedSchool: null,
  mapInitialized: false, mapLoaded: false, mapLoadPromise: null, toastTimer: null,
  incidents: createIncidentSurfaceState(),
  reports: createReportsSurfaceState(),
  notifications: createNotificationsSurfaceState(),
  admin: createAdminSurfaceState(),
  audit: createAuditSurfaceState(),
};

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

function createIncidentSurfaceState() {
  return {
    state: "idle", items: [], filters: { status: "", severity: "" }, selectedId: null, detail: null, detailState: "idle",
    situations: [], situationsState: "idle", selectedSituationId: null, situation: null, situationState: "idle",
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
  return { open: false, state: "idle", items: [], loadPromise: null };
}

function createAdminSurfaceState() {
  return { state: "idle", resource: "organizations", items: [], selectedId: "", payload: "{}", mutationState: "idle", message: "", loadPromise: null, preview: null };
}

function createAuditSurfaceState() {
  return { state: "idle", tab: "log", items: [], filters: { action: "", object_type: "" }, nextBeforeId: "", versionsState: "idle", versions: [], selectedVersion: "", devicesState: "idle", devices: [], loadPromise: null };
}

function localizeStaticContent() {
  document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = i18n.t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", i18n.t(element.dataset.i18nAriaLabel)); });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.setAttribute("title", i18n.t(element.dataset.i18nTitle)); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => { element.setAttribute("placeholder", i18n.t(element.dataset.i18nPlaceholder)); });
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
  const refresh = $("#refreshButton");
  if (refresh) refresh.hidden = snapshot.view !== "map";
  const hash = snapshot.view === "map" ? "" : "#" + snapshot.view;
  if (globalThis.location && globalThis.location.hash !== hash) globalThis.history?.replaceState?.({}, "", globalThis.location.pathname + hash);
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
  if (!snapshot.authenticated) {
    state.mapLoaded = false;
    state.mapLoadPromise = null;
    state.selectedSchool = null;
    state.incidents = createIncidentSurfaceState();
    state.reports = createReportsSurfaceState();
    state.notifications = createNotificationsSurfaceState();
    state.admin = createAdminSurfaceState();
    state.audit = createAuditSurfaceState();
  }
  renderSession(snapshot);
  renderPrimaryNav();
  if (snapshot.authenticated) initializeAuthenticatedWorkspace();
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

function renderSchoolSearchResults() {
  const results = $("#schoolSearchResults");
  const status = $("#mapFilterStatus");
  if (!results || !status) return;
  const query = map.state.filters.query.trim();
  results.replaceChildren();
  status.hidden = true;
  if (!query) { results.hidden = true; return; }
  if (map.state.registryLoading) { status.textContent = i18n.t("map.registryLoading"); status.hidden = false; results.hidden = true; return; }
  if (map.state.registryUnavailable) { status.textContent = i18n.t("map.registryUnavailable"); status.hidden = false; results.hidden = true; return; }
  const matches = map.searchResults();
  if (!matches.length) { status.textContent = i18n.t("map.searchEmpty"); status.hidden = false; results.hidden = true; return; }
  matches.forEach((record) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "school-search-result";
    button.setAttribute("role", "option");
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
}

function selectSearchResult(registryId) {
  const result = map.focusSchool(registryId);
  if (!result.ok) {
    const status = $("#mapFilterStatus");
    if (status) { status.textContent = i18n.t("map.searchNoCoordinate"); status.hidden = false; }
    return;
  }
  openMapPopup(result.context, result.marker);
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
}

function openMapPopup(context, trigger = null) {
  state.mapPopupContext = context;
  state.mapPopupTrigger = trigger;
  state.selectedSchool = context.kind === "registry-cluster" ? null : createSelectedSchool(context);
  renderPopup(context);
}
function closeMapPopup(restoreFocus = true) {
  const popup = $("#mapPopup");
  if (!popup) return;
  popup.hidden = true;
  popup.classList.add("hidden");
  if (restoreFocus) state.mapPopupTrigger?.getElement?.()?.focus?.();
  state.mapPopupContext = null;
  state.mapPopupTrigger = null;
  if (!$("#detailDrawer")?.hidden) return;
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

  root.innerHTML = '<div class="incidents-shell"><header class="incidents-header"><div><h1>' + escapeHtml(i18n.t("incidents.title")) + "</h1><p>" + escapeHtml(i18n.t("incidents.subtitle")) + '</p></div><button class="secondary-action" type="button" data-incidents-refresh>' + escapeHtml(i18n.t("incidents.refresh")) + "</button></header><div class="incident-filters">" + filters + '<span class="incident-count">' + escapeHtml(i18n.t("incidents.count", { count: items.length })) + '</span></div><div class="incidents-layout"><section class="incidents-list" aria-label="' + escapeHtml(i18n.t("incidents.title")) + '"><div class="incident-row incident-row-head" aria-hidden="true"><span>' + escapeHtml(i18n.t("field.status")) + "</span><span>" + escapeHtml(i18n.t("field.school")) + "</span><span>" + escapeHtml(i18n.t("field.line")) + "</span><span>" + escapeHtml(i18n.t("incidents.started")) + "</span><span>" + escapeHtml(i18n.t("incidents.duration")) + "</span><span>" + escapeHtml(i18n.t("incidents.lastUpdate")) + "</span></div>" + list + '</section><aside class="incident-detail" aria-live="polite">' + renderIncidentDetail() + "</aside></div></div>";
  bindIncidentSurfaceEvents(root);
}

function reportSurfaceState() { return state.reports; }

function reportNumber(value, suffix = "") {
  if (value === null || value === undefined || value === "") return i18n.t("reports.valueUnavailable");
  const number = Number(value);
  return Number.isFinite(number) ? presentation.formatNumber(number, suffix) : String(value);
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
  const aggregateMessage = view.aggregateState === "error" ? i18n.t("reports.unavailable") : reportState(aggregate, i18n);
  const aggregatePanel = aggregateMessage ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.measurements")) + '</h2><p class="surface-state' + (view.aggregateState === "error" ? " error" : "") + '">' + escapeHtml(aggregateMessage) + "</p></section>" : '<section class="report-panel report-measures"><h2>' + escapeHtml(i18n.t("reports.measurements")) + '</h2><dl class="report-grid"><div><dt>' + escapeHtml(i18n.t("reports.measurements")) + "</dt><dd>" + escapeHtml(reportNumber(aggregate.measurement_count)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.availability")) + "</dt><dd>" + escapeHtml(reportAvailability(aggregate.availability_pct, i18n)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.completeness")) + "</dt><dd>" + escapeHtml(reportAvailability(aggregate.data_completeness_pct, i18n)) + "</dd></div></dl><p class=\"report-note\">" + escapeHtml(i18n.t("reports.historicalOnly")) + "</p></section>";
  const trendRows = Array.isArray(analytics?.trend) ? analytics.trend.map((item) => [item.key, reportNumber(item.measurements), reportNumber(item.valid_evidence), reportAvailability(item.average_availability, i18n)]) : [];
  const rankingRows = Array.isArray(analytics?.ranking) ? analytics.ranking.map((item) => [item.line_id || i18n.t("empty.value"), reportNumber(item.measurements), reportNumber(item.valid_evidence), reportAvailability(item.contract_compliance, i18n)]) : [];
  const analyticsPanel = view.analyticsState === "error" ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.analytics")) + '</h2><p class="surface-state error">' + escapeHtml(i18n.t("reports.unavailable")) + "</p></section>" : '<div class="report-tables">' + renderReportTable(i18n.t("reports.trend"), [i18n.t("reports.to"), i18n.t("reports.measurements"), i18n.t("reports.evidence"), i18n.t("reports.availability")], trendRows) + renderReportTable(i18n.t("reports.ranking"), [i18n.t("field.line"), i18n.t("reports.measurements"), i18n.t("reports.evidence"), i18n.t("reports.contract")], rankingRows) + "</div>";
  const evidence = reportEvidenceSummary(passport, { i18n, presentation });
  const qualityPanel = view.passportState === "error" ? '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.quality")) + '</h2><p class="surface-state error">' + escapeHtml(i18n.t("reports.unavailable")) + "</p></section>" : '<section class="report-panel"><h2>' + escapeHtml(i18n.t("reports.quality")) + '</h2><dl class="report-grid"><div><dt>' + escapeHtml(i18n.t("reports.baseline")) + "</dt><dd>" + escapeHtml(reportAvailability(passport?.baseline_compliance, i18n)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.contract")) + "</dt><dd>" + escapeHtml(reportAvailability(passport?.contract_compliance, i18n)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.incidents")) + "</dt><dd>" + escapeHtml(reportNumber(passport?.incidents?.count)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.evidenceCount")) + "</dt><dd>" + escapeHtml(reportNumber(evidence.count)) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.evidenceProvenance")) + "</dt><dd>" + escapeHtml(evidence.provenance) + "</dd></div><div><dt>" + escapeHtml(i18n.t("reports.lastVerified")) + "</dt><dd>" + escapeHtml(evidence.lastVerified) + "</dd></div></dl>" + (passport?.sufficient_data === false ? '<p class="report-note">' + escapeHtml(i18n.t("reports.insufficient")) + "</p>" : "") + '<div class="report-evidence-action"><button class="secondary-action" type="button" data-evidence-preview>' + escapeHtml(i18n.t("reports.evidencePreview")) + '</button><p class="report-note">' + escapeHtml(i18n.t("reports.evidenceHtmlOnly")) + "</p></div></section>";
  const canExport = state.capabilities.has("report.export");
  const preview = view.preview;
  const previewText = view.previewState === "error" ? i18n.t("reports.previewUnavailable") : preview ? i18n.t(preview.limited ? "reports.previewLimited" : "reports.previewRows", { count: preview.count }) : "";
  const exportPanel = '<section class="report-panel report-export"><h2>' + escapeHtml(i18n.t("reports.export")) + (canExport ? "</h2><form data-report-export><label>" + escapeHtml(i18n.t("reports.exportKind")) + '<select name="kind"><option value="raw">' + escapeHtml(i18n.t("reports.exportRaw")) + '</option><option value="aggregate">' + escapeHtml(i18n.t("reports.exportAggregate")) + '</option></select></label><label>' + escapeHtml(i18n.t("reports.exportFormat")) + '<select name="format"><option value="csv">CSV</option><option value="xlsx">XLSX</option><option value="json">JSON</option></select></label><button class="secondary-action" type="button" data-export-preview>' + escapeHtml(i18n.t("reports.preview")) + '</button><button class="primary-action" type="submit">' + escapeHtml(i18n.t("reports.download")) + "</button></form>" + (previewText ? '<p class="surface-state' + (view.previewState === "error" ? " error" : "") + '">' + escapeHtml(previewText) + (preview?.columns?.length ? " " + escapeHtml(i18n.t("reports.previewColumns")) + ": " + escapeHtml(preview.columns.join(", ")) : "") + "</p>" : "") : '</h2><p class="surface-state">' + escapeHtml(i18n.t("reports.exportUnavailable")) + "</p>") + "</section>";
  root.innerHTML = '<div class="reports-shell"><header class="incidents-header"><div><h1>' + escapeHtml(i18n.t("reports.title")) + "</h1><p>" + escapeHtml(i18n.t("reports.subtitle")) + "</p></div></header>" + form + '<div class="report-overview">' + aggregatePanel + qualityPanel + "</div>" + analyticsPanel + exportPanel + "</div>";
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

function renderNotificationsSurface() {
  const root = $("#notificationsSurface");
  const button = $("#notificationsButton");
  const view = state.notifications;
  const allowed = state.capabilities.has("notification.read");
  if (button) {
    button.hidden = !allowed;
    button.setAttribute("aria-expanded", String(Boolean(allowed && view.open)));
  }
  if (!root) return;
  root.hidden = !allowed || !view.open;
  if (!allowed || !view.open) return;
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<header class="utility-header"><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(i18n.t("action.closeMapCard")) + '">×</button></header><p class="surface-state" role="status">' + escapeHtml(i18n.t("notification.loading")) + "</p>";
  } else if (view.state === "error") {
    root.innerHTML = '<header class="utility-header"><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(i18n.t("action.closeMapCard")) + '">×</button></header><p class="surface-state error" role="alert">' + escapeHtml(i18n.t("notification.unavailable")) + '</p><button type="button" class="secondary-action" data-notifications-refresh>' + escapeHtml(i18n.t("notification.refresh")) + "</button>";
  } else {
    const rows = view.items.map((item) => {
      const notification = presentNotification(item, { i18n, presentation });
      const scope = notification.scopeAvailable ? "" : '<p class="notification-scope">' + escapeHtml(i18n.t("notification.scopeUnavailable")) + "</p>";
      const attempts = notification.attempts == null ? "" : '<small>' + escapeHtml(i18n.t("notification.attempts", { count: notification.attempts })) + "</small>";
      const next = notification.nextAttemptLabel ? '<small>' + escapeHtml(i18n.t("notification.nextAttempt")) + ": " + escapeHtml(notification.nextAttemptLabel) + "</small>" : "";
      return '<article class="notification-item"><div class="notification-item-head"><strong>' + escapeHtml(notification.sourceLabel) + '</strong><span>' + escapeHtml(notification.deliveryLabel) + '</span></div><p>' + escapeHtml(notification.message) + '</p><small>' + escapeHtml(notification.generatedLabel) + '</small>' + attempts + next + scope + '</article>';
    }).join("");
    root.innerHTML = '<header class="utility-header"><h2 id="notificationsTitle">' + escapeHtml(i18n.t("notification.title")) + '</h2><div><button type="button" class="secondary-action utility-refresh" data-notifications-refresh>' + escapeHtml(i18n.t("notification.refresh")) + '</button><button type="button" class="icon-close" data-notifications-close aria-label="' + escapeHtml(i18n.t("action.closeMapCard")) + '">×</button></div></header>' + (rows || '<p class="surface-state">' + escapeHtml(i18n.t("notification.empty")) + "</p>");
  }
  root.querySelector("[data-notifications-close]")?.addEventListener("click", closeNotifications);
  root.querySelector("[data-notifications-refresh]")?.addEventListener("click", () => loadNotifications({ force: true }));
}

function closeNotifications() {
  state.notifications.open = false;
  renderNotificationsSurface();
}

async function loadNotifications({ force = false } = {}) {
  const view = state.notifications;
  if (!session.authenticated || !state.capabilities.has("notification.read")) return;
  if (view.state === "loading") return view.loadPromise;
  if (view.state === "ready" && !force) { renderNotificationsSurface(); return; }
  view.state = "loading";
  renderNotificationsSurface();
  view.loadPromise = boundaries.notifications.list({ limit: "50" }).then((items) => {
    view.items = Array.isArray(items) ? items : [];
    view.state = "ready";
  }).catch(() => {
    view.items = [];
    view.state = "error";
  }).finally(() => { view.loadPromise = null; renderNotificationsSurface(); });
  return view.loadPromise;
}

function toggleNotifications() {
  if (!state.capabilities.has("notification.read")) return;
  state.notifications.open = !state.notifications.open;
  if (state.notifications.open) loadNotifications();
  else renderNotificationsSurface();
}

function adminResourceLabel(resource) { return i18n.t("admin.resources." + resource); }

function adminFieldLabel(key) {
  const labels = {
    id: "field.registryNumber", line_id: "field.line", school_id: "field.school", organization_id: "field.school", provider_id: "field.provider",
    name: "field.officialIdentity", username: "field.username", role: "field.lineRole", status: "field.status", technology: "field.connectionType",
    active: "admin.status", disabled: "admin.status", blocked: "admin.status", last_seen: "audit.lastSeen", version: "audit.version",
  };
  return i18n.t(labels[key] || "admin.identity", undefined, key.replaceAll("_", " "));
}

function adminDisplayValue(key, value) {
  if (value === null || value === undefined || value === "") return i18n.t("empty.noData");
  if (typeof value === "boolean") return value ? i18n.t("status.ATTENTION") : i18n.t("status.OK");
  if (/status|state/i.test(key)) return presentation.status(value).label;
  if (key === "role") return presentation.role(value);
  if (/technology|type/i.test(key)) return presentation.connectionType(value);
  if (/created_at|updated_at|last_seen|release_at/i.test(key)) return presentation.formatDate(value, true);
  if (typeof value === "object") return i18n.t("admin.details");
  return String(value);
}

function adminRecordId(item) { return item?.id ?? item?.version ?? item?.line_id ?? item?.device_id ?? ""; }

function adminResourceOptions() {
  return adminResourceDefinitions().filter((resource) => state.capabilities.has(resource.capability));
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
  const options = allowedResources.map((resource) => '<option value="' + escapeHtml(resource.key) + '"' + (resource.key === view.resource ? " selected" : "") + ">' + escapeHtml(adminResourceLabel(resource.key)) + "</option>").join("");
  const header = '<header class="surface-header"><div><h1>' + escapeHtml(i18n.t("admin.title")) + '</h1><p>' + escapeHtml(i18n.t("admin.subtitle")) + '</p></div><button type="button" class="secondary-action" data-admin-refresh>' + escapeHtml(i18n.t("admin.refresh")) + "</button></header>";
  if (view.state === "loading" || view.state === "idle") {
    root.innerHTML = '<div class="secondary-shell">' + header + '<p class="surface-state" role="status">' + escapeHtml(i18n.t("admin.loading")) + "</p></div>";
    root.querySelector("[data-admin-refresh]")?.addEventListener("click", () => loadAdminResource({ force: true }));
    return;
  }
  const rows = view.items.map((item) => {
    const entries = Object.entries(item || {}).filter(([, value]) => value !== null && typeof value !== "object").slice(0, 6);
    const id = adminRecordId(item);
    const cells = entries.map(([key, value]) => '<div><dt>' + escapeHtml(adminFieldLabel(key)) + '</dt><dd>' + escapeHtml(adminDisplayValue(key, value)) + "</dd></div>").join("");
    const edit = view.resource === "schedule" ? "" : '<button type="button" class="link-action" data-admin-edit="' + escapeHtml(String(id)) + '">' + escapeHtml(i18n.t("admin.update")) + "</button>";
    const deviceActions = view.resource === "devices" && id ? '<div class="admin-device-actions"><button type="button" class="link-action" data-admin-device-action="block" data-admin-device-id="' + escapeHtml(String(id)) + '">' + escapeHtml(i18n.t("admin.block")) + '</button><button type="button" class="link-action" data-admin-device-action="unblock" data-admin-device-id="' + escapeHtml(String(id)) + '">' + escapeHtml(i18n.t("admin.unblock")) + '</button><button type="button" class="link-action" data-admin-device-action="rotate-token" data-admin-device-id="' + escapeHtml(String(id)) + '">' + escapeHtml(i18n.t("admin.rotateToken")) + "</button></div>" : "";
    return '<article class="admin-record"><dl class="detail-grid">' + cells + '</dl>' + edit + deviceActions + '<details><summary>' + escapeHtml(i18n.t("admin.details")) + '</summary><pre>' + escapeHtml(JSON.stringify(item, null, 2)) + "</pre></details></article>";
  }).join("");
  const payloadLabel = view.resource === "devices" && !view.selectedId ? i18n.t("admin.registerDevice") : view.selectedId ? i18n.t("admin.update") : i18n.t("admin.create");
  const message = view.message ? '<p class="surface-state' + (view.mutationState === "error" ? " error" : "") + '" role="status">' + escapeHtml(i18n.t(view.message)) + "</p>" : "";
  root.innerHTML = '<div class="secondary-shell">' + header + '<div class="admin-toolbar"><label>' + escapeHtml(i18n.t("admin.resource")) + '<select data-admin-resource>' + options + '</select></label><span>' + escapeHtml(i18n.t("admin.resourceCapability")) + "</span></div>" + (rows || '<p class="surface-state">' + escapeHtml(i18n.t("admin.empty")) + '</p>') + '<form class="admin-editor" data-admin-editor><h2>' + escapeHtml(payloadLabel) + '</h2><label>' + escapeHtml(i18n.t("admin.recordId")) + '<input name="recordId" value="' + escapeHtml(view.selectedId) + '" placeholder="' + escapeHtml(i18n.t("empty.value")) + '"></label><label>' + escapeHtml(i18n.t("admin.payload")) + '<textarea name="payload" required spellcheck="false">' + escapeHtml(view.payload) + '</textarea></label><p class="form-hint">' + escapeHtml(i18n.t("admin.payloadHint")) + '</p><button type="submit" class="primary-action"' + (view.mutationState === "saving" ? " disabled" : "") + '>' + escapeHtml(payloadLabel) + '</button><button type="button" class="secondary-action" data-admin-impact>' + escapeHtml(i18n.t("admin.impactPreview")) + '</button><button type="button" class="secondary-action" data-admin-agent-update>' + escapeHtml(i18n.t("admin.agentUpdate")) + '</button></form>' + message + (view.preview ? '<div class="admin-preview"><h2>' + escapeHtml(i18n.t("admin.impactPreview")) + '</h2><p>' + escapeHtml(i18n.t("admin.previewReady")) + '</p><pre>' + escapeHtml(JSON.stringify(view.preview, null, 2)) + '</pre></div>' : "") + '</div>';
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
    state.admin.selectedId = String(adminRecordId(item));
    state.admin.payload = JSON.stringify(item, null, 2);
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
    const payload = JSON.parse(root.querySelector("[name=payload]")?.value || "{}");
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
  const parsed = parseAdminPayload(event.currentTarget);
  if (!parsed) return;
  const { id, payload } = parsed;
  const resource = state.admin.resource;
  if (isDestructiveAdminPayload(resource, payload) && !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  if (!isDestructiveAdminPayload(resource, payload) && !globalThis.confirm?.(i18n.t("admin.confirmSave"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminSurface();
  try {
    const result = resource === "devices" && !id ? await boundaries.admin.registerDevice(payload) : await boundaries.admin.save(resource, id, payload);
    state.admin.selectedId = String(adminRecordId(result) || id || "");
    state.admin.payload = JSON.stringify(result || payload, null, 2);
    state.admin.mutationState = "success";
    state.admin.message = "admin.mutationSucceeded";
    await loadAdminResource({ force: true });
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.mutationFailed";
    renderAdminSurface();
  }
}

async function adminDeviceAction(id, action) {
  if (!id || !state.capabilities.has("admin.devices")) return;
  if (!globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  state.admin.mutationState = "saving";
  state.admin.message = "";
  renderAdminSurface();
  try {
    const result = await boundaries.admin.deviceAction(id, action);
    state.admin.payload = JSON.stringify(result || {}, null, 2);
    state.admin.mutationState = "success";
    state.admin.message = "admin.mutationSucceeded";
    await loadAdminResource({ force: true });
  } catch (error) {
    state.admin.mutationState = "error";
    state.admin.message = "admin.actionFailed";
    renderAdminSurface();
  }
}

async function runAdminImpactPreview() {
  const parsed = parseAdminPayload($("#adminSurface"));
  if (!parsed) return;
  try {
    state.admin.preview = await boundaries.admin.impactPreview(parsed.payload);
    state.admin.message = "";
  } catch (error) {
    state.admin.preview = null;
    state.admin.message = "admin.actionFailed";
    state.admin.mutationState = "error";
  }
  renderAdminSurface();
}

async function runAdminAgentUpdate() {
  const parsed = parseAdminPayload($("#adminSurface"));
  if (!parsed || !globalThis.confirm?.(i18n.t("admin.confirmDestructive"))) return;
  try {
    state.admin.payload = JSON.stringify(await boundaries.admin.agentUpdate(parsed.payload), null, 2);
    state.admin.message = "admin.mutationSucceeded";
    state.admin.mutationState = "success";
  } catch (error) {
    state.admin.message = "admin.actionFailed";
    state.admin.mutationState = "error";
  }
  renderAdminSurface();
}

function auditObjectLabel(value) {
  const key = String(value || "").toLowerCase();
  if (key.includes("incident")) return i18n.t("nav.incidents");
  if (key.includes("notification")) return i18n.t("notification.title");
  if (key.includes("line")) return i18n.t("field.line");
  if (key.includes("user")) return i18n.t("admin.resources.users");
  return value || i18n.t("empty.noData");
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
    const objectOptions = [...new Set(view.items.map((item) => item?.object_type).filter(Boolean))].map((value) => '<option value="' + escapeHtml(value) + '"' + (view.filters.object_type === value ? " selected" : "") + '>' + escapeHtml(auditObjectLabel(value)) + "</option>").join("");
    const rows = view.items.map((item) => { const entry = presentAuditItem(item, { i18n, presentation }); return '<article class="audit-record"><div class="audit-record-head"><strong>' + escapeHtml(entry.actionLabel) + '</strong><span>' + escapeHtml(entry.atLabel) + '</span></div><dl class="detail-grid"><div><dt>' + escapeHtml(i18n.t("audit.object")) + '</dt><dd>' + escapeHtml(auditObjectLabel(entry.objectLabel)) + '</dd></div><div><dt>' + escapeHtml(i18n.t("audit.actor")) + '</dt><dd>' + escapeHtml(entry.actorLabel) + '</dd></div></dl>' + (entry.rawAction || entry.payload ? '<details><summary>' + escapeHtml(i18n.t("audit.technical")) + '</summary><pre>' + escapeHtml(JSON.stringify({ action: entry.rawAction, object_id: entry.rawObject, payload: entry.payload }, null, 2)) + '</pre></details>' : "") + '</article>'; }).join("");
    const content = view.state === "loading" ? '<p class="surface-state" role="status">' + escapeHtml(i18n.t("audit.loading")) + '</p>' : view.state === "error" ? '<p class="surface-state error" role="alert">' + escapeHtml(i18n.t("audit.unavailable")) + '</p>' : rows || '<p class="surface-state">' + escapeHtml(i18n.t("audit.empty")) + '</p>';
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
  return '<header class="incident-detail-head"><span class="severity-' + escapeHtml(incident.severity.toLowerCase()) + '">' + escapeHtml(incident.severityLabel) + "</span><h2>" + escapeHtml(incident.number) + "</h2><p>" + escapeHtml(incident.statusLabel) + "</p></header><section><h3>" + escapeHtml(i18n.t("incidents.what")) + "</h3><p>" + escapeHtml(incident.typeLabel) + "</p></section><dl class="detail-grid"><div><dt>" + escapeHtml(i18n.t("incidents.where")) + "</dt><dd>" + escapeHtml(incident.school) + " · " + escapeHtml(incident.line) + "</dd></div><div><dt>" + escapeHtml(i18n.t("incidents.when")) + "</dt><dd>" + escapeHtml(incident.startedLabel) + " · " + escapeHtml(incident.durationLabel) + "</dd></div><div><dt>" + escapeHtml(i18n.t("incidents.confirmed")) + "</dt><dd>" + escapeHtml(confirmed) + "</dd></div><div><dt>" + escapeHtml(i18n.t("incidents.recovery")) + "</dt><dd>" + escapeHtml(recovery.label) + "</dd></div>" + (detail.assignee ? "<div><dt>" + escapeHtml(i18n.t("field.assignee")) + "</dt><dd>" + escapeHtml(detail.assignee) + "</dd></div>" : "") + "</dl>" + (lineAvailable ? '<button class="secondary-action" type="button" data-incident-open-line="' + escapeHtml(detail.line_id) + '">' + escapeHtml(i18n.t("incidents.openLine")) + "</button>" : "") + '<section><h3>' + escapeHtml(i18n.t("incidents.workflow")) + "</h3><ol class=\"incident-timeline\">" + timeline + "</ol>" + commentForm + "</section>" + renderProviderCaseContext(detail) + renderSituationContext(detail.id);
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
  const create = !cases.length && canPrepare
    ? '<button class="secondary-action" type="button" data-provider-case-prepare' + (providerView.actionState === "creating" ? " disabled" : "") + ">" + escapeHtml(i18n.t("providerCase.prepare")) + "</button>"
    : !cases.length ? '<p class="detail-muted">' + escapeHtml(i18n.t("providerCase.unavailable")) + "</p>" : "";
  const actionError = providerView.actionError ? '<p class="provider-case-error" role="alert">' + escapeHtml(providerView.actionError) + "</p>" : "";
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
  const generate = actions.canGenerate ? '<button class="secondary-action" type="button" data-provider-case-generate' + (providerView.actionState === "generating" ? " disabled" : "") + ">" + escapeHtml(i18n.t("providerCase.prepareAutomatic")) + "</button>" : "";
  const send = actions.canSend && item.text ? '<form class="provider-case-send" data-provider-case-send><label><input type="checkbox" data-provider-case-reviewed required /> ' + escapeHtml(i18n.t("providerCase.reviewed")) + '</label><button class="primary-action" type="submit" data-provider-case-submit disabled>' + escapeHtml(i18n.t(actions.isRetry ? "providerCase.retry" : "providerCase.send")) + "</button></form>" : "";
  const delivery = item.deliveryError ? '<details class="provider-case-delivery"><summary>' + escapeHtml(i18n.t("providerCase.deliveryFailed")) + "</summary><p>" + escapeHtml(i18n.t("providerCase.deliveryAttempts", { count: item.deliveryAttempts })) + (item.nextAttemptLabel !== i18n.t("empty.value") ? " · " + escapeHtml(i18n.t("providerCase.nextAttempt", { at: item.nextAttemptLabel })) : "") + "</p><p>" + escapeHtml(item.deliveryError) + "</p></details>" : "";
  return '<article class="provider-case-detail"><h4>' + escapeHtml(i18n.t("providerCase.title", { reference: item.reference })) + "</h4>" + metadata + automatic + draft + '<div class="provider-case-actions">' + generate + "</div>" + send + delivery + "</article>";
}

function renderSituationContext(incidentId) {
  const view = incidentSurfaceState();
  if (view.situationsState === "loading" || view.situationsState === "idle") return '<section><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3><p class=\"detail-muted\">" + escapeHtml(i18n.t("situation.loading")) + "</p></section>";
  if (view.situationsState === "error") return '<section><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3><p class=\"detail-muted\">" + escapeHtml(i18n.t("situation.unavailable")) + "</p></section>";
  const situations = relatedSituations(view.situations, incidentId);
  const rows = situations.length ? situations.map((item) => {
    const situation = presentSituation(item, { i18n, presentation });
    return '<li><button class="link-action" type="button" data-situation-id="' + escapeHtml(situation.id) + '"><strong>' + escapeHtml(situation.title) + "</strong><span>" + escapeHtml(i18n.t("situation.members", { count: situation.affectedCount })) + " · " + escapeHtml(situation.typeLabel) + "</span></button></li>";
  }).join("") : '<p class="detail-muted">' + escapeHtml(i18n.t("situation.empty")) + "</p>";
  return '<section class="situation-context"><h3>' + escapeHtml(i18n.t("situation.contextTitle")) + "</h3><p class=\"detail-muted\">" + escapeHtml(i18n.t("situation.contextHint")) + "</p><ul>" + rows + "</ul></section>";
}

function renderSituationDetail() {
  const view = incidentSurfaceState();
  if (view.situationState === "loading") return '<p class="surface-state">' + escapeHtml(i18n.t("situation.loading")) + "</p>";
  if (view.situationState === "error" || !view.situation) return '<p class="surface-state error">' + escapeHtml(i18n.t("situation.unavailable")) + "</p>";
  const situation = view.situation;
  const factors = situation.factors || {};
  const members = Array.isArray(situation.incidents) ? situation.incidents : [];
  const evidence = situation.evidence?.state || "UNKNOWN";
  return '<button class="link-action back-action" type="button" data-situation-back>' + escapeHtml(i18n.t("situation.backToIncident")) + '</button><header class="incident-detail-head"><h2>' + escapeHtml(i18n.t("situation.detailTitle")) + " #" + escapeHtml(situation.id) + "</h2><p>" + escapeHtml(i18n.t("situation.readOnly")) + '</p></header><section><h3>' + escapeHtml(i18n.t("situation.factors")) + "</h3><dl class=\"detail-grid\"><div><dt>" + escapeHtml(i18n.t("field.district")) + "</dt><dd>" + escapeHtml(factors.district || i18n.t("empty.noData")) + "</dd></div><div><dt>" + escapeHtml(i18n.t("field.type")) + "</dt><dd>" + escapeHtml(i18n.has("incidentType." + String(factors.violation_type || "").toUpperCase()) ? i18n.t("incidentType." + String(factors.violation_type).toUpperCase()) : i18n.t("incidentType.UNKNOWN")) + "</dd></div></dl></section><section><h3>" + escapeHtml(i18n.t("situation.evidence")) + "</h3><p>" + escapeHtml(i18n.has("situation.evidence." + evidence) ? i18n.t("situation.evidence." + evidence) : i18n.t("situation.evidence.UNKNOWN")) + "</p></section><section><h3>" + escapeHtml(i18n.t("situation.memberIncidents")) + "</h3><ul class=\"situation-members\">" + members.map((item) => '<li><button class="link-action" type="button" data-incident-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.incident_no || item.number || item.id) + " · " + escapeHtml(item.school_name || item.organization_name || i18n.t("school.noOfficialName")) + "</button></li>").join("") + "</ul></section>";
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
  root.querySelector("[data-provider-case-prepare]")?.addEventListener("click", createIncidentProviderCase);
  root.querySelector("[data-provider-case-generate]")?.addEventListener("click", generateProviderCaseDraft);
  root.querySelector("[data-provider-case-reviewed]")?.addEventListener("change", (event) => {
    const submit = root.querySelector("[data-provider-case-submit]");
    if (submit) submit.disabled = !event.currentTarget.checked;
  });
  root.querySelector("[data-provider-case-send]")?.addEventListener("submit", sendProviderCase);
  root.querySelector("[data-situation-back]")?.addEventListener("click", () => { incidentSurfaceState().selectedSituationId = null; incidentSurfaceState().situation = null; incidentSurfaceState().situationState = "idle"; renderIncidentsSurface(); });
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
  view.selectedSituationId = null;
  view.situation = null;
  view.situationState = "idle";
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
  if (!view.selectedId || !view.detail || !providerCaseActions(null, state.capabilities).canPrepare) return;
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
    view.providerCase.actionError = i18n.t("providerCase.prepareFailed");
    renderIncidentsSurface();
  }
}

async function generateProviderCaseDraft() {
  const view = incidentSurfaceState();
  const detail = view.providerCase.detail;
  if (!detail || !providerCaseActions(detail, state.capabilities).canGenerate) return;
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
    view.providerCase.actionError = i18n.t("providerCase.automaticFailed");
  }
  renderIncidentsSurface();
}

async function sendProviderCase(event) {
  event.preventDefault();
  const view = incidentSurfaceState();
  const detail = view.providerCase.detail;
  const finalText = event.currentTarget.closest(".provider-case-detail")?.querySelector("[data-provider-case-text]")?.value.trim();
  const reviewed = event.currentTarget.querySelector("[data-provider-case-reviewed]")?.checked === true;
  if (!detail || !reviewed || !finalText || !providerCaseActions(detail, state.capabilities).canSend) return;
  if (!globalThis.confirm?.(i18n.t("providerCase.confirmSend"))) return;
  view.providerCase.actionState = "sending";
  view.providerCase.actionError = "";
  renderIncidentsSurface();
  try {
    const sent = objectPayload(await boundaries.providerCases.send(detail.id, { incident_id: view.selectedId, final_text: finalText, reviewed: true }));
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.detail = { ...detail, ...sent };
    view.providerCase.actionState = "idle";
    await loadIncidentDetail(view.selectedId);
    await selectProviderCase(detail.id);
  } catch (error) {
    if (String(view.providerCase.selectedId) !== String(detail.id)) return;
    view.providerCase.actionState = "idle";
    view.providerCase.actionError = i18n.t("providerCase.sendFailed");
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
    view.detail = response;
    const index = view.items.findIndex((item) => String(item.id) === String(view.selectedId));
    if (index >= 0) view.items[index] = response;
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

function closeDrawer() {
  $("#detailDrawer")?.classList.remove("open");
  if ($("#detailDrawer")) $("#detailDrawer").hidden = true;
  if ($("#drawerBackdrop")) $("#drawerBackdrop").hidden = true;
  if ($("#detailDrawer")) $("#detailDrawer").setAttribute("aria-hidden", "true");
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
  $("#notificationsButton")?.addEventListener("click", toggleNotifications);
  $("#refreshButton")?.addEventListener("click", refreshMap);
  $("#mapFilter")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const firstResult = map.searchResults()[0];
    if (firstResult) selectSearchResult(firstResult.school.registryId);
  });
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
  $("#districtFilter")?.addEventListener("change", applyMapFilters);
  $("#providerFilter")?.addEventListener("change", applyMapFilters);
  $("#statusFilter")?.addEventListener("change", applyMapFilters);
  $("#schoolSearch")?.addEventListener("input", (event) => { map.setFilters({ query: event.target.value }); renderMapStatus(); });
  $("#mapFiltersReset")?.addEventListener("click", () => { map.resetFilters(); renderMapStatus(); });
  $("#mapPopupClose")?.addEventListener("click", () => closeMapPopup());
  $("#mapPopupOpenLine")?.addEventListener("click", openSelectedSchoolDetail);
  $("#drawerClose")?.addEventListener("click", closeDrawer);
  $("#drawerBackdrop")?.addEventListener("click", closeDrawer);
  $("#mapZoomIn")?.addEventListener("click", () => mapApiAction("zoomIn"));
  $("#mapZoomOut")?.addEventListener("click", () => mapApiAction("zoomOut"));
  $("#mapReset")?.addEventListener("click", () => globalThis.LinkwatchMap?.resetView());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (state.notifications.open) closeNotifications(); else if (!$("#mapPopup")?.hidden) closeMapPopup(); else if (!$("#detailDrawer")?.hidden) closeDrawer(); } });
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

globalThis.LinkwatchApp = { i18n, presentation, theme, router, state, boundaries, refreshMap, openLine, openIncident, openMapPopup };
document.addEventListener("DOMContentLoaded", boot);
