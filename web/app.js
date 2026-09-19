/* LINKWATCH — small dependency-free ops surface. Verdicts come from the API; this file only presents them. */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", () => {
    const format = document.querySelector("#exportFormat");
    if (format && !format.querySelector("option[value='json']")) {
      const option = document.createElement("option"); option.value = "json"; option.textContent = "JSON"; format.appendChild(option);
    }
  });

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const state = {
    token: localStorage.getItem("vko_token") || "",
    user: null,
    lines: [],
    incidents: [],
    notifications: [],
    notificationBeforeId: null,
    notificationLoading: false,
    notificationError: null,
    situations: [],
    audit: [],
    auditBeforeId: null,
    auditHasMore: false,
    auditFilters: { action: "", object_type: "", object_id: "" },
    agentVersions: [],
    historicalByLine: {},
    historicalLoading: false,
    historicalError: null,
    historicalRequest: 0,
    mapPopupLineID: null,
    mapPopupTrigger: null,
    filters: { search: "", district: "", provider: "", technology: "", status: "", period: "week", from: "", to: "", view: "lines", mapMode: "current" },
    currentLine: null,
    currentIncident: null,
    currentCaseId: null,
    apiOnline: false,
    usingDemoData: false,
    registryUnavailable: true,
    registryLoading: false,
    registryError: null,
    mappingUnavailable: true,
    mapDataPromise: null,
    frontendModel: null,
    // Demo data is opt-in per URL, never persisted across environments.
    demoMode: new URLSearchParams(window.location.search).get("demo") === "1",
    lineLimit: 30,
    adminResource: "organizations",
    adminItems: [],
    adminEditing: null,
    adminContractLineID: "",
    export: { kind: "raw", format: "csv", columns: [], schools: [], devices: [] },
  };

  const sampleLines = [
    { id: "L-001", school_id: "S-042", school_name: "Средняя школа №42", district: "Уланский район", provider: "Altel Telecom", technology: "ВОЛС", role: "Основная", status: "DEGRADED", quality_state: "OK", contract_state: "DEVIATES", data_state: "FRESH", latest: { download: 43, upload: 39, ping: 48, jitter: 12, loss: 0.8, at: "2026-09-16T13:00:00Z" }, contract: { download: 100, upload: 100 }, coordinates: [365, 151], reason: "Download ниже договорного ориентира 100 Мбит/с; подтверждено 3 наблюдениями" },
    { id: "L-002", school_id: "S-017", school_name: "Школа-лицей №17", district: "Глубоковский район", provider: "Kazakhtelecom", technology: "ВОЛС", role: "Основная", status: "OK", quality_state: "OK", contract_state: "MEETS", data_state: "FRESH", latest: { download: 96, upload: 94, ping: 32, jitter: 8, loss: 0.2, at: "2026-09-16T14:08:00Z" }, contract: { download: 100, upload: 100 }, coordinates: [221, 242], reason: "Последние 6 наблюдений в пределах базовой и договорной нормы" },
    { id: "L-003", school_id: "S-008", school_name: "Школа имени Абая", district: "Алтайский район", provider: "Beeline", technology: "LTE", role: "Основная", status: "NO_INTERNET", quality_state: "NO_INTERNET", contract_state: "UNKNOWN", data_state: "FRESH", latest: { download: 0, upload: 0, ping: null, jitter: null, loss: 100, at: "2026-09-16T14:05:00Z" }, contract: { download: 50, upload: 20 }, coordinates: [145, 132], reason: "Нет внешней доступности; точка мониторинга отвечает" },
    { id: "L-004", school_id: "S-031", school_name: "Школа №31", district: "Зайсанский район", provider: "Starlink", technology: "Спутник", role: "Резервная", status: "NO_DATA", quality_state: "UNKNOWN", contract_state: "UNKNOWN", data_state: "NO_DATA", latest: { download: null, upload: null, ping: null, jitter: null, loss: null, at: "2026-09-15T17:20:00Z" }, contract: { download: 40, upload: 10 }, coordinates: [485, 155], reason: "Нет свежих наблюдений 21 минуту. Это не подтверждает отсутствие интернета" },
    { id: "L-005", school_id: "S-066", school_name: "Средняя школа №66", district: "Тарбагатайский район", provider: "Kazakhtelecom", technology: "ВОЛС", role: "Основная", status: "OK", quality_state: "OK", contract_state: "MEETS", data_state: "FRESH", latest: { download: 102, upload: 99, ping: 38, jitter: 9, loss: 0.1, at: "2026-09-16T14:12:00Z" }, contract: { download: 100, upload: 100 }, coordinates: [435, 267], reason: "Все ключевые показатели в пределах нормы" },
    { id: "L-006", school_id: "S-024", school_name: "Школа №24", district: "Усть-Каменогорск", provider: "Altel Telecom", technology: "4G", role: "Основная", status: "UNSTABLE", quality_state: "DEGRADED", contract_state: "MEETS", data_state: "FRESH", latest: { download: 26, upload: 22, ping: 96, jitter: 27, loss: 1.9, at: "2026-09-16T13:54:00Z" }, contract: { download: 25, upload: 20 }, coordinates: [334, 211], reason: "Пограничные значения jitter и packet loss; наблюдение продолжается" },
    { id: "L-007", school_id: "S-074", school_name: "Городская школа №74", district: "Усть-Каменогорск", provider: "Beeline", technology: "LTE", role: "Основная", status: "OK", quality_state: "OK", contract_state: "MEETS", data_state: "FRESH", latest: { download: 54, upload: 24, ping: 61, jitter: 14, loss: 0.4, at: "2026-09-16T14:03:00Z" }, contract: { download: 50, upload: 20 }, coordinates: [368, 190], reason: "Последние наблюдения стабильны" },
    { id: "L-008", school_id: "S-091", school_name: "Школа №91", district: "Курчумский район", provider: "Starlink", technology: "Спутник", role: "Основная", status: "OK", quality_state: "OK", contract_state: "DEVIATES", data_state: "FRESH", latest: { download: 32, upload: 9, ping: 82, jitter: 24, loss: 1.2, at: "2026-09-16T13:47:00Z" }, contract: { download: 50, upload: 20 }, coordinates: [537, 224], reason: "Работоспособно по базовой норме, но Upload ниже договорного ориентира" },
  ];
  const sampleIncidents = [
    { id: "INC-184", number: "INC-184", line_id: "L-003", school_name: "Школа имени Абая", district: "Алтайский район", provider: "Beeline", status: "IN_PROGRESS", severity: "CRITICAL", title: "Подтверждённое отсутствие соединения", description: "Точка мониторинга отвечает, но внешняя доступность отсутствует.", started_at: "2026-09-16T11:17:00Z", duration_minutes: 12, source: "AUTO", actions: [{ at: "2026-09-16T11:17:00Z", text: "Нарушение подтверждено 3 наблюдениями" }, { at: "2026-09-16T11:29:00Z", text: "Инцидент создан автоматически" }] },
    { id: "INC-181", number: "INC-181", line_id: "L-001", school_name: "Средняя школа №42", district: "Уланский район", provider: "Altel Telecom", status: "NEW", severity: "ATTENTION", title: "Устойчивое отклонение Download", description: "Фактический Download 39–43 Мбит/с при договорном ориентире 100 Мбит/с.", started_at: "2026-09-16T13:00:00Z", duration_minutes: 78, source: "AUTO", actions: [{ at: "2026-09-16T13:00:00Z", text: "Отклонение подтверждено последовательностью наблюдений" }] },
    { id: "INC-172", number: "INC-172", line_id: "L-008", school_name: "Школа №91", district: "Курчумский район", provider: "Starlink", status: "CLOSED", severity: "ATTENTION", title: "Повторное отклонение Upload", description: "Инцидент закрыт после устойчивого восстановления.", started_at: "2026-09-08T08:20:00Z", duration_minutes: 224, source: "AUTO", actions: [{ at: "2026-09-08T08:20:00Z", text: "Нарушение подтверждено" }, { at: "2026-09-08T12:04:00Z", text: "Восстановление подтверждено мониторингом" }] },
  ];
  const sampleSituations = [
    { id: "SIT-027", title: "Массовая потеря доступности", meta: "Beeline · Алтайский район · 3 линии", severity: "CRITICAL", started_at: "2026-09-16T11:17:00Z", reason: "Один провайдер + интервал начала 12 минут + отсутствие внешней доступности" },
    { id: "SIT-026", title: "Снижение производительности", meta: "Altel Telecom · Уланский район · 4 линии", severity: "ATTENTION", started_at: "2026-09-16T13:00:00Z", reason: "Один провайдер + близкое время начала + Download ниже договорного ориентира" },
  ];

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }
  function number(value, suffix = "") { return value == null || Number.isNaN(Number(value)) ? "—" : `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}${suffix}`; }
  function overviewMetric(value, suffix = "") { return value == null || Number.isNaN(Number(value)) ? "Нет данных" : number(value, suffix); }
  function popupMetric(value, suffix = "") { return value == null || Number.isNaN(Number(value)) ? "Нет данных" : number(value, suffix); }
  function time(value, withDate = false) { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.getTime())) return escapeHtml(value); return date.toLocaleString("ru-RU", { day: withDate ? "2-digit" : undefined, month: withDate ? "short" : undefined, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" }); }
  function relative(value) { if (!value) return "нет данных"; const diff = Math.max(0, Date.now() - new Date(value).getTime()); const mins = Math.round(diff / 60000); if (mins < 2) return "только что"; if (mins < 60) return `${mins} мин назад`; const hours = Math.round(mins / 60); return `${hours} ч назад`; }
  function statusClass(status) { const s = String(status || "").toUpperCase(); if (["NO_INTERNET", "CRITICAL", "DOWN", "OUTAGE"].includes(s)) return "critical"; if (["DEGRADED", "UNSTABLE", "ATTENTION", "DEVIATES"].includes(s)) return "unstable"; if (["NO_DATA", "UNKNOWN", "STALE"].includes(s)) return "no-data"; return "healthy"; }
  function statusLabel(status) { return ({ OK: "Норма", HEALTHY: "Норма", DEGRADED: "Нестабильно", UNSTABLE: "Нестабильно", CRITICAL: "Критично", NO_INTERNET: "Нет соединения", NO_DATA: "Нет актуальных данных", UNKNOWN: "Недостаточно данных" }[String(status || "").toUpperCase()] || status || "Неизвестно"); }
  function axisLabel(value) { return ({ OK: "В норме", MEETS: "Соответствует", DEVIATES: "Отклонение", DEGRADED: "Нестабильно", NO_INTERNET: "Нет соединения", UNKNOWN: "Нет вывода" }[String(value || "").toUpperCase()] || value || "Нет вывода"); }
  function normalizeLine(raw) {
    const school = raw.school || raw.organization || {};
    const provider = raw.provider || {};
    const latest = raw.latest || raw.latest_measurement || raw.last_measurement || {};
    const lineState = raw.state || raw.line_state || {};
    const longitude = Number(raw.longitude); const latitude = Number(raw.latitude);
    const coords = raw.coordinates || (Number.isFinite(longitude) && Number.isFinite(latitude) ? [140 + (longitude - 80) * 120, 330 - (latitude - 49) * 180] : [raw.map_x || 260, raw.map_y || 170]);
    const dataState = raw.data_state || lineState.data_state || "FRESH";
    const connectionState = dataState === "NO_DATA" ? "NO_DATA" : (lineState.connection_state || raw.connection_state || (raw.status && !["ACTIVE", "INACTIVE", "RESERVE", "PRIMARY"].includes(String(raw.status).toUpperCase()) ? raw.status : null) || "UNKNOWN");
    const role = raw.role_label || raw.line_role || ({ PRIMARY: "Основная", RESERVE: "Резервная", INACTIVE: "Неактивная" }[String(raw.role || "").toUpperCase()] || raw.role || "Основная");
    return { ...raw, id: raw.id || raw.line_id || `L-${raw.pk}`, organization_id: raw.organization_id || school.organization_id || school.id || "—", school_id: raw.school_id || school.id || "—", school_name: raw.school_name || school.name || raw.organization_name || "Без названия", district: raw.district || school.district || "—", provider_id: raw.provider_id || provider.id || "—", provider: typeof provider === "string" ? provider : raw.provider_name || provider.name || "—", technology: raw.technology || raw.connection_type || "—", role, status: connectionState, line_status: raw.line_status || raw.status || "ACTIVE", quality_state: raw.quality_state || lineState.connection_state || raw.connection_state || connectionState, contract_state: raw.contract_state || lineState.contract_state || "UNKNOWN", data_state: dataState, latest: { download: latest.download ?? latest.download_mbps, upload: latest.upload ?? latest.upload_mbps, ping: latest.ping ?? latest.ping_ms, jitter: latest.jitter ?? latest.jitter_ms, loss: latest.loss ?? latest.packet_loss ?? latest.packet_loss_pct, at: latest.at || latest.observed_at || latest.timestamp }, contract: raw.contract || raw.contract_version || { download: raw.contract_download ?? raw.promised_download, upload: raw.contract_upload ?? raw.promised_upload }, coordinates: coords, reason: raw.reason || lineState.reason || "Состояние рассчитано по последним наблюдениям" };
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 && !options._retried) {
      state.token = "";
      localStorage.removeItem("vko_token");
      await login(true);
      return api(path, { ...options, _retried: true });
    }
    if (response.status === 403 && !options._capabilityRetried && state.token) {
      await loadUserProfile();
      return api(path, { ...options, _capabilityRetried: true });
    }
    if (!response.ok) { const text = await response.text(); const error = new Error(text || `${response.status}`); error.status = response.status; throw error; }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") || "";
    return type.includes("json") ? response.json() : response;
  }
  async function apiTry(paths, options = {}) {
    let lastError;
    for (const path of paths) { try { return await api(path, options); } catch (error) { lastError = error; if (![404, 405].includes(error.status)) break; } }
    throw lastError || new Error("API недоступен");
  }
  function unwrap(value, keys = ["items", "data", "results"]) { if (Array.isArray(value)) return value; for (const key of keys) if (value && Array.isArray(value[key])) return value[key]; return []; }

  function showLogin(message = "Введите рабочие учётные данные.") {
    const backdrop = $("#authBackdrop"); if (!backdrop) return;
    $("#authMessage").textContent = message;
    backdrop.classList.remove("hidden");
    ($("#loginUsername").value ? $("#loginPassword") : $("#loginUsername")).focus();
  }
  function hideLogin() { const backdrop = $("#authBackdrop"); if (backdrop) backdrop.classList.add("hidden"); }
  async function login(silent = false, suppliedCredentials = null) {
    const credentials = suppliedCredentials && { username: suppliedCredentials.username, password: suppliedCredentials.password };
    if (!credentials || !credentials.username || !credentials.password) {
      state.apiOnline = false;
      state.usingDemoData = state.demoMode;
      if (!state.demoMode || suppliedCredentials) showLogin("Введите рабочие учётные данные.");
      if (!silent && !state.demoMode) toast("Войдите, чтобы открыть операционные данные", "warn");
      return false;
    }
    try {
      const response = await apiTry(["/api/login", "/api/auth/login", "/api/v1/auth/login", "/api/v1/login"], { method: "POST", body: JSON.stringify(credentials), _retried: true });
      const token = response.token || response.access_token || response.session;
      if (!token) throw new Error("auth response did not contain a session token");
      state.token = token;
      state.user = response.user || { name: credentials.username, role_label: "Пользователь", role: "USER" };
      localStorage.setItem("vko_token", state.token);
      state.apiOnline = true;
      state.usingDemoData = false;
      hideLogin();
      updateUser();
      await loadUserProfile();
      return true;
    } catch (error) {
      state.usingDemoData = state.demoMode;
      state.apiOnline = false;
      if (!state.demoMode) showLogin(error && error.status === 401 ? "Не удалось войти. Проверьте имя пользователя и пароль." : "Сервис авторизации пока недоступен.");
      if (!silent) toast(state.demoMode ? "Сервер недоступен — показываем явно выбранный демонстрационный срез" : "Сервер недоступен — операционные данные не загружены", "warn");
      return false;
    }
  }
  function updateUser() { if (!state.user) return; $("#userName").textContent = state.user.name || state.user.full_name || state.user.username || "Айдана К."; $("#userRole").textContent = state.user.role_label || state.user.role || "Областной уровень"; applyCapabilities(); }
  function demoCapabilities() { return state.usingDemoData && !state.user; }
  function hasCapability(name) { return demoCapabilities() || (Array.isArray(state.user?.capabilities) && state.user.capabilities.includes(name)); }
  function canAdmin() { return hasCapability("admin.manage"); }
  function canSendProvider() { return hasCapability("provider_case.send"); }
  function applyCapabilities() {
    const admin = $("[data-view='admin']"); if (admin) admin.hidden = !canAdmin();
    const notifications = $("[data-view='notifications']"); if (notifications) notifications.hidden = !hasCapability("notification.read");
    const replay = $("#demoButton"); if (replay) replay.hidden = !canAdmin();
    const audit = $("[data-view='audit']"); if (audit) audit.hidden = !hasCapability("audit.read");
    const manual = $("#manualIncidentButton"); if (manual) manual.hidden = !hasCapability("incident.create");
    $$("[data-provider-action]").forEach((button) => { button.hidden = !canSendProvider(button._line || null); });
  }
  async function loadUserProfile() {
    if (!state.token) return;
    try { const response = await apiTry(["/api/auth/me", "/api/v1/auth/me", "/api/me", "/api/v1/me"]); state.user = response.user || response; updateUser(); } catch (_) { /* login user shape is still enough for the coarse gate */ }
  }

  function mapDataFallback() {
    return { registryPayload: null, mappingPayload: null, registryUnavailable: true, mappingUnavailable: true, registryError: new Error("frontend data model unavailable"), mappingError: null };
  }

  function loadMapData() {
    if (!state.mapDataPromise) {
      state.registryLoading = true;
      const loader = window.LinkwatchDataModel?.createDataLoader();
      state.mapDataPromise = (loader ? loader.load() : Promise.resolve(mapDataFallback()))
        .then((result) => {
          state.registryUnavailable = Boolean(result.registryUnavailable);
          state.mappingUnavailable = Boolean(result.mappingUnavailable);
          state.registryError = result.registryError || null;
          state.registryLoading = false;
          return result;
        })
        .catch((error) => {
          state.registryUnavailable = true;
          state.mappingUnavailable = true;
          state.registryError = error;
          state.registryLoading = false;
          return mapDataFallback();
        });
    }
    return state.mapDataPromise;
  }

  function applyFrontendModel(assetResult) {
    const model = window.LinkwatchDataModel;
    state.frontendModel = model
      ? model.buildFrontendModel({ ...assetResult, lines: state.lines })
      : null;
    if (state.frontendModel) {
      state.registryUnavailable = state.frontendModel.registryUnavailable;
      state.mappingUnavailable = state.frontendModel.mappingUnavailable;
      state.lines = state.frontendModel.linkwatch.lines;
    }
    renderRegistryStatus();
  }

  function renderRegistryStatus() {
    const status = $("#registryDataStatus");
    const registryKpi = $("#kpiRegistrySchools");
    const total = state.frontendModel?.registry?.total;
    if (registryKpi) registryKpi.textContent = total == null ? "—" : number(total);
    if (!status) return;
    if (state.registryLoading) {
      status.textContent = "Реестр ВКО: загрузка…";
      status.dataset.state = "loading";
    } else if (state.registryUnavailable) {
      status.textContent = "Реестр ВКО недоступен · мониторинг линий отображён отдельно";
      status.dataset.state = "unavailable";
    } else if (state.mappingUnavailable) {
      status.textContent = `Реестр ВКО: ${number(total)} школ · связка с мониторингом недоступна`;
      status.dataset.state = "mapping-unavailable";
    } else {
      status.textContent = `Реестр ВКО: ${number(total)} школ · отдельно от мониторинга`;
      status.dataset.state = "available";
    }
  }

  async function loadData() {
    let lines, incidents, situations, overview, audit;
    const mapData = loadMapData();
    try {
      [lines, incidents, situations, overview] = await Promise.all([
        apiTry(["/api/lines", "/api/v1/lines", "/api/organizations/lines"]),
        apiTry(["/api/incidents", "/api/v1/incidents"]),
        apiTry(["/api/situations", "/api/v1/situations"]),
        apiTry(["/api/overview", "/api/v1/overview"]),
      ]);
      // Audit is intentionally optional for scoped users. A 403 here must not
      // discard otherwise valid line/incident data and replace it with demo rows.
      audit = await apiTry(["/api/audit", "/api/v1/audit"]).catch(() => []);
      await loadNotifications(true);
      state.lines = unwrap(lines).map(normalizeLine);
      state.incidents = unwrap(incidents).map((item) => ({ ...item, number: item.number || item.id, school_name: item.school_name || item.school?.name || "—", provider: item.provider_name || item.provider?.name || "—", district: item.district || item.school?.district || "—" }));
      state.situations = unwrap(situations);
      state.audit = unwrap(audit);
      state.usingDemoData = false;
    } catch (error) {
      state.usingDemoData = state.demoMode;
      state.lines = state.demoMode ? sampleLines.map(normalizeLine) : [];
      state.incidents = state.demoMode ? sampleIncidents.slice() : [];
      state.notifications = [];
      state.notificationError = error;
      state.situations = state.demoMode ? sampleSituations.slice() : [];
      renderOverview(state.demoMode ? { schools: 128, active_devices: 117, problem_lines: 9, completeness: 94 } : { counts: { schools: 0, lines: 0, active_devices: 0, problem_lines: 0 }, completeness: 0 });
      $("#noticeTitle").textContent = state.demoMode ? "Демо-срез: сервер мониторинга недоступен" : "Сервер мониторинга недоступен";
      $("#noticeText").textContent = state.demoMode ? "Показаны учебные данные. Не используйте их для операционных решений или официальной выгрузки." : "Текущая картина и официальные выгрузки недоступны. Проверьте соединение и повторите обновление.";
    }
    applyFrontendModel(await mapData);
    renderOverview(overview || {});
    populateFilters();
    applyCapabilities();
    renderAll();
    loadProviderWorkspace();
    $("#lastSync").textContent = time(new Date().toISOString());
  }

  function renderAudit() {
    const root = $("#auditTable"); if (!root) return;
    if (!state.audit.length) { root.innerHTML = `<div class="table-empty">Записей по выбранным фильтрам нет.</div>`; }
    else root.innerHTML = `<table class="admin-table"><thead><tr><th>Время</th><th>Действие</th><th>Объект</th><th>Актор</th><th>Детали</th></tr></thead><tbody>${state.audit.map((item) => `<tr><td>${escapeHtml(time(item.created_at, true))}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(`${item.object_type || "—"} · ${item.object_id || "—"}`)}</td><td>${escapeHtml(item.actor_id || item.actor_type || "—")}</td><td><details><summary>Открыть</summary><pre>${escapeHtml(JSON.stringify({ before: item.before, after: item.after }, null, 2))}</pre></details></td></tr>`).join("")}</tbody></table>`;
    $("#auditSummary").textContent = state.audit.length ? `${state.audit.length} записей${state.auditHasMore ? " · доступны ещё" : ""}` : "Нет записей";
    $("#auditLoadMore").hidden = !state.auditHasMore;
  }
  async function loadAudit(reset = true) {
    if (!hasCapability("audit.read")) return;
    if (reset) { state.audit = []; state.auditBeforeId = null; }
    const params = new URLSearchParams({ limit: "50" });
    Object.entries(state.auditFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    if (!reset && state.auditBeforeId) params.set("before_id", state.auditBeforeId);
    try { const payload = await apiTry([`/api/audit?${params}`, `/api/v1/audit?${params}`]); const items = unwrap(payload); state.audit = reset ? items : state.audit.concat(items); state.auditHasMore = Boolean(payload?.has_more); state.auditBeforeId = payload?.next_before_id || (items.length ? items[items.length - 1].id : null); renderAudit(); } catch (error) { $("#auditTable").innerHTML = `<div class="table-empty">${error.status === 403 ? "Доступ к журналу запрещён текущей ролью." : "Журнал временно недоступен."}</div>`; $("#auditLoadMore").hidden = true; }
  }
  async function loadAgentVersions() {
    if (!hasCapability("audit.read")) return;
    try { const payload = await apiTry(["/api/agent-versions?limit=50", "/api/v1/agent-versions?limit=50"]); state.agentVersions = unwrap(payload); const root = $("#agentVersionsTable"); root.innerHTML = state.agentVersions.length ? `<table class="admin-table"><thead><tr><th>Версия</th><th>Устройств</th><th>Последняя связь</th></tr></thead><tbody>${state.agentVersions.map((item) => `<tr><td><button class="row-action" data-agent-version="${escapeHtml(item.version)}">${escapeHtml(item.version)}</button></td><td>${escapeHtml(item.device_count)}</td><td>${escapeHtml(time(item.last_seen, true))}</td></tr>`).join("")}</tbody></table>` : `<div class="table-empty">Наблюдаемых версий нет.</div>`; $$('[data-agent-version]', root).forEach((button) => button.addEventListener("click", () => loadAgentVersionDevices(button.dataset.agentVersion))); } catch (_) { $("#agentVersionsTable").innerHTML = `<div class="table-empty">Распределение версий недоступно.</div>`; }
  }
  async function loadAgentVersionDevices(version) {
    try { const payload = await apiTry([`/api/agent-versions/${encodeURIComponent(version)}/devices?limit=100`, `/api/v1/agent-versions/${encodeURIComponent(version)}/devices?limit=100`]); const root = $("#agentVersionDevices"); root.hidden = false; const items = unwrap(payload); root.innerHTML = `<div class="panel-kicker">УСТРОЙСТВА · ${escapeHtml(version)}</div>` + (items.length ? `<table class="admin-table"><thead><tr><th>Устройство</th><th>Школа</th><th>Последняя связь</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.display_name || item.hostname || item.id)}</td><td>${escapeHtml(item.school_name || item.school_id || "—")}</td><td>${escapeHtml(time(item.last_seen, true))}</td></tr>`).join("")}</tbody></table>` : `<div class="table-empty">Устройств не найдено.</div>`); } catch (_) { $("#agentVersionDevices").hidden = false; $("#agentVersionDevices").innerHTML = `<div class="table-empty">Список устройств недоступен.</div>`; }
  }
  function renderOverview(data) {
    const schools = (data.schools ?? data.organization_count ?? data.counts?.schools ?? state.frontendModel?.linkwatch?.monitoredSchoolCount ?? new Set(state.lines.map((line) => line.school_id)).size) || 0;
    const devices = data.active_devices ?? data.active_points ?? data.devices ?? data.counts?.active_devices ?? state.lines.length;
    const problems = data.problem_lines ?? data.problems ?? data.counts?.problem_lines ?? state.lines.filter((line) => ["critical", "unstable"].includes(statusClass(line.status))).length;
    const completeness = data.completeness ?? data.data_completeness ?? data.data_completeness_pct ?? 94;
    const averages = data.averages || {};
    $("#kpiSchools").textContent = number(schools);
    $("#kpiDevices").textContent = number(devices);
    $("#kpiProblems").textContent = number(problems);
    $("#kpiCompleteness").innerHTML = `${number(completeness)}<em>%</em>`;
    $("#kpiAverageDownload").textContent = overviewMetric(averages.download, " Мбит/с");
    $("#kpiAverageUpload").textContent = overviewMetric(averages.upload, " Мбит/с");
    $("#kpiAveragePing").textContent = overviewMetric(averages.ping, " мс");
    renderRegistryStatus();
    if (data.completeness != null || data.data_completeness != null) $("#qualityScore").textContent = number(completeness);
    $("#lineNavCount").textContent = number(state.lines.length || data.lines || data.counts?.lines || "—");
    $("#incidentNavCount").textContent = number((data.active_incidents ?? data.counts?.active_incidents ?? state.incidents.filter((item) => item.status !== "CLOSED").length) || "—");
  }
  function populateFilters() {
    const districts = [...new Set(state.lines.map((line) => line.district).filter(Boolean))].sort();
    const providers = [...new Set(state.lines.map((line) => line.provider).filter(Boolean))].sort();
    const technologies = [...new Set(state.lines.map((line) => line.technology).filter(Boolean))].sort();
    const districtSelect = $("#districtFilter"); const providerSelect = $("#providerFilter"); const technologySelect = $("#technologyFilter");
    districtSelect.innerHTML = `<option value="">Все районы</option>${districts.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
    providerSelect.innerHTML = `<option value="">Все провайдеры</option>${providers.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
    technologySelect.innerHTML = `<option value="">Все типы</option>${technologies.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
    districtSelect.value = state.filters.district; providerSelect.value = state.filters.provider; technologySelect.value = state.filters.technology; $("#statusFilter").value = state.filters.status; $("#periodFilter").value = state.filters.period; $("#fromDateFilter").value = state.filters.from; $("#toDateFilter").value = state.filters.to; $("#mapListMode").value = state.filters.mapMode; toggleCustomPeriod(); syncModeControls();
  }
  function dateValue(date) { return new Date(date).toISOString().slice(0, 10); }
  function toggleCustomPeriod() { const controls = $("#customPeriodControls"); if (controls) controls.hidden = state.filters.period !== "custom"; }
  function ensureCustomDates() { if (!state.filters.from || !state.filters.to) { const end = new Date(); state.filters.to = dateValue(end); state.filters.from = dateValue(new Date(end.getTime() - 6 * 86400000)); } const from = $("#fromDateFilter"); const to = $("#toDateFilter"); if (from) from.value = state.filters.from; if (to) to.value = state.filters.to; }
  function validCustomPeriod() { if (state.filters.period !== "custom" || !state.filters.from || !state.filters.to || state.filters.from <= state.filters.to) return true; toast("Дата начала должна быть не позже даты окончания", "warn"); return false; }
  function isHistoricalMode() { return state.filters.mapMode === "historical"; }
  function periodLabel() { return state.filters.period === "custom" ? `${state.filters.from || "?"} — ${state.filters.to || "?"}` : ({ day: "сегодня", week: "7 дней", month: "месяц" }[state.filters.period] || state.filters.period); }
  function syncModeControls() {
    const historical = isHistoricalMode();
    const status = $("#statusFilter");
    if (status) { status.disabled = historical; status.title = historical ? "Фильтр current state доступен только в текущем режиме" : ""; }
    $$('[data-table-view]').forEach((button) => { button.disabled = historical; button.title = historical ? "Представление historical evidence использует строки линий" : ""; });
  }
  function filteredLines() {
    const query = state.filters.search.trim().toLowerCase();
    return state.lines.filter((line) => {
      const matchesQuery = !query || [line.id, line.school_id, line.school_name, line.district, line.provider].some((value) => String(value || "").toLowerCase().includes(query));
      const matchesDistrict = !state.filters.district || line.district === state.filters.district;
      const matchesProvider = !state.filters.provider || line.provider === state.filters.provider;
      const matchesTechnology = !state.filters.technology || line.technology === state.filters.technology;
      const normalizedStatus = String(line.status || "").toUpperCase() === "UNSTABLE" ? "DEGRADED" : String(line.status || "").toUpperCase();
      const matchesStatus = isHistoricalMode() || !state.filters.status || normalizedStatus === state.filters.status;
      const matchesView = isHistoricalMode() || (state.filters.view === "attention" ? ["critical", "unstable"].includes(statusClass(line.status)) : state.filters.view === "stale" ? statusClass(line.data_state) === "no-data" : true);
      return matchesQuery && matchesDistrict && matchesProvider && matchesTechnology && matchesStatus && matchesView;
    });
  }
  function historicalSummary(line) { return state.historicalByLine[line.id] || null; }
  function historicalBadge(summary) {
    if (!summary || !Number(summary.measurement_count)) return { className: "no-data", label: "Нет данных" };
    if (summary.analytics_state === "UNKNOWN") return { className: "no-data", label: "Недостаточно данных" };
    return { className: "historical", label: "История доступна" };
  }
  function historicalRate(value) { return value == null ? "Нет данных" : `${number(value)}%`; }
  function historicalReportPayload(payload) { return payload?.data || payload || {}; }
  async function loadHistoricalPeriod() {
    if (!isHistoricalMode() || !validCustomPeriod()) return;
    const request = ++state.historicalRequest;
    state.historicalLoading = true;
    state.historicalError = null;
    state.historicalByLine = {};
    renderMap(); renderLines();
    try {
      const query = currentReportParams();
      const aggregateResponse = await apiTry([`/api/reports/aggregate?${query}`, `/api/v1/reports/aggregate?${query}`]);
      const aggregate = historicalReportPayload(aggregateResponse);
      let analytics = {};
      try {
        const analyticsResponse = await apiTry([`/api/reports/analytics?${query}&limit=500`, `/api/v1/reports/analytics?${query}&limit=500`]);
        analytics = historicalReportPayload(analyticsResponse);
      } catch (_) {
        // Aggregate data is still canonical historical evidence; missing analytics
        // must remain visible as unknown instead of becoming a client verdict.
      }
      if (request !== state.historicalRequest || !isHistoricalMode()) return;
      const summaries = {};
      Object.entries(aggregate.by_line || {}).forEach(([lineID, value]) => { summaries[lineID] = { ...value }; });
      (analytics.ranking || []).forEach((value) => {
        if (!value.line_id) return;
        summaries[value.line_id] = { ...(summaries[value.line_id] || {}), baseline_compliance: value.baseline_compliance, contract_compliance: value.contract_compliance, analytics_state: value.state };
      });
      state.historicalByLine = summaries;
    } catch (error) {
      if (request === state.historicalRequest && isHistoricalMode()) state.historicalError = error;
    } finally {
      if (request === state.historicalRequest) {
        state.historicalLoading = false;
        renderMap(); renderLines();
      }
    }
  }
  function renderAll() { renderMap(); renderSituations(); renderLines(); renderActivity(); renderIncidents(); renderNotifications(); renderPassport(); $("#situationCount").textContent = state.situations.length; $("#lineCount").textContent = state.lines.length; }
  function renderMap() {
    if (window.LinkwatchMap) {
      const historical = isHistoricalMode();
      syncModeControls();
      const modeLabel = $("#mapModeLabel");
      if (modeLabel) modeLabel.innerHTML = historical ? "ГЕОГРАФИЯ · ИСТОРИЧЕСКИЙ ПЕРИОД" : "ГЕОГРАФИЯ · ТЕКУЩЕЕ СОСТОЯНИЕ <span class=\"panel-live\"><i></i> живые данные</span>";
      if (state.mapPopupLineID) closeMapPopup(false);
      if (historical && state.historicalLoading) { $("#mapVisibleCount").textContent = "—"; $("#mapFooterNote").textContent = `Загрузка historical evidence за период: ${periodLabel()}`; return; }
      if (historical && state.historicalError) { $("#mapVisibleCount").textContent = "—"; $("#mapFooterNote").textContent = "Историческое представление недоступно"; return; }
      const rows = filteredLines();
      $("#mapVisibleCount").textContent = rows.length;
      $("#mapFooterNote").textContent = historical ? `Historical evidence · ${periodLabel()} · current LineState не используется` : "Текущее состояние из latest LineState";
      window.LinkwatchMap.render({
        containerId: "leafletMap",
        mode: historical ? "historical" : "current",
        lineCount: rows.length,
        lines: rows,
        model: state.frontendModel,
        registry: state.frontendModel?.registry,
        historicalByLine: state.historicalByLine,
      });
      return;
    }
    const root = $("#mapMarkers"); if (!root) return;
    const historical = isHistoricalMode();
    syncModeControls();
    const modeLabel = $("#mapModeLabel");
    if (modeLabel) modeLabel.innerHTML = historical ? "ГЕОГРАФИЯ · ИСТОРИЧЕСКИЙ ПЕРИОД" : "ГЕОГРАФИЯ · ТЕКУЩЕЕ СОСТОЯНИЕ <span class=\"panel-live\"><i></i> живые данные</span>";
    if (state.mapPopupLineID) closeMapPopup(false);
    if (historical && state.historicalLoading) { root.innerHTML = ""; $("#mapVisibleCount").textContent = "—"; $("#mapFooterNote").textContent = `Загрузка historical evidence за период: ${periodLabel()}`; return; }
    if (historical && state.historicalError) { root.innerHTML = ""; $("#mapVisibleCount").textContent = "—"; $("#mapFooterNote").textContent = "Историческое представление недоступно"; return; }
    const rows = filteredLines();
    $("#mapVisibleCount").textContent = rows.length;
    $("#mapFooterNote").textContent = historical ? `Historical evidence · ${periodLabel()} · current LineState не используется` : "Текущее состояние из latest LineState";
    root.innerHTML = rows.map((line, index) => { const coords = Array.isArray(line.coordinates) ? line.coordinates : [190 + (index * 59) % 320, 110 + (index * 37) % 170]; const summary = historicalSummary(line); const badge = historical ? historicalBadge(summary) : { className: statusClass(line.status), label: statusLabel(line.status) }; return `<g class="map-marker ${badge.className}" data-line-id="${escapeHtml(line.id)}" tabindex="0" role="button" aria-controls="mapPopup" aria-expanded="false" aria-label="${escapeHtml(line.school_name)} — ${escapeHtml(historical ? `историческое представление: ${badge.label}` : badge.label)}" transform="translate(${Number(coords[0]) || 0} ${Number(coords[1]) || 0})"><circle class="halo" r="13"></circle><circle class="core" r="5"></circle><text x="9" y="3">${escapeHtml(line.school_name.replace(/^(Средняя |Городская )?школа(а)?\s*/i, "").slice(0, 14))}</text></g>`; }).join("");
    $$(".map-marker", root).forEach((marker) => { marker.addEventListener("click", () => openMapPopup(marker.dataset.lineId, marker)); marker.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openMapPopup(marker.dataset.lineId, marker); } }); });
  }
  function renderSituations() {
    const root = $("#situationsList"); if (!state.situations.length) { root.innerHTML = `<div class="table-empty">Нет текущих связанных ситуаций</div>`; return; }
    root.innerHTML = state.situations.slice(0, 4).map((situation) => `<article class="situation-card" data-situation-id="${escapeHtml(situation.id)}" tabindex="0"><i class="severity-mark ${statusClass(situation.severity || situation.status)}"></i><div><span class="situation-title">${escapeHtml(situation.title || situation.name || "Связанные нарушения")}</span><span class="situation-meta">${escapeHtml(situation.meta || `${situation.provider || "—"} · ${situation.affected_count || 0} линий`)} · <b>${escapeHtml(situation.reason || "Возможная связь")}</b></span></div><time class="situation-time">${time(situation.started_at || situation.start_at)}</time></article>`).join("");
    $$(".situation-card", root).forEach((card) => { const open = () => openSituation(card.dataset.situationId); card.addEventListener("click", open); card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }); });
  }
  function renderHistoricalLines(rows, root) {
    if (state.historicalLoading) { root.innerHTML = `<tr><td colspan="6" class="table-empty">Загрузка historical evidence…</td></tr>`; $("#loadMore").hidden = true; $("#tableSummary").textContent = "Загрузка периода"; return; }
    if (state.historicalError) { root.innerHTML = `<tr><td colspan="6" class="table-empty">Историческое представление недоступно. Повторите попытку.</td></tr>`; $("#loadMore").hidden = true; $("#tableSummary").textContent = "Ошибка исторического отчёта"; return; }
    if (!rows.length) { root.innerHTML = `<tr><td colspan="6" class="table-empty">По выбранным фильтрам линий нет.</td></tr>`; $("#loadMore").hidden = true; $("#tableSummary").textContent = "Нет строк"; return; }
    const visibleRows = rows.slice(0, state.lineLimit);
    root.innerHTML = visibleRows.map((line) => {
      const summary = historicalSummary(line); const badge = historicalBadge(summary); const measurements = summary?.measurement_count == null ? "Нет данных" : number(summary.measurement_count); const problems = summary?.problem_measurement_count == null ? "Нет данных" : number(summary.problem_measurement_count);
      return `<tr><td><div class="line-cell"><span class="line-avatar">${escapeHtml((line.school_name || "Ш").replace(/[^А-ЯA-Z]/gi, "").slice(0, 1) || "Ш")}</span><div><span class="line-name">${escapeHtml(line.school_name)}</span><span class="line-sub">${escapeHtml(line.id)} · ${escapeHtml(line.role)} · ${escapeHtml(line.technology)}</span></div></div></td><td><span class="status-badge ${badge.className}"><i></i>${escapeHtml(badge.label)}</span></td><td><div class="axis-pair"><span class="axis-chip ${summary?.baseline_compliance == null ? "unknown" : "good"}"><strong>Базовый норматив</strong> ${escapeHtml(historicalRate(summary?.baseline_compliance))}</span><span class="axis-chip ${summary?.contract_compliance == null ? "unknown" : "good"}"><strong>Договор</strong> ${escapeHtml(historicalRate(summary?.contract_compliance))}</span></div></td><td><div class="metric-line"><strong>${escapeHtml(measurements)} наблюдений</strong><span>Проблемные: ${escapeHtml(problems)}</span></div></td><td><div class="time-line"><span class="freshness">${escapeHtml(periodLabel())}</span><span>Historical evidence · current state не используется</span></div></td><td><button class="row-action" data-line-id="${escapeHtml(line.id)}">Открыть →</button></td></tr>`;
    }).join("");
    $$(".row-action", root).forEach((button) => button.addEventListener("click", () => openLine(button.dataset.lineId)));
    $("#loadMore").hidden = rows.length <= state.lineLimit;
    $("#tableSummary").textContent = `Historical: показано ${Math.min(rows.length, state.lineLimit)} из ${rows.length} линий`;
  }
  function renderLines() {
    const rows = filteredLines(); const root = $("#linesTableBody");
    syncModeControls();
    const modeNote = $("#lineModeNote"); if (modeNote) modeNote.textContent = isHistoricalMode() ? `Исторический режим: ${periodLabel()}. Представление построено backend report dataset; current LineState не используется.` : "Текущее состояние берётся из latest LineState. Период не меняет current truth и используется только для исторического отчёта.";
    if (isHistoricalMode()) { renderHistoricalLines(rows, root); return; }
    if (state.filters.view === "schools") {
      const groups = new Map();
      rows.forEach((line) => { const key = line.organization_id || line.school_id || line.school_name; const group = groups.get(key) || { ...line, lines: [], providers: new Set(), incidents: 0 }; group.lines.push(line); if (line.provider && line.provider !== "—") group.providers.add(line.provider); group.incidents += state.incidents.filter((item) => item.line_id === line.id && String(item.status).toUpperCase() !== "CLOSED").length; groups.set(key, group); });
      const rank = (line) => ({ CRITICAL: 4, NO_INTERNET: 4, DEGRADED: 3, UNSTABLE: 3, NO_DATA: 2, UNKNOWN: 2, OK: 1 }[String(line.status || "UNKNOWN").toUpperCase()] || 1);
      const schools = [...groups.values()].sort((left, right) => rank(right) - rank(left) || String(left.school_name).localeCompare(String(right.school_name))).slice(0, state.lineLimit);
      root.innerHTML = schools.length ? schools.map((school) => { const worst = school.lines.reduce((current, line) => rank(line) > rank(current) ? line : current, school.lines[0]); const latest = school.lines.map((line) => line.latest?.at).filter(Boolean).sort().pop(); return `<tr><td colspan="6"><article class="school-card"><div><span class="line-avatar">${escapeHtml((school.school_name || "Ш").replace(/[^А-ЯA-Z]/gi, "").slice(0, 1) || "Ш")}</span></div><div class="school-card-main"><h3>${escapeHtml(school.school_name)}</h3><p>${escapeHtml(school.school_id)} · ${escapeHtml(school.district)} · ${school.lines.length} активных линий</p><small>${escapeHtml([...school.providers].join(", ") || "Провайдер не указан")} · ${school.incidents} активных инцидентов · последнее наблюдение ${escapeHtml(time(latest, true))}</small><div class="school-line-links">${school.lines.map((line) => `<button class="row-action" data-line-id="${escapeHtml(line.id)}">${escapeHtml(line.id)} · ${escapeHtml(line.role)} · ${escapeHtml(statusLabel(line.status))}</button>`).join("")}</div></div><span class="status-badge ${statusClass(worst.status)}"><i></i>${escapeHtml(statusLabel(worst.status))}</span></article></td></tr>`; }).join("") : `<tr><td colspan="6" class="table-empty">Школ по выбранным фильтрам нет.</td></tr>`;
      $$(".row-action", root).forEach((button) => button.addEventListener("click", () => openLine(button.dataset.lineId)));
      $("#loadMore").hidden = groups.size <= state.lineLimit; $("#tableSummary").textContent = `${schools.length} школ · статус берётся из худшей линии`; return;
    }
    const visibleRows = rows.slice(0, state.lineLimit);
    if (!rows.length) { root.innerHTML = `<tr><td colspan="6" class="table-empty">По выбранным фильтрам линий нет. Измените фильтр или сбросьте его.</td></tr>`; } else root.innerHTML = visibleRows.map((line) => {
      const cls = statusClass(line.status); const quality = statusClass(line.quality_state); const contract = statusClass(line.contract_state); const latest = line.latest || {};
      return `<tr><td><div class="line-cell"><span class="line-avatar">${escapeHtml((line.school_name || "Ш").replace(/[^А-ЯA-Z]/gi, "").slice(0, 1) || "Ш")}</span><div><span class="line-name">${escapeHtml(line.school_name)}</span><span class="line-sub">${escapeHtml(line.id)} · ${escapeHtml(line.role)} · ${escapeHtml(line.technology)}</span></div></div></td><td><span class="status-badge ${cls}"><i></i>${escapeHtml(statusLabel(line.status))}</span></td><td><div class="axis-pair"><span class="axis-chip ${quality === "healthy" ? "good" : quality === "unstable" ? "warn" : "unknown"}"><strong>Качество</strong> ${escapeHtml(axisLabel(line.quality_state))}</span><span class="axis-chip ${contract === "healthy" ? "good" : contract === "unstable" ? "warn" : "unknown"}"><strong>Договор</strong> ${escapeHtml(axisLabel(line.contract_state))}</span></div></td><td><div class="metric-line"><strong>${latest.download == null ? "Нет наблюдения" : `↓ ${number(latest.download, " Мбит/с")}`}</strong><span>${latest.ping == null ? "—" : `Ping ${number(latest.ping, " мс")} · Loss ${number(latest.loss, "%")}`}</span></div></td><td><div class="time-line"><span class="${line.data_state === "NO_DATA" ? "freshness stale" : "freshness"}">${line.data_state === "NO_DATA" ? "Нет актуальных данных" : relative(latest.at)}</span><span>${time(latest.at, true)}</span></div></td><td><button class="row-action" data-line-id="${escapeHtml(line.id)}">Открыть →</button></td></tr>`;
    }).join("");
    $$(".row-action", root).forEach((button) => button.addEventListener("click", () => openLine(button.dataset.lineId)));
    const loadMore = $("#loadMore");
    loadMore.hidden = rows.length <= state.lineLimit;
    $("#tableSummary").textContent = rows.length ? `Показано ${Math.min(rows.length, state.lineLimit)} из ${rows.length} линий` : "Нет строк";
  }
  function renderActivity() {
    const root = $("#activityList"); const items = state.audit.length ? state.audit.slice(0, 5).map((item) => ({ at: item.at || item.created_at, text: item.description || item.action, detail: item.actor_name || item.actor || "Система" })) : state.usingDemoData ? [{ at: "2026-09-16T14:08:00Z", text: "Восстановление наблюдается на линии L-008", detail: "Автоматическое наблюдение" }, { at: "2026-09-16T13:00:00Z", text: "Создан инцидент INC-181", detail: "Средняя школа №42" }, { at: "2026-09-16T11:29:00Z", text: "Получены buffered-наблюдения от S-042", detail: "Агент · 4 записи" }, { at: "2026-09-16T11:17:00Z", text: "Подтверждено отсутствие соединения", detail: "Школа имени Абая" }] : [];
    root.innerHTML = items.length ? items.map((item) => `<div class="activity-item"><time class="activity-time">${time(item.at)}</time><span class="activity-dot"></span><div class="activity-copy"><b>${escapeHtml(item.text || "Событие")}</b><small>${escapeHtml(item.detail || "")}</small></div></div>`).join("") : `<div class="table-empty">Нет доступных действий</div>`;
  }
  function evidenceChainHtml(chain) {
    if (!chain) return "";
    const completeness = chain.completeness || {};
    const confirmation = chain.confirmation || {};
    const policy = chain.policy || {};
    const context = chain.line_context || {};
    const provenance = chain.configuration_provenance?.historical || {};
    const policyProvenance = provenance.policy || {};
    const contractProvenance = provenance.contract || {};
    const contextProvenance = provenance.line_context || {};
    const hierarchy = provenance.hierarchy || {};
    const auditNote = policyProvenance.change_metadata_status === "UNKNOWN" ? " · change metadata unavailable in stored snapshot" : "";
    const axis = (label, value) => { const item = chain[label] || {}; return `<span>${label === "baseline" ? "Базовый норматив" : "Договорный ориентир"}: ${escapeHtml(item.state || "UNKNOWN")}</span>`; };
    const reason = completeness.unknown_reason ? ` · ${completeness.unknown_reason}` : "";
    return `<div class="evidence-chain"><b>Evidence chain · ${escapeHtml(completeness.status || chain.status || "UNKNOWN")}</b><div>${axis("baseline")} · ${axis("contract")}</div><small>Метод: ${escapeHtml(confirmation.method || "UNKNOWN")} · наблюдений: ${escapeHtml(String(confirmation.count ?? 0))} · длительность: ${escapeHtml(String(confirmation.duration_minutes ?? 0))} мин · policy: ${escapeHtml(policy.version != null ? `v${policy.version}` : "UNKNOWN")} · context: ${escapeHtml(context.version != null ? `v${context.version}` : "UNKNOWN")}${escapeHtml(reason)}</small><small>Policy: ${escapeHtml(policyProvenance.source || "UNKNOWN")} / ${escapeHtml(policyProvenance.scope_type || "UNKNOWN")} · Contract: ${escapeHtml(contractProvenance.source || "UNKNOWN")} · Context: ${escapeHtml(contextProvenance.source || "UNKNOWN")}${escapeHtml(auditNote)}</small><small>Иерархия: ${escapeHtml((hierarchy.precedence || []).join(" → ") || "UNKNOWN")}</small>${chain.verification?.status ? `<small>Verification: ${escapeHtml(chain.verification.status)}</small>` : ""}</div>`;
  }
  function renderIncidents() {
    const root = $("#incidentBoard"); if (!state.incidents.length) { root.innerHTML = `<div class="table-empty">Инцидентов нет</div>`; return; }
    root.innerHTML = state.incidents.map((incident) => { const closed = String(incident.status).toUpperCase() === "CLOSED"; const line = state.lines.find((item) => item.id === incident.line_id); const providerAction = !closed && canSendProvider(line) ? `<button class="button button-primary" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="draft">Обращение →</button>` : ""; return `<article class="incident-card ${statusClass(incident.severity)}"><div class="incident-top"><span class="incident-number">${escapeHtml(incident.number || incident.id)} · ${escapeHtml(incident.source === "MANUAL" ? "создан вручную" : "автоматически")}</span><span class="status-badge ${closed ? "healthy" : statusClass(incident.severity)}"><i></i>${escapeHtml(incidentStatusLabel(incident.status))}</span></div><h3>${escapeHtml(incident.title || incident.description || "Инцидент на линии")}</h3><p>${escapeHtml(incident.school_name)} · ${escapeHtml(incident.provider)} · ${escapeHtml(incident.description || "")}</p><div class="incident-meta"><span class="axis-chip">Начало ${escapeHtml(time(incident.started_at || incident.start_time))}</span><span class="axis-chip">${incident.duration_minutes ? `Длительность ${number(incident.duration_minutes, " мин")}` : "В работе"}</span></div><div class="incident-action"><button class="button button-quiet" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="open">Открыть timeline</button>${providerAction}</div></article>`; }).join("");
    $$("[data-incident-action]", root).forEach((button) => button.addEventListener("click", () => { const incident = state.incidents.find((item) => item.id === button.dataset.incidentId); if (!incident) return; if (button.dataset.incidentAction === "draft") openCaseModal(incident); else { const line = state.lines.find((item) => item.id === incident.line_id); if (line) openLine(line.id); else toast("Timeline инцидента доступна в API", "warn"); } }));
  }
  async function loadProviderWorkspace() {
    if (!canSendProvider()) return;
    try {
      const payload = await apiTry(["/api/provider-cases?limit=50", "/api/v1/provider-cases?limit=50"]);
      const items = payload.items || payload.data || [];
      const root = $("#incidentBoard"); if (!root || !items.length) return;
      const panel = document.createElement("section"); panel.className = "provider-workspace";
      panel.innerHTML = `<div class="panel-kicker">PROVIDER WORKSPACE · SERVER-SCOPED QUEUE</div><h3>Очередь обращений поставщику</h3><p class="section-subtitle">События, evidence и delivery status читаются из canonical provider cases; отправка требует human review.</p><div class="provider-queue">${items.map((item) => `<article class="incident-card"><div class="incident-top"><span>${escapeHtml(item.ticket_no || `CASE-${item.id}`)} · ${escapeHtml(item.provider_name || "Провайдер")}</span><span class="status-badge ${statusClass(item.delivery_status)}"><i></i>${escapeHtml(item.delivery_status || item.status || "UNKNOWN")}</span></div><h4>${escapeHtml(item.organization_name || item.line_id || "Линия")}</h4><p>${escapeHtml(item.line_id || "—")} · ${escapeHtml(item.incident_no || "LINE REVIEW")}</p><div class="incident-meta"><span class="axis-chip">Попыток: ${escapeHtml(String(item.delivery_attempts || 0))}</span><span class="axis-chip">${item.delivery_retryable ? "Retryable" : "Не повторять автоматически"}</span></div>${item.delivery_error ? `<small>${escapeHtml(item.delivery_error)}</small>` : ""}</article>`).join("")}</div>`;
      root.prepend(panel);
    } catch (_) { /* provider workspace is additive; incidents remain available */ }
  }
  function renderIncidents() {
    const root = $("#incidentBoard"); if (!root) return;
    if (!state.incidents.length) { root.innerHTML = `<div class="table-empty">Инцидентов нет</div>`; return; }
    const canUpdate = hasCapability("incident.update") || demoCapabilities();
    root.innerHTML = state.incidents.map((incident) => {
      const closed = String(incident.status).toUpperCase() === "CLOSED"; const line = state.lines.find((item) => item.id === incident.line_id); const events = incident.events || incident.actions || []; const related = incident.repeatability?.related_incidents || []; const providerAction = !closed && canSendProvider(line) ? `<button class="button button-primary" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="draft">Обращение →</button>` : ""; const commentAction = !closed && hasCapability("incident.read") ? `<button class="button button-quiet" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="comment">Комментарий</button>` : ""; const updateActions = !closed ? `${canUpdate ? `<button class="button button-quiet" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="assign">Назначить</button><select class="incident-status-select" data-incident-id="${escapeHtml(incident.id)}" aria-label="Изменить статус"><option value="">Статус…</option><option>NEW</option><option>IN_PROGRESS</option><option>WAITING_INFO</option><option>RESOLVED</option></select>` : ""}${commentAction}` : ""; const recovery = !closed && canSendProvider(line) ? `<button class="button button-quiet" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="provider_fixed">Восстановление наблюдается</button>` : "";
      return `<article class="incident-card ${statusClass(incident.severity)}"><div class="incident-top"><span class="incident-number">${escapeHtml(incident.number || incident.id)} · ${escapeHtml(incident.source === "MANUAL" ? "создан вручную" : "автоматически")}</span><span class="status-badge ${closed ? "healthy" : statusClass(incident.severity)}"><i></i>${escapeHtml(incidentStatusLabel(incident.status))}</span></div><h3>${escapeHtml(incident.title || incident.description || "Инцидент на линии")}</h3><p>${escapeHtml(incident.school_name)} · ${escapeHtml(incident.provider)} · ${escapeHtml(incident.description || "")}</p><div class="incident-meta"><span class="axis-chip">Начало ${escapeHtml(time(incident.started_at || incident.start_time))}</span><span class="axis-chip">${incident.duration_minutes ? `Длительность ${number(incident.duration_minutes, " мин")}` : "В работе"}</span><span class="axis-chip">${escapeHtml(incident.recovery_label || (incident.recovery_state === "OBSERVED" ? "Восстановление наблюдается" : "Восстановление не подтверждено"))}</span></div><div class="incident-evidence"><b>Opening evidence</b><small>${escapeHtml(incident.opening_snapshot?.reason || incident.opening_snapshot?.manual_description || "Снимок открытия сохранён сервером")}</small>${evidenceChainHtml(incident.evidence_chain)}</div><div class="incident-timeline">${events.length ? events.slice(-8).map((event) => `<div><time>${escapeHtml(time(event.at || event.created_at))}</time><span>${escapeHtml(event.text || event.event_type || "Событие")}</span></div>`).join("") : `<small>Append-only timeline пока пуста.</small>`}</div>${related.length ? `<div class="incident-repeatability"><b>Повторяемость · ${related.length} похожих инцидента за ${incident.repeatability.lookback_days || 90} дней</b><small>Сопоставление по линии и времени; это не доказательство общей причины или идентичности аварии.</small></div>` : `<div class="incident-repeatability"><small>Похожих инцидентов за выбранный lookback не найдено.</small></div>`}<div class="incident-action">${updateActions}${recovery}${providerAction}</div></article>`;
    }).join("");
    $$('[data-incident-action]', root).forEach((button) => button.addEventListener("click", () => incidentAction(button.dataset.incidentId, button.dataset.incidentAction)));
    $$(".incident-status-select", root).forEach((select) => select.addEventListener("change", () => { if (select.value) incidentAction(select.dataset.incidentId, "status", select.value); }));
  }
  async function incidentAction(id, eventType, status = "") {
    const incident = state.incidents.find((item) => String(item.id) === String(id)); if (!incident) return;
    let note = ""; if (eventType === "assign") note = window.prompt("Логин или имя ответственного", incident.assignee || "") || ""; if (eventType === "comment") note = window.prompt("Комментарий к append-only timeline", "") || ""; if (eventType === "assign" && !note.trim()) return; if (eventType === "comment" && !note.trim()) return;
    try { await apiTry([`/api/incidents/${encodeURIComponent(id)}/events`, `/api/v1/incidents/${encodeURIComponent(id)}/events`], { method: "POST", body: JSON.stringify({ event_type: eventType, status, note }) }); await loadData(); } catch (error) { if (error.status === 409) toast("Инцидент изменился на сервере — данные обновлены", "warn"); else if (error.status === 403) toast("Действие запрещено текущей ролью или scope", "warn"); else toast("Действие инцидента не выполнено", "warn"); }
  }
  function incidentStatusLabel(status) { return ({ NEW: "Новый", SENT_TO_PROVIDER: "Передан провайдеру", IN_PROGRESS: "В работе", WAITING_INFO: "Ожидает информации", RESOLVED: "Устранён · проверка", CLOSED: "Закрыт" }[String(status || "").toUpperCase()] || status || "Новый"); }
  function notificationDeliveryLabel(status) { return ({ PENDING: "Ожидает доставки", GENERATED: "Сформировано", DELIVERING: "Доставляется", SENT: "Доставлено", FAILED: "Ошибка доставки" }[String(status || "").toUpperCase()] || status || "Неизвестно"); }
  function renderNotifications() {
    const root = $("#notificationList"); if (!root) return;
    if (state.notificationLoading && !state.notifications.length) { root.innerHTML = `<div class="table-empty">Загрузка уведомлений…</div>`; return; }
    if (state.notificationError && !state.notifications.length) { root.innerHTML = `<div class="table-empty">Не удалось загрузить уведомления. Повторите попытку.</div>`; $("#notificationSummary").textContent = "Ошибка сервера"; return; }
    if (!state.notifications.length) { root.innerHTML = `<div class="table-empty">Уведомлений нет</div>`; $("#notificationSummary").textContent = "Нет доступных уведомлений"; return; }
    root.innerHTML = state.notifications.map((item) => {
      const noData = /NO_DATA|нет актуальн|недостаточно данных/i.test(`${item.message || ""} ${item.source_type || ""}`);
      const link = item.line_id ? `<button class="text-button notification-link" data-notification-line="${escapeHtml(item.line_id)}">Открыть линию →</button>` : "";
      return `<article class="notification-item"><div class="notification-top"><span class="notification-type">${escapeHtml(item.source_type || "Событие")}</span><span class="status-badge ${statusClass(item.status === "FAILED" ? "CRITICAL" : item.status === "SENT" ? "OK" : "UNKNOWN")}"><i></i>${escapeHtml(notificationDeliveryLabel(item.status))}</span></div><p class="notification-message">${escapeHtml(item.message || "Системное уведомление")}</p><div class="notification-context"><span>${escapeHtml(item.school_name || "Организация не указана")} · ${escapeHtml(item.line_id || "Линия не указана")}</span><time>${escapeHtml(time(item.generated_at, true))}</time></div>${noData ? `<small class="notification-note">Нет актуальных данных — это не подтверждает отсутствие интернета.</small>` : ""}<div class="notification-action">${link}</div></article>`;
    }).join("");
    $("#notificationSummary").textContent = `Показано ${state.notifications.length} уведомлений`;
    const more = $("#notificationLoadMore"); if (more) more.hidden = state.notifications.length < 50 || !state.notificationBeforeId;
    $$(".notification-link", root).forEach((button) => button.addEventListener("click", () => openLine(button.dataset.notificationLine)));
  }
  async function loadNotifications(reset = false) {
    if (!hasCapability("notification.read")) { state.notifications = []; state.notificationError = null; renderNotifications(); return; }
    if (state.notificationLoading) return;
    if (reset) { state.notifications = []; state.notificationBeforeId = null; state.notificationError = null; }
    state.notificationLoading = true; renderNotifications();
    const params = new URLSearchParams({ limit: "50" }); if (state.notificationBeforeId) params.set("before_id", state.notificationBeforeId);
    try { const payload = await apiTry([`/api/notifications?${params}`, `/api/v1/notifications?${params}`]); const items = unwrap(payload); state.notifications = reset ? items : state.notifications.concat(items); state.notificationBeforeId = items.length ? items[items.length - 1].id : null; state.notificationError = null; } catch (error) { state.notificationError = error; } finally { state.notificationLoading = false; renderNotifications(); }
  }
  function renderPassport(data = {}) {
    const root = $("#passportGrid");
    const values = Object.keys(data).length || !state.usingDemoData ? data : { baseline_rate: 91, contract_rate: 68, received: 121, expected: 124, incident_count: 2, problem_minutes: 460, completeness: 94, dynamics: { status: "AVAILABLE", direction: { availability_pct: "STABLE" } }, ...data };
    const reportNote = $("#reportPeriodNote"); if (reportNote) reportNote.textContent = `Канонический период: ${state.filters.period === "custom" ? `${state.filters.from || "?"} — ${state.filters.to || "?"}` : state.filters.period}. Значения historical и не заменяют current operational state карты.`;
    if (values.completeness != null) $("#qualityScore").textContent = number(values.completeness);
    if (values.baseline_rate != null) $("#baselineRate").textContent = `${number(values.baseline_rate)}%`;
    if (values.contract_rate != null) $("#contractRate").textContent = `${number(values.contract_rate)}%`;
    $("#recoveryRate").textContent = values.incidents?.confirmed_recovery_count != null && values.incident_count ? `${number(values.incidents.confirmed_recovery_count / values.incident_count * 100)}%` : "Нет данных";
    const noteTitle = $(".quality-note b"); const noteText = $(".quality-note small");
    if (noteTitle) noteTitle.textContent = values.dynamics?.status === "AVAILABLE" && values.sufficient_data !== false ? "Данных достаточно для сравнения" : values.dynamics?.status === "NO_DATA" ? "Нет данных для сравнения" : "Недостаточно данных для сравнения";
    if (noteText) noteText.textContent = values.received != null && values.expected != null ? `${values.received} из ${values.expected} ожидаемых наблюдений за период` : (values.dynamics?.reason || "Сравнение с предыдущим периодом недоступно");
    const direction = values.dynamics?.direction?.availability_pct; const trend = values.dynamics?.status === "AVAILABLE" ? ({ UP: "Лучше", DOWN: "Хуже", STABLE: "Без изменений" }[direction] || "Доступно") : (values.dynamics?.status === "NO_DATA" ? "Нет данных" : values.dynamics?.status === "INCOMPARABLE" ? "Несопоставимо" : "Недостаточно данных");
    const incidents = values.incidents || {};
    const cards = [{ label: "Базовый норматив", value: values.baseline_rate == null ? "Нет данных" : `${number(values.baseline_rate)}%`, note: "наблюдений соответствуют" }, { label: "Договорный ориентир", value: values.contract_rate == null ? "Нет данных" : `${number(values.contract_rate)}%`, note: "наблюдений соответствуют" }, { label: "Полнота данных", value: values.received != null && values.expected != null ? `${values.received} / ${values.expected}` : "Нет данных", note: "ожидаемых наблюдений" }, { label: "Повторяемость", value: incidents.recurrence_count == null ? "Нет данных" : incidents.recurrence_count, note: "повторных инцидентов" }, { label: "Суммарная длительность", value: incidents.total_duration_minutes == null ? "Нет данных" : `${Math.round(incidents.total_duration_minutes)} мин`, note: incidents.recovery_narrative || "инцидентов за период" }, { label: "Динамика", value: trend, note: values.dynamics?.reason || "к предыдущему эквивалентному периоду" }];
    root.innerHTML = cards.map((card) => `<div class="passport-item"><span>${escapeHtml(card.label)}</span><b>${escapeHtml(String(card.value))}</b><small>${escapeHtml(card.note)}</small></div>`).join("") + (values.evidence_chain?.length ? values.evidence_chain.slice(0, 3).map(evidenceChainHtml).join("") : "") + (values.analytics ? analyticsHtml(values.analytics) : "");
  }
  function analyticsHtml(data) {
    if (!data || data.status === "NO_DATA") return `<div class="table-empty">NO_DATA: историческая аналитика за период отсутствует.</div>`;
    const rank = (data.ranking || []).slice(0, 10).map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.line_id || "—")}</td><td>${escapeHtml(item.state || "UNKNOWN")}</td><td>${item.baseline_compliance == null ? "Нет данных" : `${number(item.baseline_compliance)}%`}</td><td>${item.average_download == null ? "Нет данных" : number(item.average_download, " Мбит/с")}</td></tr>`).join("");
    const tod = (data.time_of_day || []).map((item) => `<span class="analytics-chip">${escapeHtml(item.key)} · ${escapeHtml(String(item.measurements || 0))}</span>`).join("");
    const trend = (data.trend || []).slice(-14).map((item) => `<span class="analytics-chip">${escapeHtml(item.key)} · ${escapeHtml(String(item.valid_evidence || 0))}</span>`).join("");
    const comparison = data.comparison || {};
    const comparisonText = comparison.status === "AVAILABLE" ? `Сравнение с предыдущим равным периодом: ${comparison.valid_evidence_delta >= 0 ? "+" : ""}${comparison.valid_evidence_delta || 0} valid evidence` : `Сравнение: ${comparison.status || "UNKNOWN"} — ${comparison.unknown_reason || "недостаточно исторических данных"}`;
    return `<div class="analytics-inline"><div class="panel-kicker">РАСШИРЕННАЯ АНАЛИТИКА · ${escapeHtml(data.status || "UNKNOWN")}</div><small>Только scoped historical evidence; current state не используется.</small><p>${escapeHtml(comparisonText)}</p><button type="button" class="button button-quiet" data-analytics-download>Скачать ranking CSV</button><table class="admin-table"><thead><tr><th>#</th><th>Линия</th><th>Состояние</th><th>Базовый норматив</th><th>Средний download</th></tr></thead><tbody>${rank || `<tr><td colspan="5">UNKNOWN: ranking недоступен.</td></tr>`}</tbody></table><div class="analytics-chips"><b>Время суток:</b> ${tod || "NO_DATA"}</div><div class="analytics-chips"><b>Последние дни:</b> ${trend || "NO_DATA"}</div></div>`;
  }
  async function loadAnalytics() {
    if (!validCustomPeriod()) return;
    try { const payload = await apiTry([`/api/reports/analytics?${currentReportParams()}&limit=50`, `/api/v1/reports/analytics?${currentReportParams()}&limit=50`]); state.analytics = payload.data || payload; } catch (_) { state.analytics = { status: "UNKNOWN" }; }
    loadPassportWithAnalytics();
  }
  function loadPassportWithAnalytics() { const current = state.lastPassport || {}; renderPassport({ ...current, analytics: state.analytics }); const button = $("[data-analytics-download]"); if (button) button.addEventListener("click", downloadAnalytics); }
  async function downloadAnalytics() { try { const response = await fetch(`/api/reports/analytics?${currentReportParams()}&limit=100&format=csv`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} }); if (!response.ok) throw new Error("analytics"); return consumeDownload(response, "analytics", "csv"); } catch (_) { toast("Историческая аналитика недоступна — файл не создан", "warn"); } }

  function popupText(value) { return value == null || value === "" || value === "—" ? "Нет данных" : String(value); }
  function closeMapPopup(restoreFocus = true) {
    const trigger = state.mapPopupTrigger;
    state.mapPopupLineID = null;
    state.mapPopupTrigger = null;
    const popup = $("#mapPopup");
    if (popup) popup.classList.add("hidden");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }
  function openMapPopup(id, trigger) {
    const line = state.lines.find((item) => item.id === id); if (!line) return;
    closeMapPopup(false);
    state.mapPopupLineID = id;
    state.mapPopupTrigger = trigger || null;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    const latest = line.latest || {};
    const summary = historicalSummary(line);
    const currentStatus = line.status ? statusLabel(line.status) : "Нет данных";
    const contractStatus = line.contract_state && line.contract_state !== "UNKNOWN" ? axisLabel(line.contract_state) : "Нет данных";
    const historySummary = !summary || !Number(summary.measurement_count) ? "Нет наблюдений за выбранный период" : `${number(summary.measurement_count)} наблюдений · проблемные: ${summary.problem_measurement_count == null ? "Нет данных" : number(summary.problem_measurement_count)}`;
    $("#mapPopupTitle").textContent = line.school_name;
    $("#mapPopupSummary").textContent = isHistoricalMode() ? `Historical evidence · ${periodLabel()} · ${historySummary}` : "Current operational data · latest LineState";
    const fields = [["School ID", popupText(line.school_id)], ["Название", popupText(line.school_name)], ["Район", popupText(line.district)], ["Провайдер", popupText(line.provider)], ["Технология", popupText(line.technology)], ["Договорный ориентир", contractStatus], ["Текущее состояние", currentStatus], ["Download · latest", popupMetric(latest.download, " Мбит/с")], ["Upload · latest", popupMetric(latest.upload, " Мбит/с")], ["Ping · latest", popupMetric(latest.ping, " мс")], ["Последнее наблюдение", latest.at ? time(latest.at, true) : "Нет данных"]];
    $("#mapPopupFields").innerHTML = fields.map(([label, value]) => `<div class="map-popup-field"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
    const popup = $("#mapPopup"); popup.classList.remove("hidden"); $("#mapPopupOpenLine").onclick = () => { closeMapPopup(false); openLine(id); }; $("#mapPopupClose").focus();
  }

  async function openLine(id) {
    const line = state.lines.find((item) => item.id === id); if (!line) return;
    let detail = line;
    if (!state.usingDemoData) { try { const response = await apiTry([`/api/lines/${encodeURIComponent(id)}`, `/api/v1/lines/${encodeURIComponent(id)}`]); detail = normalizeLine({ ...line, ...(response.data || response) }); } catch (_) { /* list data is enough to open the drawer */ } }
    state.currentLine = detail;
    $("#drawerTitle").textContent = detail.school_name;
    $("#drawerSubtitle").textContent = `${detail.id} · ${detail.role} линия · ${detail.provider}`;
    const cls = statusClass(detail.status);
    $("#drawerStatus").innerHTML = `<span class="status-badge ${cls}"><i></i>${escapeHtml(statusLabel(detail.status))}</span><p><b>Текущее состояние · latest</b><br>${escapeHtml(detail.reason)}</p>`;
    const m = detail.latest || {};
    const policy = m.policy_snapshot || detail.policy || {};
    const contract = m.contract_snapshot || detail.contract || {};
    $(".effective-pill").textContent = policy.version ? `Current policy v${policy.version}` : "Current policy не определена";
    $("#drawerAxes").innerHTML = `<div class="axis-card ${statusClass(detail.quality_state) === "unstable" ? "warn" : ""}"><span>Качество соединения</span><b>${escapeHtml(axisLabel(detail.quality_state))}</b><small>Базовый норматив · ↓${number(policy.download_min)} ↑${number(policy.upload_min)} · Ping ≤${number(policy.ping_max)}</small></div><div class="axis-card ${statusClass(detail.contract_state) === "unstable" ? "warn" : ""}"><span>Договорный ориентир</span><b>${escapeHtml(axisLabel(detail.contract_state))}</b><small>${contract.download_min != null ? `Download ${number(contract.download_min, " Мбит/с")}` : "Параметры не указаны"}</small></div>`;
    $("#drawerVerdict").innerHTML = `${escapeHtml(detail.reason || "Вывод рассчитан на backend по серии наблюдений и сохранённым snapshots.")} ${evidenceChainHtml(detail.evidence_chain || m.evidence_chain)}`;
    $("#drawerMetrics").innerHTML = [["Download · latest", number(m.download, " Мбит/с")], ["Upload · latest", number(m.upload, " Мбит/с")], ["Ping · latest", number(m.ping, " мс")], ["Jitter · latest", number(m.jitter, " мс")], ["Packet Loss · latest", number(m.loss, "%")], ["Последнее наблюдение", time(m.at, true)]].map(([label, value]) => `<div class="metric-box"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("");
    $("#drawerContext").innerHTML = [["School ID", detail.school_id], ["Адрес", detail.address], ["Ответственный", detail.contact_name], ["Телефон школы", detail.contact_phone], ["Line ID", detail.id], ["Район", detail.district], ["Провайдер", detail.provider], ["Поддержка провайдера", detail.support_contact], ["Тип подключения", detail.technology], ["Роль линии", detail.role], ["Effective policy", policy.version ? `v${policy.version} · ${policy.scope_type || "GLOBAL"}` : "Не определена"], ["Договор", contract.contract_no || "Не указан"], ["Monitoring point", detail.device_id || "—"], ["Агент", detail.agent_version || "—"], ["Последняя связь", time(detail.last_seen || m.at, true)]].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    const points = detail.monitoring_points || []; const devices = points.flatMap((point) => (point.devices || []).map((device) => ({ ...device, monitoring_point_location: point.location }))); $("#drawerDevices").innerHTML = devices.length ? `<div class="device-card-list"><b>Устройства и точки мониторинга</b>${devices.map((device) => `<button type="button" class="device-card-link" data-device-id="${escapeHtml(device.id)}"><strong>${escapeHtml(device.display_name || device.hostname || device.id)}</strong><span>${escapeHtml(device.monitoring_point_location || "Точка без названия")} · ${escapeHtml(device.agent_version || "версия неизвестна")}</span></button>`).join("")}</div>` : `<small class="table-empty">Устройств и свежих точек мониторинга нет.</small>`;
    $$("[data-device-id]", $("#drawerDevices")).forEach((button) => button.addEventListener("click", () => openDeviceCard(button.dataset.deviceId)));
    const related = state.incidents.filter((incident) => incident.line_id === detail.id); const history = detail.measurements || []; const events = history.slice(0, 8).map((item) => ({ at: item.observed_at, text: `${item.quality || item.connection_status || "Измерение"}${item.verification_status ? ` · verification ${item.verification_status}` : ""} · ${item.reason || "evaluation snapshot"}` })); if (!events.length) events.push({ at: m.at, text: "Последнее наблюдение получено" }, { at: new Date(new Date(m.at || Date.now()).getTime() - 3600000).toISOString(), text: "NO_DATA: история измерений отсутствует" });
    $("#drawerTimeline").innerHTML = events.map((item) => `<div class="timeline-row"><time>${time(item.at)}</time><span class="timeline-dot"></span><p><b>${escapeHtml(item.text)}</b></p></div>`).join("");
    $("#drawerBackdrop").classList.remove("hidden"); $("#detailDrawer").classList.add("open"); $("#detailDrawer").setAttribute("aria-hidden", "false");
    $("#drawerIncident").hidden = !state.user && !demoCapabilities();
    $("#drawerProvider").hidden = !canSendProvider(detail);
    $("#drawerIncident").onclick = () => { if (state.user || demoCapabilities()) createManualIncident(detail); };
    $("#drawerProvider").onclick = () => { if (!canSendProvider(detail)) return; const incident = related.find((item) => item.status !== "CLOSED") || related[0] || { line_id: detail.id, school_name: detail.school_name, provider: detail.provider, description: detail.reason, status: "NEW" }; openCaseModal(incident); };
  }
  async function openSituation(id) {
    const drawer = $("#detailDrawer");
    $(".panel-kicker", drawer).textContent = "ДЕТАЛИ СИТУАЦИИ · READ ONLY";
    $("#drawerTitle").textContent = "Загрузка ситуации…";
    $("#drawerSubtitle").textContent = "Материализованная связь; причинность не установлена";
    $("#drawerStatus").innerHTML = `<p>Загружаем канонические инциденты и evidence…</p>`;
    $("#drawerAxes").innerHTML = `<div class="table-empty">Загрузка…</div>`;
    $("#drawerVerdict").textContent = "Деталь доступна только для чтения и не изменяет canonical state.";
    $("#drawerMetrics").innerHTML = ""; $("#drawerContext").innerHTML = ""; $("#drawerTimeline").innerHTML = `<div class="table-empty">Загрузка…</div>`;
    $("#drawerIncident").hidden = true; $("#drawerProvider").hidden = true;
    $("#drawerBackdrop").classList.remove("hidden"); drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
    try {
      const response = state.usingDemoData ? { ...state.situations.find((item) => String(item.id) === String(id)), incidents: state.incidents } : await apiTry([`/api/situations/${encodeURIComponent(id)}`, `/api/v1/situations/${encodeURIComponent(id)}`]);
      const detail = response.data || response; const incidents = Array.isArray(detail.incidents) ? detail.incidents : [];
      $("#drawerTitle").textContent = detail.title || "Связанная ситуация";
      $("#drawerSubtitle").textContent = `${detail.status || "OPEN"} · ${detail.affected_count || incidents.length} доступных участников · только чтение`;
      const situationActions = detail.actions || {};
      const actionButtons = `<div class="incident-action"><button class="button button-quiet" data-situation-comparison="1">Сравнить controls</button>${situationActions.merge ? `<button class="button button-quiet" data-situation-action="merge">Объединить</button>` : ""}${situationActions.split ? `<button class="button button-quiet" data-situation-action="split">Разделить</button>` : ""}</div>`;
      $("#drawerStatus").innerHTML = `<span class="status-badge ${statusClass(detail.status)}"><i></i>${escapeHtml(detail.status || "OPEN")}</span><p>Это корреляционная группировка, а не вывод о единой причине.</p>${actionButtons}<button type="button" class="button button-secondary" id="liveVerifyButton">Проверить выбранные устройства сейчас</button><div id="liveVerifyStatus" class="table-empty">LIVE_VERIFY: готово к запросу</div>`;
      const liveVerifyButton = $("#liveVerifyButton");
      liveVerifyButton.onclick = async () => {
        liveVerifyButton.disabled = true;
        $("#liveVerifyStatus").textContent = "LIVE_VERIFY: отправляем bounded sample…";
        try {
          const result = await apiTry([`/api/situations/${encodeURIComponent(id)}/live-verify`, `/api/v1/situations/${encodeURIComponent(id)}/live-verify`], { method: "POST" });
          $("#liveVerifyStatus").textContent = `LIVE_VERIFY: ${result.status || result.data?.status || "REQUESTED"} · устройств ${result.sample_size || result.data?.sample_size || 0}. Результат остаётся обычным measurement evidence; причинность не установлена.`;
        } catch (error) {
          liveVerifyButton.disabled = false;
          $("#liveVerifyStatus").textContent = error.status === 403 ? "LIVE_VERIFY: действие запрещено текущим scope" : "LIVE_VERIFY: запрос не выполнен; повторите позже";
        }
      };
      $$('[data-situation-action]', drawer).forEach((button) => button.addEventListener("click", () => performSituationAction(detail, button.dataset.situationAction)));
      $$('[data-situation-comparison]', drawer).forEach((button) => button.addEventListener("click", () => openSituationComparison(detail)));
      const factors = detail.factors || detail.reason || {};
      $("#drawerAxes").innerHTML = [["Провайдер", factors.provider_id || detail.provider_id], ["Район", factors.district || detail.district], ["Тип нарушения", factors.violation_type || detail.violation_type], ["Начало окна", time(detail.start_at, true)]].map(([label, value]) => `<div class="axis-card"><span>${label}</span><b>${escapeHtml(value || "UNKNOWN")}</b><small>Фактор группировки</small></div>`).join("");
      $("#drawerVerdict").textContent = "Группировка построена существующим materialization worker по сохранённым факторам; она не доказывает общую первопричину.";
      $("#drawerMetrics").innerHTML = [["Начало", time(detail.start_at, true)], ["Последнее подтверждение", time(detail.latest_confirmation_at, true)], ["Evidence", (detail.evidence && detail.evidence.state) || "NO_DATA"]].map(([label, value]) => `<div class="metric-box"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("");
      const lines = incidents.map((item) => item.line_id).filter(Boolean);
      $("#drawerContext").innerHTML = [["Статус", detail.status], ["Доступные линии", lines.join(", ") || "NO_DATA"], ["Evidence freshness", detail.evidence?.state || "NO_DATA"], ["Grouping explanation", detail.reason?.time_window_minutes ? `${detail.reason.time_window_minutes} минутное окно` : "UNKNOWN"]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || "UNKNOWN")}</dd></div>`).join("");
      $("#drawerTimeline").innerHTML = incidents.length ? incidents.map((item) => `<div class="timeline-row"><time>${time(item.started_at)}</time><span class="timeline-dot"></span><p><button type="button" class="text-button situation-member-link" data-line-id="${escapeHtml(item.line_id || "")}">${escapeHtml(item.school_name || item.line_id || "Участник")}</button><br>${escapeHtml(item.status || "UNKNOWN")} · evidence ${escapeHtml(item.evidence?.state || "NO_DATA")}</p></div>`).join("") : `<div class="table-empty">NO_DATA: доступные участники отсутствуют.</div>`;
      $$(".situation-member-link", drawer).forEach((button) => button.addEventListener("click", () => { if (button.dataset.lineId) openLine(button.dataset.lineId); }));
    } catch (error) {
      $("#drawerTitle").textContent = "Ситуация недоступна"; $("#drawerSubtitle").textContent = "Ошибка чтения canonical projection";
      $("#drawerStatus").innerHTML = `<p role="alert">Не удалось загрузить детали. Повторите попытку.</p>`; $("#drawerAxes").innerHTML = ""; $("#drawerTimeline").innerHTML = `<div class="table-empty">Данные недоступны.</div>`;
    }
  }
  async function performSituationAction(situation, action) {
    const reason = window.prompt(`Причина действия ${action} (аудируется, причинность не устанавливается):`, "Ручная корректировка корреляционной группировки") || "";
    if (!reason.trim()) return;
    let body = { reason };
    if (action === "split") {
      const selected = window.prompt("ID incident для новой группы через запятую:", (situation.incident_ids || []).slice(0, 1).join(",")) || "";
      body.incident_ids = selected.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
    } else {
      body.situation_ids = [Number(situation.id)];
    }
    try {
      await apiTry([`/api/situations/${encodeURIComponent(situation.id)}/${action}`, `/api/v1/situations/${encodeURIComponent(situation.id)}/${action}`], { method: "POST", headers: { "Idempotency-Key": `situation-${situation.id}-${action}-${Date.now()}` }, body: JSON.stringify(body) });
      toast(`Ситуация ${action === "merge" ? "объединена" : "разделена"}; история сохранена`);
      await loadData();
      closeDrawer();
    } catch (error) {
      toast(error.status === 409 ? "Ситуация изменилась — действие отклонено, обновите данные" : "Действие ситуации не выполнено", "warn");
    }
  }
  async function openSituationComparison(situation) {
    try {
      const payload = await apiTry([`/api/situations/${encodeURIComponent(situation.id)}/comparison`, `/api/v1/situations/${encodeURIComponent(situation.id)}/comparison`]);
      const result = payload.data || payload;
      const controls = result.controls || [];
      $("#drawerVerdict").innerHTML = `<b>Сравнительная проверка · correlation-only</b><br>${escapeHtml(result.explanation || "Общая причина не устанавливается.")}`;
      $("#drawerAxes").innerHTML = [["Период", `${time(result.period?.from, true)} — ${time(result.period?.to, true)}`], ["Критерии", (result.selection?.same_provider ? "provider · " : "") + (result.selection?.same_district ? "district" : "explicit factors unavailable")], ["Controls", `${controls.length} · ${result.control_completeness?.status || "NO_DATA"}`]].map(([label, value]) => `<div class="axis-card"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>Server-derived historical projection</small></div>`).join("");
      $("#drawerTimeline").innerHTML = controls.length ? controls.map((control) => `<div class="timeline-row"><time>${escapeHtml(control.line_id)}</time><span class="timeline-dot"></span><p><b>${escapeHtml(control.school_id || control.organization_name || "Control")}</b><br>${escapeHtml(control.completeness?.status || "NO_DATA")} · observations ${escapeHtml(String(control.measurement_count || 0))} · valid evidence ${escapeHtml(String(control.valid_evidence_count || 0))}</p></div>`).join("") : `<div class="table-empty">NO_DATA: eligible controls not found in the authorized scope.</div>`;
    } catch (error) {
      toast(error.status === 404 ? "Сравнение недоступно для текущего scope" : "Сравнительная проверка недоступна", "warn");
    }
  }
  async function openDeviceCard(deviceID) {
    try {
      const payload = await apiTry([`/api/devices/${encodeURIComponent(deviceID)}`, `/api/v1/devices/${encodeURIComponent(deviceID)}`]); const device = payload.data || payload; const displayName = device.display_name || device.hostname || device.id; const latest = device.measurements?.[0] || {}; const state = device.state || {}; $("#drawerTitle").textContent = displayName; $("#drawerSubtitle").textContent = `${device.id} · ${device.organization_name || device.school_id || "Школа"} · ${device.line_id}`; $("#drawerStatus").innerHTML = `<span class="status-badge ${statusClass(state.connection_state || device.line_status || device.data_state)}"><i></i>${escapeHtml(statusLabel(state.connection_state || device.line_status || device.data_state))}</span><p>${escapeHtml(state.reason || (latest.quality === "NO_DATA" ? "Нет актуальных измерений" : "Состояние получено от сервера"))}</p>`; $("#drawerAxes").innerHTML = `<div class="axis-card"><span>Точка мониторинга</span><b>${escapeHtml(device.monitoring_point_location || "—")}</b><small>${escapeHtml(device.monitoring_point_id || "—")}</small></div><div class="axis-card"><span>Последняя связь</span><b>${escapeHtml(relative(device.last_seen))}</b><small>Агент ${escapeHtml(device.agent_version || "неизвестен")}</small></div>`; $("#drawerVerdict").textContent = latest.reason || (latest.quality === "NO_DATA" ? "Нет данных для исторического вывода." : "Вердикт и snapshots получены из measurement evaluation."); $("#drawerMetrics").innerHTML = [["Download", number(latest.download, " Мбит/с")], ["Upload", number(latest.upload, " Мбит/с")], ["Ping", number(latest.ping, " мс")], ["Наблюдение", time(latest.observed_at, true)]].map(([label, value]) => `<div class="metric-box"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join(""); $("#drawerContext").innerHTML = [["Device ID", device.id], ["Display name", displayName], ["Hostname", device.hostname || "legacy/не указан"], ["School", device.school_id], ["Line ID", device.line_id], ["Monitoring point", device.monitoring_point_id], ["Расположение", device.monitoring_point_location], ["Провайдер", device.provider_name], ["Последняя связь", time(device.last_seen, true)]].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join(""); $("#drawerDevices").innerHTML = `<small class="table-empty">История устройства загружается постранично из canonical API.</small>`; $("#drawerTimeline").innerHTML = (device.measurements || []).slice(0, 8).map((item) => `<div class="timeline-row"><time>${time(item.observed_at)}</time><span class="timeline-dot"></span><p><b>${escapeHtml(item.quality || item.connection_status || "Измерение")}</b> · ${escapeHtml(item.reason || "snapshot evaluation")}</p></div>`).join("") || `<div class="table-empty">История измерений пуста или недоступна.</div>`; $("#drawerIncident").hidden = true; $("#drawerProvider").hidden = true;
    } catch (error) { toast(error.status === 403 || error.status === 404 ? "Карточка устройства недоступна для текущего scope" : "Карточка устройства недоступна", "warn"); }
  }
  function closeDrawer() { $("#detailDrawer").classList.remove("open"); $("#detailDrawer").setAttribute("aria-hidden", "true"); $("#drawerBackdrop").classList.add("hidden"); }
  async function createManualIncident(line) {
    try { const response = await apiTry(["/api/incidents", "/api/v1/incidents"], { method: "POST", body: JSON.stringify({ line_id: line.id, description: "Инцидент создан оператором для проверки состояния линии", source: "MANUAL" }) }); const incident = response.data || response; state.incidents.unshift({ ...incident, line_id: line.id, school_name: line.school_name, provider: line.provider, status: incident.status || "NEW", source: "MANUAL" }); toast("Инцидент создан и добавлен в timeline"); renderIncidents(); } catch (_) { if (!state.usingDemoData) { toast("Сервер создания инцидента недоступен — объект не создан", "warn"); return; } state.incidents.unshift({ id: `MAN-${Date.now()}`, number: "MAN-NEW", line_id: line.id, school_name: line.school_name, provider: line.provider, status: "NEW", source: "MANUAL", title: "Ручной инцидент", description: "Создан оператором для проверки состояния линии", started_at: new Date().toISOString() }); toast("Инцидент добавлен только в демонстрационный журнал", "warn"); renderIncidents(); }
  }
  async function openCaseModal(incident) {
    const line = state.lines.find((item) => item.id === incident.line_id);
    if (!canSendProvider(line)) return;
    state.currentIncident = incident; $("#caseModalBackdrop").classList.remove("hidden"); $("#reviewConfirm").checked = false; $("#caseSend").disabled = true; $("#draftText").value = "Формируем черновик на основании подтверждённых фактов…";
    $("#caseFacts").innerHTML = [["Инцидент", incident.number || incident.id], ["Школа", incident.school_name], ["Линия", incident.line_id], ["Провайдер", incident.provider]].map(([label, value]) => `<div class="case-fact"><span>${label}</span><b>${escapeHtml(value || "—")}</b></div>`).join("");
    try { const directLine = !incident.id && incident.line_id; const response = directLine ? await apiTry(["/api/provider-cases", "/api/v1/provider-cases"], { method: "POST", body: JSON.stringify({ line_id: incident.line_id, school_id: incident.school_id, provider_id: incident.provider_id, comment: incident.description || "Обращение из карточки линии" }) }) : await apiTry([`/api/incidents/${encodeURIComponent(incident.id)}/provider-case/draft`, `/api/v1/incidents/${encodeURIComponent(incident.id)}/provider-case/draft`], { method: "POST", body: JSON.stringify({}) }); state.currentCaseId = response.id || response.case_id || response.data?.id || null; const fallbackDraft = response.draft || response.draft_text || response.text || response.message || response.data?.draft || response.data?.draft_text; $("#draftText").value = fallbackDraft || templateDraft(incident); if (state.currentCaseId && !state.usingDemoData) { try { const ai = await apiTry([`/api/v1/provider-cases/${encodeURIComponent(state.currentCaseId)}/ai-draft`, `/api/provider-cases/${encodeURIComponent(state.currentCaseId)}/ai-draft`], { method: "POST", headers: { "Idempotency-Key": `case-${state.currentCaseId}-${Date.now()}` }, body: JSON.stringify({}) }); const aiDraft = ai.draft_text || ai.draft || ai.data?.draft_text; if (aiDraft) $("#draftText").value = aiDraft; } catch (_) { toast("AI-черновик недоступен — оставлен редактируемый шаблон", "warn"); } } } catch (_) { state.currentCaseId = null; $("#draftText").value = state.usingDemoData ? templateDraft(incident) : "Серверный черновик недоступен. Обновите данные и повторите попытку."; $("#caseSend").disabled = true; toast(state.usingDemoData ? "Серверный черновик недоступен — показан локальный шаблон" : "Серверный черновик недоступен — отправка заблокирована", "warn"); }
  }
  function templateDraft(incident) { const evidenceLine = incident.source === "MANUAL" ? "Оператор просит проверить состояние линии; этот запрос сам по себе не является доказательством технического нарушения." : "Системой мониторинга зафиксировано подтверждённое отклонение."; return `Уважаемая служба технической поддержки ${incident.provider || "провайдера"}!

По линии ${incident.line_id || "—"}, подключённой в ${incident.school_name || "организации"}, ${evidenceLine}

Период наблюдения: ${time(incident.started_at || new Date().toISOString(), true)}.
Показатели и применённые пороги доступны в карточке инцидента. Просим проверить линию и сообщить номер обращения и результаты устранения.

Текст опирается на наблюдения системы и не является юридическим заключением.`; }
  async function sendCase() {
    const text = $("#draftText").value.trim(); if (!text || !state.currentIncident) return;
    const sendPaths = state.currentCaseId ? [`/api/v1/provider-cases/${encodeURIComponent(state.currentCaseId)}/send`, `/api/provider-cases/${encodeURIComponent(state.currentCaseId)}/send`] : [`/api/incidents/${encodeURIComponent(state.currentIncident.id)}/provider-case/send`, `/api/v1/incidents/${encodeURIComponent(state.currentIncident.id)}/provider-case/send`];
    try { const response = await apiTry(sendPaths, { method: "POST", body: JSON.stringify({ incident_id: state.currentIncident.id, final_text: text, text, reviewed: true }) }); toast(`Обращение ${response.ticket_no || response.ticket_number || response.number || "создано"} отправлено и записано в журнал`); } catch (_) { toast("Серверная отправка недоступна — обращение не отправлено", "warn"); return; }
    closeCaseModal();
  }
  function closeCaseModal() { $("#caseModalBackdrop").classList.add("hidden"); state.currentIncident = null; }
  async function createReplay() { try { await apiTry(["/api/demo/replay", "/api/v1/demo/replay"], { method: "POST", body: JSON.stringify({ scenario: "school-42" }) }); await loadData(); toast("Replay запущен: новые observations проходят тот же state engine"); } catch (_) { if (!state.usingDemoData) { toast("Сервер replay недоступен — новые данные не добавлены", "warn"); return; } const line = state.lines.find((item) => item.id === "L-001"); if (line) { line.status = "UNSTABLE"; line.contract_state = "DEVIATES"; line.latest.download = 41; line.latest.at = new Date().toISOString(); } renderAll(); toast("Replay запущен в демонстрационном режиме", "warn"); } }
  function currentReportParams() { const params = new URLSearchParams({ period: state.filters.period }); ["district", "provider", "technology", "status"].forEach((key) => { if (key !== "status" || !isHistoricalMode()) if (state.filters[key]) params.set(key, state.filters[key]); }); if (state.filters.period === "custom") { ensureCustomDates(); if (state.filters.from) params.set("from", `${state.filters.from}T00:00:00Z`); if (state.filters.to) { const end = new Date(`${state.filters.to}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1); params.set("to", end.toISOString()); } } return params.toString(); }
  function exportColumns(kind = state.export.kind) { return kind === "aggregate" ? [["line_id", "Line ID"], ["measurement_count", "Measurements"], ["average_download", "Avg Download"], ["min_download", "Min Download"], ["max_download", "Max Download"], ["average_upload", "Avg Upload"], ["min_upload", "Min Upload"], ["average_ping", "Avg Ping"], ["min_ping", "Min Ping"], ["problem_measurement_count", "Problems"], ["problem_measurement_percent", "Problem share"], ["availability_percent", "Availability %"]] : [["observed_at", "Observed at"], ["school_id", "School ID"], ["organization_name", "School"], ["device_id", "Device ID"], ["device_display_name", "Device"], ["monitoring_point_id", "Monitoring point"], ["monitoring_point_location", "Location"], ["download", "Download"], ["upload", "Upload"], ["ping", "Ping"], ["jitter", "Jitter"], ["packet_loss", "Packet loss"], ["connection_status", "Connection status"], ["availability_status", "Availability status"]]; }
  function renderExportColumns() { const root = $("#exportColumns"); if (!root) return; const options = exportColumns(); if (!state.export.columns.length) state.export.columns = options.map(([key]) => key); root.innerHTML = options.map(([key, label]) => `<label><input type="checkbox" data-export-column="${escapeHtml(key)}" ${state.export.columns.includes(key) ? "checked" : ""}> ${escapeHtml(label)}</label>`).join(""); $$('[data-export-column]', root).forEach((input) => input.addEventListener("change", () => { state.export.columns = $$('[data-export-column]:checked', root).map((item) => item.dataset.exportColumn); loadExportPreview(); })); }
  function exportParams(preview = false) { const type = state.export.kind; const params = new URLSearchParams({ type, kind: type, format: state.export.format, period: state.filters.period }); ["district", "provider", "technology", "status"].forEach((key) => { if (state.filters[key]) params.set(key, state.filters[key]); }); const school = $("#exportSchool")?.value; if (school) params.set("school_id", school); const devices = $$("#exportDevices option:checked").map((item) => item.value).filter(Boolean); devices.forEach((id) => params.append("device_ids[]", id)); if (state.filters.period === "custom") { const report = new URLSearchParams(currentReportParams()); ["from", "to"].forEach((key) => { if (report.get(key)) params.set(key, report.get(key)); }); } state.export.columns.forEach((column) => params.append("columns[]", column)); if (preview) params.set("preview", "1"); return params; }
  function renderExportOptions(data) { const school = $("#exportSchool"); const selectedSchool = school?.value || ""; if (school) { school.innerHTML = `<option value="">Все школы</option>${(data.schools || []).sort((a, b) => a.name.localeCompare(b.name)).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.id)}</option>`).join("")}`; if ((data.schools || []).some((item) => item.id === selectedSchool)) school.value = selectedSchool; } const devices = $("#exportDevices"); const selectedDevices = new Set($$("option:checked", devices).map((item) => item.value)); if (devices) { devices.innerHTML = `<option value="">Все устройства</option>${(data.devices || []).sort((a, b) => (a.display_name || a.id).localeCompare(b.display_name || b.id)).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.display_name || item.id)} · ${escapeHtml(item.location || "location unknown")}</option>`).join("")}`; $$('option', devices).forEach((item) => { if (selectedDevices.has(item.value)) item.selected = true; }); } }
  async function loadExportPreview() { if (!validCustomPeriod()) return; renderExportColumns(); const params = exportParams(true); try { const payload = await apiTry([`/api/exports/preview?${params}`, `/api/v1/exports/preview?${params}`]); renderExportOptions(payload); $("#exportPreviewSummary").textContent = `${payload.count || 0} строк · ${payload.measurement_count || 0} observations · ${payload.limited ? "лимит превышен, сузьте фильтр" : "scope enforced"}`; } catch (_) { $("#exportPreviewSummary").textContent = "Preview недоступен"; } }
  async function downloadExport(kind = "raw-csv") { if (!validCustomPeriod()) return; if (kind !== "raw-csv" && kind !== "aggregate-csv" && kind !== "aggregate-xlsx") { const [type, format] = kind.split("-"); state.export.kind = type === "aggregate" ? "aggregate" : "raw"; state.export.format = format === "xlsx" ? "xlsx" : "csv"; } const params = exportParams(false); try { const response = await fetch(`/api/exports?${params}`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}, method: "GET" }); if (!response.ok) { const fallback = await fetch(`/api/v1/exports?${params}`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} }); if (!fallback.ok) throw new Error("export"); return consumeDownload(fallback, state.export.kind, state.export.format); } return consumeDownload(response, state.export.kind, state.export.format); } catch (_) { toast("Серверная выгрузка недоступна — файл не создан", "warn"); } }
  async function downloadEvidenceReport() { if (!validCustomPeriod()) return; try { const response = await fetch(`/api/reports/quality-passport/evidence?${currentReportParams()}`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}, method: "GET" }); if (!response.ok) throw new Error("evidence report"); return consumeDownload(response, "evidence-report", "html"); } catch (_) { toast("Исторический evidence report недоступен — файл не создан", "warn"); } }
  async function consumeDownload(response, type, format) { const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `vko-${type}-${new Date().toISOString().slice(0, 10)}.${format}`; link.click(); URL.revokeObjectURL(url); toast(`Выгрузка ${format.toUpperCase()} подготовлена`); }
  async function loadPassport() { if (!validCustomPeriod()) return; const query = currentReportParams(); try { const payload = await apiTry([`/api/reports/quality-passport?${query}`, `/api/v1/reports/quality-passport?${query}`]); const data = payload.data || payload; state.lastPassport = { baseline_rate: data.baseline_compliance, contract_rate: data.contract_compliance, received: data.measurements_received, expected: data.measurements_expected, incident_count: data.incidents?.count, problem_minutes: data.incidents?.total_duration_minutes, incidents: data.incidents, completeness: data.data_completeness, sufficient_data: data.sufficient_data, dynamics: data.dynamics, evidence_chain: data.evidence_chain }; renderPassport({ ...state.lastPassport, analytics: state.analytics }); loadAnalytics(); } catch (_) { renderPassport(state.usingDemoData ? {} : { sufficient_data: false, dynamics: { status: "NO_DATA", reason: "Паспорт качества недоступен" } }); if (!state.usingDemoData) toast("Паспорт качества недоступен — серверный отчёт не получен", "warn"); } }

  const adminResourceConfig = {
    organizations: { label: "организацию", fields: [["id", "ID", "text", true], ["school_id", "School ID", "text"], ["name", "Название", "text"], ["district", "Район / город", "text"], ["address", "Адрес", "text"], ["contact_name", "Ответственный", "text"], ["contact_phone", "Рабочий телефон", "text"], ["contact_role", "Должность", "text"], ["contact_email", "Рабочий email", "email"], ["active", "Активна", "checkbox"]], columns: ["school_id", "name", "district", "contact_name", "contact_updated_at", "active"] },
    providers: { label: "провайдера", fields: [["id", "ID", "text", true], ["name", "Название", "text"], ["support_contact", "Контакт поддержки", "text"], ["active", "Активен", "checkbox"]], columns: ["name", "support_contact", "active"] },
    lines: { label: "линию", fields: [["id", "ID", "text", true], ["organization_id", "Organization ID", "text"], ["provider_id", "Provider ID", "text"], ["role", "Роль (PRIMARY/RESERVE/INACTIVE)", "text"], ["technology", "Технология", "text"], ["status", "Статус (ACTIVE/INACTIVE/DELETED)", "text"]], columns: ["id", "organization_id", "provider_id", "role", "technology", "status"] },
    "monitoring-points": { label: "точку мониторинга", fields: [["id", "ID", "text", true], ["line_id", "Line ID", "text"], ["location", "Расположение", "text"], ["is_primary", "Основная точка", "checkbox"], ["active", "Активна", "checkbox"]], columns: ["id", "line_id", "location", "is_primary", "active"] },
    devices: { label: "устройство", fields: [["device_id", "Device ID", "text"], ["monitoring_point_id", "Monitoring point ID", "text"], ["display_name", "Отображаемое имя", "text"], ["agent_version", "Версия агента", "text"]], columns: ["id", "display_name", "hostname", "organization_name", "line_id", "monitoring_point_id", "last_seen", "agent_version"] },
    users: { label: "пользователя", fields: [["id", "ID", "text", true], ["username", "Логин", "text"], ["role", "Роль", "text"], ["password", "Новый пароль", "password"], ["disabled", "Отключён", "checkbox"], ["scopes_json", "Scopes JSON", "textarea"]], columns: ["username", "role", "disabled", "scopes"] },
    schedule: { label: "расписание", fields: [["tests_per_day", "Performance tests/day (3–5)", "number"], ["jitter_minutes", "Jitter window (minutes)", "number"], ["light_checks_between", "Light checks between", "checkbox"]], columns: ["tests_per_day", "jitter_minutes", "light_checks_between", "updated_at"] },
    policies: { label: "версию порогов", fields: [["scope_type", "Scope type (GLOBAL/LINE)", "text"], ["scope_id", "Scope ID", "text"], ["valid_from", "Valid from (RFC3339)", "text"], ["download_min", "Download min", "number"], ["upload_min", "Upload min", "number"], ["ping_max", "Ping max", "number"], ["jitter_max", "Jitter max", "number"], ["packet_loss_max", "Packet loss max", "number"], ["availability_min", "Availability min", "number"], ["confirm_count", "Confirm count", "number"], ["confirm_duration_minutes", "Confirm duration minutes (optional)", "number"], ["recovery_count", "Recovery count", "number"], ["recovery_minutes", "Recovery minutes", "number"], ["freshness_seconds", "Freshness seconds", "number"]], columns: ["scope_type", "scope_id", "version", "confirm_count", "confirm_duration_minutes", "recovery_count", "created_at"] },
    contracts: { label: "версию договора", fields: [["line_id", "Line ID", "text"], ["contract_no", "Номер договора", "text"], ["contract_date", "Дата договора", "datetime-local"], ["valid_from", "Effective from", "datetime-local"], ["download_min", "Download min", "number"], ["upload_min", "Upload min", "number"], ["ping_max", "Ping max", "number"], ["jitter_max", "Jitter max", "number"], ["packet_loss_max", "Packet loss max", "number"], ["availability_min", "Availability min", "number"], ["reason", "Причина изменения", "text"]], columns: ["line_id", "contract_no", "contract_date", "valid_from", "valid_to", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min", "created_by"] },
    districts: { label: "район", fields: [["id", "ID", "text", true], ["name", "Название", "text"], ["active", "Активен", "checkbox"]], columns: ["id", "name", "active"] },
    technologies: { label: "технологию", fields: [["id", "ID", "text", true], ["name", "Название", "text"], ["active", "Активна", "checkbox"]], columns: ["id", "name", "active"] },
  };
  function adminValue(item, key) { let value = item[key]; if (key === "display_name" && (value == null || value === "")) value = item.hostname || item.id; if (value == null || value === "") return "—"; if (["contract_date", "valid_from", "valid_to", "created_at"].includes(key)) return time(value, true); if (typeof value === "boolean") return value ? "Да" : "Нет"; if (typeof value === "object") return JSON.stringify(value); return String(value); }
  function adminErrorMessage(error, fallback) {
    if (!error) return fallback;
    try { const parsed = JSON.parse(error.message); return parsed.error || parsed.message || fallback; } catch (_) { return error.message || fallback; }
  }
  function renderAdminResourceToolbar() {
    const root = $("#adminResourceToolbar"); if (!root) return;
    if (state.adminResource !== "contracts") { root.hidden = true; root.innerHTML = ""; return; }
    const options = state.lines.slice().sort((left, right) => String(left.id).localeCompare(String(right.id))).map((line) => `<option value="${escapeHtml(line.id)}">${escapeHtml(line.id)} · ${escapeHtml(line.school_name)}</option>`).join("");
    root.hidden = false;
    root.innerHTML = `<label><span class="filter-label">Линия для истории договоров</span><select id="adminContractLineFilter"><option value="">Все линии</option>${options}</select></label><small>История immutable; новая effective version создаётся отдельной записью.</small>`;
    const select = $("#adminContractLineFilter"); select.value = state.adminContractLineID; select.addEventListener("change", () => { state.adminContractLineID = select.value; loadAdminResource("contracts"); });
  }
  function renderContractAdminTable(root, config) {
    if (!state.adminItems.length) { root.innerHTML = `<div class="table-empty">Истории договоров нет.</div>`; return; }
    const labels = { line_id: "Line ID", contract_no: "Номер", contract_date: "Дата договора", valid_from: "Effective from", valid_to: "Effective to", download_min: "Download min", upload_min: "Upload min", ping_max: "Ping max", jitter_max: "Jitter max", packet_loss_max: "Packet loss max", availability_min: "Availability min", created_by: "Создал" };
    root.innerHTML = `<table class="admin-table contract-table"><thead><tr>${config.columns.map((key) => `<th>${escapeHtml(labels[key] || key)}</th>`).join("")}<th>Статус</th></tr></thead><tbody>${state.adminItems.map((item) => { const current = item.valid_to == null; return `<tr class="${current ? "contract-current" : "contract-history"}">${config.columns.map((key) => `<td>${escapeHtml(adminValue(item, key))}</td>`).join("")}<td><span class="status-badge ${current ? "healthy" : "no-data"}"><i></i>${current ? "Текущая" : "Историческая"}</span></td></tr>`; }).join("")}</tbody></table>`;
  }
  async function loadAdminResource(resource = state.adminResource) {
    if (!canAdmin()) return;
    state.adminResource = resource; state.adminEditing = null; state.adminItems = []; renderAdmin();
    const resourcePath = resource === "schedule" ? "schedules" : resource === "districts" || resource === "technologies" ? `catalogs/${resource}` : resource;
    const query = resource === "contracts" && state.adminContractLineID ? `?line_id=${encodeURIComponent(state.adminContractLineID)}` : "";
    try { const payload = await apiTry([`/api/admin/${resourcePath}${query}`, `/api/v1/admin/${resourcePath}${query}`]); state.adminItems = resource === "schedule" ? [payload] : unwrap(payload); renderAdmin(); } catch (error) { $("#adminResourceTable").innerHTML = `<div class="table-empty">Не удалось загрузить реестр. Проверьте права и повторите попытку.</div>`; $("#adminFormError").textContent = error.status === 403 ? "Доступ к реестру запрещён текущей ролью." : adminErrorMessage(error, "Серверный реестр недоступен."); }
  }
  function renderAdmin() {
    const config = adminResourceConfig[state.adminResource]; if (!config) return;
    ensureImpactPreviewUI();
    renderAdminResourceToolbar();
    $$("[data-admin-resource]").forEach((tab) => tab.classList.toggle("active", tab.dataset.adminResource === state.adminResource));
    $("#adminFormTitle").textContent = state.adminResource === "contracts" ? "Новая effective версия договора" : state.adminEditing ? `Изменить ${config.label}` : `Новая ${config.label}`;
    $("#adminFormFields").innerHTML = config.fields.map(([key, label, type, immutable]) => { const value = state.adminEditing ? (state.adminEditing[key] ?? (key === "device_id" ? state.adminEditing.id : key === "scopes_json" ? JSON.stringify(state.adminEditing.scopes || []) : undefined)) : (state.adminResource === "contracts" && key === "line_id" ? state.adminContractLineID : type === "checkbox" ? true : ""); const disabled = state.adminEditing && immutable ? "disabled" : ""; const required = state.adminResource === "contracts" && ["line_id", "valid_from"].includes(key) ? "required" : ""; if (type === "checkbox") return `<label class="admin-check"><input name="${key}" type="checkbox" ${value ? "checked" : ""} ${disabled}/> ${escapeHtml(label)}</label>`; if (type === "textarea") return `<label>${escapeHtml(label)}<textarea name="${key}" rows="3">${escapeHtml(value == null ? "" : value)}</textarea></label>`; return `<label>${escapeHtml(label)}<input name="${key}" type="${type}" value="${escapeHtml(value == null ? "" : value)}" ${disabled} ${required}/></label>`; }).join("");
    const root = $("#adminResourceTable"); if (!state.adminItems.length) { root.innerHTML = `<div class="table-empty">${state.adminResource === "contracts" ? "Истории договоров нет." : "Записей нет"}</div>`; return; }
    if (state.adminResource === "contracts") { renderContractAdminTable(root, config); return; }
    root.innerHTML = `<table class="admin-table"><thead><tr>${config.columns.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}<th></th></tr></thead><tbody>${state.adminItems.map((item, index) => { const deviceActions = state.adminResource === "devices" ? `<button type="button" class="row-action" data-admin-action="${item.blocked ? "unblock" : "block"}" data-admin-id="${escapeHtml(item.id)}">${item.blocked ? "Разблокировать" : "Заблокировать"}</button><button type="button" class="row-action" data-admin-action="rotate-token" data-admin-id="${escapeHtml(item.id)}">Новый токен</button>` : ""; return `<tr>${config.columns.map((key) => `<td>${escapeHtml(adminValue(item, key))}</td>`).join("")}<td><button type="button" class="row-action" data-admin-edit="${index}">Изменить</button>${deviceActions}</td></tr>`; }).join("")}</tbody></table>`;
    $$("[data-admin-edit]", root).forEach((button) => button.addEventListener("click", () => { state.adminEditing = state.adminItems[Number(button.dataset.adminEdit)]; renderAdmin(); $("#adminResourceForm").scrollIntoView({ behavior: "smooth", block: "nearest" }); }));
    $$("[data-admin-action]", root).forEach((button) => button.addEventListener("click", () => adminDeviceAction(button.dataset.adminId, button.dataset.adminAction)));
  }
  function ensureImpactPreviewUI() {
    const header = $("#adminView .panel-header"); if (!header || $("#adminImpactPreview")) return;
    const button = document.createElement("button"); button.id = "adminImpactPreview"; button.className = "button button-quiet"; button.textContent = "Предпросмотр влияния"; button.type = "button";
    header.appendChild(button);
    const panel = document.createElement("section"); panel.id = "impactPreviewPanel"; panel.className = "admin-preview-panel"; panel.hidden = true; panel.innerHTML = `<div class="panel-kicker">СИМУЛЯЦИЯ · БЕЗ ПРИМЕНЕНИЯ</div><p>Результат рассчитан по историческим snapshots и не меняет текущие пороги, LineState или инциденты.</p><label>Новый Download min <input id="impactPreviewDownload" type="number" min="0" step="0.1" value="20"></label><button id="impactPreviewRun" class="button button-primary" type="button">Рассчитать</button><div id="impactPreviewResult" class="table-empty">Предпросмотр не запускался.</div>`;
    $("#adminView .admin-console").before(panel);
    $("#impactPreviewRun").addEventListener("click", runImpactPreview);
    button.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  }
  async function runImpactPreview() {
    const result = $("#impactPreviewResult"); const lines = state.lines.filter((line) => line.id).slice(0, 20); const end = new Date(); const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000); const download = Number($("#impactPreviewDownload").value);
    result.textContent = "Считаем историческую симуляцию…";
    try {
      const payload = await apiTry(["/api/admin/impact-preview", "/api/v1/admin/impact-preview"], { method: "POST", body: JSON.stringify({ line_ids: lines.map((line) => line.id), from: start.toISOString(), to: end.toISOString(), idempotency_key: `ui-${Date.now()}`, policy: { download_min: download } }) });
      const summary = payload.result || {}; result.innerHTML = `<strong>Предпросмотр, не применено</strong><br>Линий: ${escapeHtml(String(summary.affected_lines?.length || 0))} · Изменённых наблюдений: ${escapeHtml(String(summary.changed_measurements || 0))} · Проектируемых нарушений: ${escapeHtml(String(summary.projected_incident_measurements || 0))}<br><small>Источник: ${escapeHtml(payload.source_period?.from || "—")} — ${escapeHtml(payload.source_period?.to || "—")}; production truth: ${escapeHtml(payload.actual_truth || "UNKNOWN")}</small>`;
    } catch (error) { result.textContent = error.status === 403 ? "Предпросмотр доступен только администратору." : "Предпросмотр не выполнен; текущая конфигурация не изменена."; }
  }
  async function adminDeviceAction(id, action) {
    try { const response = await apiTry([`/api/admin/devices/${encodeURIComponent(id)}/${action}`, `/api/v1/admin/devices/${encodeURIComponent(id)}/${action}`], { method: "POST" }); if (response?.device_token) toast(`Новый токен: ${response.device_token}`, "warn"); await loadAdminResource("devices"); } catch (error) { $("#adminFormError").textContent = error.status === 403 ? "Действие запрещено текущей ролью или scope." : "Операция устройства не выполнена."; }
  }
  async function saveAdminResource(event) {
    event.preventDefault(); const config = adminResourceConfig[state.adminResource]; const form = event.currentTarget; const payload = {};
    config.fields.forEach(([key, , type]) => { const input = form.elements[key]; if (!input || (state.adminEditing && key === "id")) return; payload[key] = type === "checkbox" ? input.checked : type === "number" ? (input.value.trim() === "" ? null : Number(input.value)) : type === "datetime-local" ? (input.value.trim() === "" ? null : new Date(input.value).toISOString()) : input.value.trim(); });
    if (state.adminResource === "lines" && !payload.provider_id) payload.provider_id = null;
    if (state.adminResource === "users") { try { payload.scopes = payload.scopes_json ? JSON.parse(payload.scopes_json) : []; } catch (_) { $("#adminFormError").textContent = "Scopes JSON имеет неверный формат."; return; } delete payload.scopes_json; }
    if (state.adminResource === "policies" && payload.confirm_duration_minutes === "") payload.confirm_duration_minutes = null;
    const resourceID = state.adminEditing?.id || state.adminEditing?.device_id;
    const resourcePath = state.adminResource === "schedule" ? "schedules" : state.adminResource === "districts" || state.adminResource === "technologies" ? `catalogs/${state.adminResource}` : state.adminResource;
    const versionedResource = state.adminResource === "policies" || state.adminResource === "contracts";
    const path = state.adminResource === "devices" && !state.adminEditing ? "/api/admin/devices/register" : `/api/admin/${resourcePath}${resourceID && !versionedResource ? `/${encodeURIComponent(resourceID)}` : ""}`;
    try { const response = await apiTry([path, path.replace("/api/", "/api/v1/")], { method: versionedResource ? "POST" : resourceID ? "PUT" : "POST", body: JSON.stringify(payload) }); state.adminEditing = null; $("#adminFormError").textContent = response?.device_token ? "Устройство зарегистрировано; токен показан только сейчас." : ""; await loadAdminResource(state.adminResource); } catch (error) { $("#adminFormError").textContent = error.status === 409 ? adminErrorMessage(error, "Effective interval пересекается с существующей версией; история сохранена, новая версия не создана.") : error.status === 403 ? "Действие запрещено текущей ролью или scope." : adminErrorMessage(error, "Не удалось сохранить изменения."); await loadAdminResource(state.adminResource); }
  }

  function showView(view) {
    if (view === "admin" && !canAdmin()) return;
    const isOverview = view === "overview" || view === "lines";
    ["incidents", "notifications", "reports", "audit", "admin"].forEach((name) => { const element = $(`#${name}View`); if (element) element.classList.toggle("hidden", view !== name); });
    $("#linesSection").classList.toggle("hidden", !isOverview);
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view || (view === "lines" && item.dataset.view === "overview")));
    if (view === "reports") { loadPassport(); loadExportPreview(); }
    if (view === "audit") { renderAudit(); loadAudit(true); loadAgentVersions(); }
    if (view === "incidents") renderIncidents();
    if (view === "notifications") { renderNotifications(); if (!state.notifications.length) loadNotifications(true); }
    if (view === "admin") loadAdminResource(state.adminResource);
    if (view !== "overview" && window.innerWidth <= 960) $(".rail").classList.remove("open");
  }
  function toast(message, tone = "") { const node = document.createElement("div"); node.className = `toast ${tone}`; node.textContent = message; $("#toastRegion").appendChild(node); setTimeout(() => node.remove(), 4200); }

  function bindEvents() {
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
    $("#menuToggle").addEventListener("click", () => $(".rail").classList.add("open")); $("#railClose").addEventListener("click", () => $(".rail").classList.remove("open"));
    $("#refreshButton").addEventListener("click", () => loadData()); $("#demoButton").addEventListener("click", createReplay); $("#exportButton").addEventListener("click", () => downloadExport("raw-csv")); $("#noticeDismiss").addEventListener("click", () => $("#noticeBar").classList.add("hidden"));
    $("#notificationRefresh").addEventListener("click", () => loadNotifications(true)); $("#notificationLoadMore").addEventListener("click", () => loadNotifications(false));
    $("#auditRefresh").addEventListener("click", () => { loadAudit(true); loadAgentVersions(); }); $("#auditLoadMore").addEventListener("click", () => loadAudit(false)); $("#auditReset").addEventListener("click", () => { state.auditFilters = { action: "", object_type: "", object_id: "" }; ["auditActionFilter", "auditObjectTypeFilter", "auditObjectIdFilter"].forEach((id) => { $("#" + id).value = ""; }); loadAudit(true); }); ["auditActionFilter", "auditObjectTypeFilter", "auditObjectIdFilter"].forEach((id) => $("#" + id).addEventListener("change", () => { state.auditFilters = { action: $("#auditActionFilter").value.trim(), object_type: $("#auditObjectTypeFilter").value.trim(), object_id: $("#auditObjectIdFilter").value.trim() }; loadAudit(true); }));
    $("#adminRefresh").addEventListener("click", () => loadAdminResource(state.adminResource)); $("#adminFormReset").addEventListener("click", () => { state.adminEditing = null; $("#adminFormError").textContent = ""; renderAdmin(); }); $("#adminResourceForm").addEventListener("submit", saveAdminResource); $$("[data-admin-resource]").forEach((tab) => tab.addEventListener("click", () => loadAdminResource(tab.dataset.adminResource)));
    $("#passportButton").addEventListener("click", () => showView("reports"));
    $("#exportKind").addEventListener("change", (event) => { state.export.kind = event.target.value; state.export.columns = []; renderExportColumns(); loadExportPreview(); }); $("#exportFormat").addEventListener("change", (event) => { state.export.format = event.target.value; loadExportPreview(); }); $("#exportSchool").addEventListener("change", loadExportPreview); $("#exportDevices").addEventListener("change", loadExportPreview); $("#exportPreview").addEventListener("click", loadExportPreview); $("#exportDownload").addEventListener("click", () => downloadExport()); $("#evidenceReportDownload").addEventListener("click", downloadEvidenceReport);
    $("#drawerClose").addEventListener("click", closeDrawer); $("#drawerBackdrop").addEventListener("click", closeDrawer); $("#mapPopupClose").addEventListener("click", () => closeMapPopup()); document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#mapPopup").classList.contains("hidden")) closeMapPopup(); }); $("#caseModalClose").addEventListener("click", closeCaseModal); $("#caseCancel").addEventListener("click", closeCaseModal); $("#caseSend").addEventListener("click", sendCase);
    $("#reviewConfirm").addEventListener("change", (event) => { $("#caseSend").disabled = !event.target.checked; }); $("#draftText").addEventListener("input", () => { $("#reviewConfirm").checked = false; $("#caseSend").disabled = true; });
    $("#manualIncidentButton").addEventListener("click", () => { const line = state.lines[0]; if (line) createManualIncident(line); });
    $("#searchInput").addEventListener("input", (event) => { state.filters.search = event.target.value; renderMap(); renderLines(); }); $("#mapListMode").addEventListener("change", (event) => { state.filters.mapMode = event.target.value; state.historicalByLine = {}; state.historicalError = null; renderMap(); renderLines(); if (isHistoricalMode()) loadHistoricalPeriod(); }); $("#districtFilter").addEventListener("change", (event) => { state.filters.district = event.target.value; renderMap(); renderLines(); loadPassport(); if (isHistoricalMode()) loadHistoricalPeriod(); }); $("#providerFilter").addEventListener("change", (event) => { state.filters.provider = event.target.value; renderMap(); renderLines(); loadPassport(); if (isHistoricalMode()) loadHistoricalPeriod(); }); $("#technologyFilter").addEventListener("change", (event) => { state.filters.technology = event.target.value; renderMap(); renderLines(); loadPassport(); if (isHistoricalMode()) loadHistoricalPeriod(); }); $("#statusFilter").addEventListener("change", (event) => { state.filters.status = event.target.value; renderMap(); renderLines(); loadPassport(); if (isHistoricalMode()) loadHistoricalPeriod(); }); $("#periodFilter").addEventListener("change", (event) => { state.filters.period = event.target.value; if (state.filters.period === "custom") ensureCustomDates(); toggleCustomPeriod(); renderLines(); loadPassport(); if (isHistoricalMode()) loadHistoricalPeriod(); else showView("reports"); }); ["fromDateFilter", "toDateFilter"].forEach((id) => $("#" + id).addEventListener("change", (event) => { state.filters[id === "fromDateFilter" ? "from" : "to"] = event.target.value; loadPassport(); if (validCustomPeriod()) { if (isHistoricalMode()) loadHistoricalPeriod(); else showView("reports"); } })); $("#resetFilters").addEventListener("click", () => { state.filters = { ...state.filters, search: "", district: "", provider: "", technology: "", status: "", period: "week", from: "", to: "", view: "lines", mapMode: "current" }; state.historicalByLine = {}; state.historicalError = null; $("#searchInput").value = ""; populateFilters(); renderMap(); renderLines(); loadPassport(); });
    const viewToggle = $(".view-toggle"); if (viewToggle && !viewToggle.querySelector('[data-table-view="schools"]')) { const schoolsButton = document.createElement("button"); schoolsButton.className = "toggle"; schoolsButton.dataset.tableView = "schools"; schoolsButton.textContent = "Школы"; viewToggle.insertBefore(schoolsButton, viewToggle.children[1] || null); }
    $$("[data-table-view]").forEach((button) => button.addEventListener("click", () => { state.filters.view = button.dataset.tableView; $$("[data-table-view]").forEach((item) => item.classList.toggle("active", item === button)); renderLines(); }));
    $$("[data-export]").forEach((button) => button.addEventListener("click", () => downloadExport(button.dataset.export)));
    $("#loadMore").addEventListener("click", () => { state.lineLimit += 30; renderLines(); });
    const loginForm = $("#loginForm"); if (loginForm) loginForm.addEventListener("submit", async (event) => { event.preventDefault(); const submit = $("#loginSubmit"); submit.disabled = true; try { await login(false, { username: $("#loginUsername").value.trim(), password: $("#loginPassword").value }); if (state.apiOnline) { await loadData(); await loadPassport(); } } finally { submit.disabled = false; } });
    [["mapZoomIn", "zoomIn"], ["mapZoomOut", "zoomOut"], ["mapReset", "resetView"]].forEach(([id, action]) => { const button = $(`#${id}`); if (button) button.addEventListener("click", () => { const map = window.LinkwatchMap?.getMap(); if (!map) return; if (action === "resetView") window.LinkwatchMap.resetView(); else map[action](); }); });
  }
  async function boot() { window.LinkwatchMap?.init({ containerId: "leafletMap" }); bindEvents(); if (state.token) await loadUserProfile(); if (!state.token && !state.demoMode) showLogin(); applyCapabilities(); await loadData(); await loadPassport(); }
  document.addEventListener("DOMContentLoaded", boot);
})();
