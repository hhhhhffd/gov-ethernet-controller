/* LINKWATCH — small dependency-free ops surface. Verdicts come from the API; this file only presents them. */
(function () {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const state = {
    token: localStorage.getItem("vko_token") || "",
    user: null,
    lines: [],
    incidents: [],
    situations: [],
    audit: [],
    filters: { search: "", district: "", provider: "", technology: "", status: "", period: "week", from: "", to: "", view: "lines" },
    currentLine: null,
    currentIncident: null,
    currentCaseId: null,
    apiOnline: false,
    usingDemoData: false,
    // Demo data is opt-in per URL, never persisted across environments.
    demoMode: new URLSearchParams(window.location.search).get("demo") === "1",
    lineLimit: 30,
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
  function role() { return String(state.user?.role || "").toUpperCase(); }
  function demoCapabilities() { return state.usingDemoData && !state.user; }
  function scopeEntries() { return Array.isArray(state.user?.scopes) ? state.user.scopes : []; }
  function lineInScope(line) {
    if (demoCapabilities() || ["ADMIN", "OBLAST"].includes(role())) return true;
    return scopeEntries().some((scope) => {
      const type = String(scope.scope_type || scope.type || "").toUpperCase();
      const id = String(scope.scope_id || scope.id || "");
      return (type === "LINE" && id === String(line.id)) || (type === "ORGANIZATION" && [line.organization_id, line.school_id].map(String).includes(id)) || (type === "DISTRICT" && role() === "DISTRICT" && id === String(line.district)) || (type === "PROVIDER" && role() === "PROVIDER" && id === String(line.provider_id || line.provider));
    });
  }
  function canAdmin() { return demoCapabilities() || role() === "ADMIN"; }
  function canSendProvider(line) { return (demoCapabilities() || ["ADMIN", "OBLAST", "DISTRICT", "PROVIDER"].includes(role())) && (!line || lineInScope(line)); }
  function applyCapabilities() {
    const admin = $("[data-view='admin']"); if (admin) admin.hidden = !canAdmin();
    const replay = $("#demoButton"); if (replay) replay.hidden = !canAdmin();
    const manual = $("#manualIncidentButton"); if (manual) manual.hidden = !state.user && !demoCapabilities();
    $$("[data-provider-action]").forEach((button) => { button.hidden = !canSendProvider(button._line || null); });
  }
  async function loadUserProfile() {
    if (!state.token) return;
    try { const response = await apiTry(["/api/auth/me", "/api/v1/auth/me", "/api/me", "/api/v1/me"]); state.user = response.user || response; updateUser(); } catch (_) { /* login user shape is still enough for the coarse gate */ }
  }

  async function loadData() {
    let lines, incidents, situations, overview, audit;
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
      state.lines = unwrap(lines).map(normalizeLine);
      state.incidents = unwrap(incidents).map((item) => ({ ...item, number: item.number || item.id, school_name: item.school_name || item.school?.name || "—", provider: item.provider_name || item.provider?.name || "—", district: item.district || item.school?.district || "—" }));
      state.situations = unwrap(situations);
      state.audit = unwrap(audit);
      renderOverview(overview || {});
      state.usingDemoData = false;
    } catch (error) {
      state.usingDemoData = state.demoMode;
      state.lines = state.demoMode ? sampleLines.map(normalizeLine) : [];
      state.incidents = state.demoMode ? sampleIncidents.slice() : [];
      state.situations = state.demoMode ? sampleSituations.slice() : [];
      renderOverview(state.demoMode ? { schools: 128, active_devices: 117, problem_lines: 9, completeness: 94 } : { counts: { schools: 0, lines: 0, active_devices: 0, problem_lines: 0 }, completeness: 0 });
      $("#noticeTitle").textContent = state.demoMode ? "Демо-срез: сервер мониторинга недоступен" : "Сервер мониторинга недоступен";
      $("#noticeText").textContent = state.demoMode ? "Показаны учебные данные. Не используйте их для операционных решений или официальной выгрузки." : "Текущая картина и официальные выгрузки недоступны. Проверьте соединение и повторите обновление.";
    }
    populateFilters();
    applyCapabilities();
    renderAll();
    $("#lastSync").textContent = time(new Date().toISOString());
  }
  function renderOverview(data) {
    const schools = (data.schools ?? data.organization_count ?? data.counts?.schools ?? new Set(state.lines.map((line) => line.school_id)).size) || 0;
    const devices = data.active_devices ?? data.active_points ?? data.devices ?? data.counts?.active_devices ?? state.lines.length;
    const problems = data.problem_lines ?? data.problems ?? data.counts?.problem_lines ?? state.lines.filter((line) => ["critical", "unstable"].includes(statusClass(line.status))).length;
    const completeness = data.completeness ?? data.data_completeness ?? data.data_completeness_pct ?? 94;
    $("#kpiSchools").textContent = number(schools);
    $("#kpiDevices").textContent = number(devices);
    $("#kpiProblems").textContent = number(problems);
    $("#kpiCompleteness").innerHTML = `${number(completeness)}<em>%</em>`;
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
    districtSelect.value = state.filters.district; providerSelect.value = state.filters.provider; technologySelect.value = state.filters.technology; $("#statusFilter").value = state.filters.status; $("#fromDateFilter").value = state.filters.from; $("#toDateFilter").value = state.filters.to; toggleCustomPeriod();
  }
  function dateValue(date) { return new Date(date).toISOString().slice(0, 10); }
  function toggleCustomPeriod() { const controls = $("#customPeriodControls"); if (controls) controls.hidden = state.filters.period !== "custom"; }
  function ensureCustomDates() { if (!state.filters.from || !state.filters.to) { const end = new Date(); state.filters.to = dateValue(end); state.filters.from = dateValue(new Date(end.getTime() - 6 * 86400000)); } const from = $("#fromDateFilter"); const to = $("#toDateFilter"); if (from) from.value = state.filters.from; if (to) to.value = state.filters.to; }
  function validCustomPeriod() { if (state.filters.period !== "custom" || !state.filters.from || !state.filters.to || state.filters.from <= state.filters.to) return true; toast("Дата начала должна быть не позже даты окончания", "warn"); return false; }
  function filteredLines() {
    const query = state.filters.search.trim().toLowerCase();
    return state.lines.filter((line) => {
      const matchesQuery = !query || [line.id, line.school_id, line.school_name, line.district, line.provider].some((value) => String(value || "").toLowerCase().includes(query));
      const matchesDistrict = !state.filters.district || line.district === state.filters.district;
      const matchesProvider = !state.filters.provider || line.provider === state.filters.provider;
      const matchesTechnology = !state.filters.technology || line.technology === state.filters.technology;
      const normalizedStatus = String(line.status || "").toUpperCase() === "UNSTABLE" ? "DEGRADED" : String(line.status || "").toUpperCase();
      const matchesStatus = !state.filters.status || normalizedStatus === state.filters.status;
      const matchesView = state.filters.view === "attention" ? ["critical", "unstable"].includes(statusClass(line.status)) : state.filters.view === "stale" ? statusClass(line.data_state) === "no-data" : true;
      return matchesQuery && matchesDistrict && matchesProvider && matchesTechnology && matchesStatus && matchesView;
    });
  }
  function renderAll() { renderMap(); renderSituations(); renderLines(); renderActivity(); renderIncidents(); renderPassport(); $("#situationCount").textContent = state.situations.length; $("#mapVisibleCount").textContent = filteredLines().length; $("#lineCount").textContent = state.lines.length; }
  function renderMap() {
    const root = $("#mapMarkers"); if (!root) return;
    const rows = filteredLines();
    $("#mapVisibleCount").textContent = rows.length;
    root.innerHTML = rows.map((line, index) => { const coords = Array.isArray(line.coordinates) ? line.coordinates : [190 + (index * 59) % 320, 110 + (index * 37) % 170]; const cls = statusClass(line.status); return `<g class="map-marker ${cls}" data-line-id="${escapeHtml(line.id)}" tabindex="0" role="button" aria-label="${escapeHtml(line.school_name)} — ${escapeHtml(statusLabel(line.status))}" transform="translate(${Number(coords[0]) || 0} ${Number(coords[1]) || 0})"><circle class="halo" r="13"></circle><circle class="core" r="5"></circle><text x="9" y="3">${escapeHtml(line.school_name.replace(/^(Средняя |Городская )?школа(а)?\s*/i, "").slice(0, 14))}</text></g>`; }).join("");
    $$(".map-marker", root).forEach((marker) => { marker.addEventListener("click", () => openLine(marker.dataset.lineId)); marker.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openLine(marker.dataset.lineId); } }); });
  }
  function renderSituations() {
    const root = $("#situationsList"); if (!state.situations.length) { root.innerHTML = `<div class="table-empty">Нет подтверждённых ситуаций</div>`; return; }
    root.innerHTML = state.situations.slice(0, 4).map((situation) => `<article class="situation-card" data-situation-id="${escapeHtml(situation.id)}"><i class="severity-mark ${statusClass(situation.severity || situation.status)}"></i><div><span class="situation-title">${escapeHtml(situation.title || situation.name || "Связанные нарушения")}</span><span class="situation-meta">${escapeHtml(situation.meta || `${situation.provider || "—"} · ${situation.affected_count || 0} линий`)} · <b>${escapeHtml(situation.reason || "Возможная связь")}</b></span></div><time class="situation-time">${time(situation.started_at || situation.start_at)}</time></article>`).join("");
    $$(".situation-card", root).forEach((card) => card.addEventListener("click", () => showView("incidents")));
  }
  function renderLines() {
    const rows = filteredLines(); const root = $("#linesTableBody");
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
  function renderIncidents() {
    const root = $("#incidentBoard"); if (!state.incidents.length) { root.innerHTML = `<div class="table-empty">Инцидентов нет</div>`; return; }
    root.innerHTML = state.incidents.map((incident) => { const closed = String(incident.status).toUpperCase() === "CLOSED"; const line = state.lines.find((item) => item.id === incident.line_id); const providerAction = !closed && canSendProvider(line) ? `<button class="button button-primary" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="draft">Обращение →</button>` : ""; return `<article class="incident-card ${statusClass(incident.severity)}"><div class="incident-top"><span class="incident-number">${escapeHtml(incident.number || incident.id)} · ${escapeHtml(incident.source === "MANUAL" ? "создан вручную" : "автоматически")}</span><span class="status-badge ${closed ? "healthy" : statusClass(incident.severity)}"><i></i>${escapeHtml(incidentStatusLabel(incident.status))}</span></div><h3>${escapeHtml(incident.title || incident.description || "Инцидент на линии")}</h3><p>${escapeHtml(incident.school_name)} · ${escapeHtml(incident.provider)} · ${escapeHtml(incident.description || "")}</p><div class="incident-meta"><span class="axis-chip">Начало ${escapeHtml(time(incident.started_at || incident.start_time))}</span><span class="axis-chip">${incident.duration_minutes ? `Длительность ${number(incident.duration_minutes, " мин")}` : "В работе"}</span></div><div class="incident-action"><button class="button button-quiet" data-incident-id="${escapeHtml(incident.id)}" data-incident-action="open">Открыть timeline</button>${providerAction}</div></article>`; }).join("");
    $$("[data-incident-action]", root).forEach((button) => button.addEventListener("click", () => { const incident = state.incidents.find((item) => item.id === button.dataset.incidentId); if (!incident) return; if (button.dataset.incidentAction === "draft") openCaseModal(incident); else { const line = state.lines.find((item) => item.id === incident.line_id); if (line) openLine(line.id); else toast("Timeline инцидента доступна в API", "warn"); } }));
  }
  function incidentStatusLabel(status) { return ({ NEW: "Новый", SENT_TO_PROVIDER: "Передан провайдеру", IN_PROGRESS: "В работе", WAITING_INFO: "Ожидает информации", RESOLVED: "Устранён · проверка", CLOSED: "Закрыт" }[String(status || "").toUpperCase()] || status || "Новый"); }
  function renderPassport(data = {}) { const root = $("#passportGrid"); const values = Object.keys(data).length || !state.usingDemoData ? data : { baseline_rate: 91, contract_rate: 68, received: 121, expected: 124, incident_count: 2, problem_minutes: 460, trend: "Стабильно", completeness: 94, ...data }; if (values.completeness != null) $("#qualityScore").textContent = number(values.completeness); if (values.baseline_rate != null) $("#baselineRate").textContent = `${number(values.baseline_rate)}%`; if (values.contract_rate != null) $("#contractRate").textContent = `${number(values.contract_rate)}%`; $("#recoveryRate").textContent = state.usingDemoData ? "87%" : "—"; const noteTitle = $(".quality-note b"); const noteText = $(".quality-note small"); if (noteTitle) noteTitle.textContent = values.sufficient_data === false ? "Недостаточно данных для вывода" : "Данных достаточно для вывода"; if (noteText) noteText.textContent = values.received != null && values.expected != null ? `${values.received} из ${values.expected} ожидаемых наблюдений за период` : "Ожидаемые и полученные наблюдения пока не рассчитаны"; const cards = [{ label: "Базовый норматив", value: `${values.baseline_rate ?? 0}%`, note: "наблюдений соответствуют" }, { label: "Договорный ориентир", value: `${values.contract_rate ?? 0}%`, note: "наблюдений соответствуют" }, { label: "Полнота данных", value: values.received != null && values.expected != null ? `${values.received} / ${values.expected}` : "Нет данных", note: "ожидаемых наблюдений" }, { label: "Подтверждённые случаи", value: values.incident_count ?? 0, note: "за выбранный период" }, { label: "Суммарная длительность", value: values.problem_minutes != null ? `${Math.round(values.problem_minutes)} мин` : "Нет данных", note: "подтверждённых нарушений" }, { label: "Динамика", value: values.trend || (values.sufficient_data === false ? "Недостаточно данных" : "Стабильно"), note: "к предыдущему периоду" }]; root.innerHTML = cards.map((card) => `<div class="passport-item"><span>${escapeHtml(card.label)}</span><b>${escapeHtml(card.value)}</b><small>${escapeHtml(card.note)}</small></div>`).join(""); }

  async function openLine(id) {
    const line = state.lines.find((item) => item.id === id); if (!line) return;
    let detail = line;
    if (!state.usingDemoData) { try { const response = await apiTry([`/api/lines/${encodeURIComponent(id)}`, `/api/v1/lines/${encodeURIComponent(id)}`]); detail = normalizeLine({ ...line, ...(response.data || response) }); } catch (_) { /* list data is enough to open the drawer */ } }
    state.currentLine = detail;
    $("#drawerTitle").textContent = detail.school_name;
    $("#drawerSubtitle").textContent = `${detail.id} · ${detail.role} линия · ${detail.provider}`;
    const cls = statusClass(detail.status);
    $("#drawerStatus").innerHTML = `<span class="status-badge ${cls}"><i></i>${escapeHtml(statusLabel(detail.status))}</span><p>${escapeHtml(detail.reason)}</p>`;
    const m = detail.latest || {};
    const policy = m.policy_snapshot || detail.policy || {};
    const contract = m.contract_snapshot || detail.contract || {};
    $(".effective-pill").textContent = policy.version ? `Policy v${policy.version}` : "Policy не определена";
    $("#drawerAxes").innerHTML = `<div class="axis-card ${statusClass(detail.quality_state) === "unstable" ? "warn" : ""}"><span>Качество соединения</span><b>${escapeHtml(axisLabel(detail.quality_state))}</b><small>Базовый норматив · ↓${number(policy.download_min)} ↑${number(policy.upload_min)} · Ping ≤${number(policy.ping_max)}</small></div><div class="axis-card ${statusClass(detail.contract_state) === "unstable" ? "warn" : ""}"><span>Договорный ориентир</span><b>${escapeHtml(axisLabel(detail.contract_state))}</b><small>${contract.download_min != null ? `Download ${number(contract.download_min, " Мбит/с")}` : "Параметры не указаны"}</small></div>`;
    $("#drawerVerdict").textContent = detail.reason || "Вывод рассчитан на backend по серии наблюдений и effective policy.";
    $("#drawerMetrics").innerHTML = [["Download", number(m.download, " Мбит/с")], ["Upload", number(m.upload, " Мбит/с")], ["Ping", number(m.ping, " мс")], ["Jitter", number(m.jitter, " мс")], ["Packet Loss", number(m.loss, "%")], ["Наблюдение", time(m.at, true)]].map(([label, value]) => `<div class="metric-box"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("");
    $("#drawerContext").innerHTML = [["School ID", detail.school_id], ["Адрес", detail.address], ["Ответственный", detail.contact_name], ["Телефон школы", detail.contact_phone], ["Line ID", detail.id], ["Район", detail.district], ["Провайдер", detail.provider], ["Поддержка провайдера", detail.support_contact], ["Тип подключения", detail.technology], ["Роль линии", detail.role], ["Effective policy", policy.version ? `v${policy.version} · ${policy.scope_type || "GLOBAL"}` : "Не определена"], ["Договор", contract.contract_no || "Не указан"], ["Monitoring point", detail.device_id || "—"], ["Агент", detail.agent_version || "—"], ["Последняя связь", time(detail.last_seen || m.at, true)]].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    const related = state.incidents.filter((incident) => incident.line_id === detail.id); const events = related.flatMap((incident) => (incident.actions || []).map((item) => ({ at: item.at, text: item.text }))).slice(-4); if (!events.length) events.push({ at: m.at, text: "Последнее наблюдение получено" }, { at: new Date(new Date(m.at || Date.now()).getTime() - 3600000).toISOString(), text: "Состояние рассчитано по серии observations" });
    $("#drawerTimeline").innerHTML = events.map((item) => `<div class="timeline-row"><time>${time(item.at)}</time><span class="timeline-dot"></span><p><b>${escapeHtml(item.text)}</b></p></div>`).join("");
    $("#drawerBackdrop").classList.remove("hidden"); $("#detailDrawer").classList.add("open"); $("#detailDrawer").setAttribute("aria-hidden", "false");
    $("#drawerIncident").hidden = !state.user && !demoCapabilities();
    $("#drawerProvider").hidden = !canSendProvider(detail);
    $("#drawerIncident").onclick = () => { if (state.user || demoCapabilities()) createManualIncident(detail); };
    $("#drawerProvider").onclick = () => { if (!canSendProvider(detail)) return; const incident = related.find((item) => item.status !== "CLOSED") || related[0] || { line_id: detail.id, school_name: detail.school_name, provider: detail.provider, description: detail.reason, status: "NEW" }; openCaseModal(incident); };
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
    try { const response = await apiTry([`/api/incidents/${encodeURIComponent(incident.id)}/provider-case/draft`, `/api/v1/incidents/${encodeURIComponent(incident.id)}/provider-case/draft`], { method: "POST", body: JSON.stringify({}) }); state.currentCaseId = response.id || response.case_id || response.data?.id || null; const draft = response.draft || response.draft_text || response.text || response.message || response.data?.draft || response.data?.draft_text; $("#draftText").value = draft || templateDraft(incident); } catch (_) { state.currentCaseId = null; $("#draftText").value = state.usingDemoData ? templateDraft(incident) : "Серверный черновик недоступен. Обновите данные и повторите попытку."; $("#caseSend").disabled = true; toast(state.usingDemoData ? "Серверный черновик недоступен — показан локальный шаблон" : "Серверный черновик недоступен — отправка заблокирована", "warn"); }
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
  function currentReportParams() { const params = new URLSearchParams({ period: state.filters.period }); ["district", "provider", "technology", "status"].forEach((key) => { if (state.filters[key]) params.set(key, state.filters[key]); }); if (state.filters.period === "custom") { ensureCustomDates(); if (state.filters.from) params.set("from", `${state.filters.from}T00:00:00Z`); if (state.filters.to) { const end = new Date(`${state.filters.to}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1); params.set("to", end.toISOString()); } } return params.toString(); }
  async function downloadExport(kind = "raw-csv") { if (!validCustomPeriod()) return; const [type, format] = kind.split("-"); const params = new URLSearchParams({ type: type === "aggregate" ? "aggregate" : "raw", kind: type === "aggregate" ? "aggregate" : "raw", format: format === "xlsx" ? "xlsx" : "csv", period: state.filters.period }); ["district", "provider", "technology", "status"].forEach((key) => { if (state.filters[key]) params.set(key, state.filters[key]); }); if (state.filters.period === "custom") { const report = new URLSearchParams(currentReportParams()); ["from", "to"].forEach((key) => { if (report.get(key)) params.set(key, report.get(key)); }); } try { const response = await fetch(`/api/exports?${params.toString()}`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}, method: "GET" }); if (!response.ok) { const fallback = await fetch(`/api/v1/exports?${params.toString()}`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} }); if (!fallback.ok) throw new Error("export"); return consumeDownload(fallback, type, format); } return consumeDownload(response, type, format); } catch (_) { toast("Серверная выгрузка недоступна — файл не создан", "warn"); } }
  async function consumeDownload(response, type, format) { const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `vko-${type}-${new Date().toISOString().slice(0, 10)}.${format}`; link.click(); URL.revokeObjectURL(url); toast(`Выгрузка ${format.toUpperCase()} подготовлена`); }
  async function loadPassport() { if (!validCustomPeriod()) return; const query = currentReportParams(); try { const payload = await apiTry([`/api/reports/quality-passport?${query}`, `/api/v1/reports/quality-passport?${query}`]); const data = payload.data || payload; renderPassport({ baseline_rate: data.baseline_compliance, contract_rate: data.contract_compliance, received: data.measurements_received, expected: data.measurements_expected, incident_count: data.incidents?.count, problem_minutes: data.incidents?.total_duration_minutes, completeness: data.data_completeness, sufficient_data: data.sufficient_data }); } catch (_) { renderPassport(state.usingDemoData ? {} : { sufficient_data: false }); if (!state.usingDemoData) toast("Паспорт качества недоступен — серверный отчёт не получен", "warn"); } }

  function showView(view) {
    if (view === "admin" && !canAdmin()) return;
    const isOverview = view === "overview" || view === "lines";
    ["incidents", "reports", "admin"].forEach((name) => { const element = $(`#${name}View`); if (element) element.classList.toggle("hidden", view !== name); });
    $("#linesSection").classList.toggle("hidden", !isOverview);
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view || (view === "lines" && item.dataset.view === "overview")));
    if (view === "reports") loadPassport();
    if (view === "incidents") renderIncidents();
    if (view !== "overview" && window.innerWidth <= 960) $(".rail").classList.remove("open");
  }
  function toast(message, tone = "") { const node = document.createElement("div"); node.className = `toast ${tone}`; node.textContent = message; $("#toastRegion").appendChild(node); setTimeout(() => node.remove(), 4200); }

  function bindEvents() {
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
    $("#menuToggle").addEventListener("click", () => $(".rail").classList.add("open")); $("#railClose").addEventListener("click", () => $(".rail").classList.remove("open"));
    $("#refreshButton").addEventListener("click", () => loadData()); $("#demoButton").addEventListener("click", createReplay); $("#exportButton").addEventListener("click", () => downloadExport("raw-csv")); $("#noticeDismiss").addEventListener("click", () => $("#noticeBar").classList.add("hidden"));
    $("#passportButton").addEventListener("click", () => showView("reports"));
    $("#drawerClose").addEventListener("click", closeDrawer); $("#drawerBackdrop").addEventListener("click", closeDrawer); $("#caseModalClose").addEventListener("click", closeCaseModal); $("#caseCancel").addEventListener("click", closeCaseModal); $("#caseSend").addEventListener("click", sendCase);
    $("#reviewConfirm").addEventListener("change", (event) => { $("#caseSend").disabled = !event.target.checked; }); $("#draftText").addEventListener("input", () => { $("#reviewConfirm").checked = false; $("#caseSend").disabled = true; });
    $("#manualIncidentButton").addEventListener("click", () => { const line = state.lines[0]; if (line) createManualIncident(line); });
    $("#searchInput").addEventListener("input", (event) => { state.filters.search = event.target.value; renderMap(); renderLines(); }); $("#districtFilter").addEventListener("change", (event) => { state.filters.district = event.target.value; renderMap(); renderLines(); loadPassport(); }); $("#providerFilter").addEventListener("change", (event) => { state.filters.provider = event.target.value; renderMap(); renderLines(); loadPassport(); }); $("#technologyFilter").addEventListener("change", (event) => { state.filters.technology = event.target.value; renderMap(); renderLines(); loadPassport(); }); $("#statusFilter").addEventListener("change", (event) => { state.filters.status = event.target.value; renderMap(); renderLines(); loadPassport(); }); $("#periodFilter").addEventListener("change", (event) => { state.filters.period = event.target.value; if (state.filters.period === "custom") ensureCustomDates(); toggleCustomPeriod(); renderLines(); loadPassport(); }); ["fromDateFilter", "toDateFilter"].forEach((id) => $("#" + id).addEventListener("change", (event) => { state.filters[id === "fromDateFilter" ? "from" : "to"] = event.target.value; loadPassport(); })); $("#resetFilters").addEventListener("click", () => { state.filters = { ...state.filters, search: "", district: "", provider: "", technology: "", status: "", period: "week", from: "", to: "", view: "lines" }; $("#searchInput").value = ""; populateFilters(); renderMap(); renderLines(); loadPassport(); });
    $$("[data-table-view]").forEach((button) => button.addEventListener("click", () => { state.filters.view = button.dataset.tableView; $$("[data-table-view]").forEach((item) => item.classList.toggle("active", item === button)); renderLines(); }));
    $$("[data-export]").forEach((button) => button.addEventListener("click", () => downloadExport(button.dataset.export)));
    $("#loadMore").addEventListener("click", () => { state.lineLimit += 30; renderLines(); });
    const loginForm = $("#loginForm"); if (loginForm) loginForm.addEventListener("submit", async (event) => { event.preventDefault(); const submit = $("#loginSubmit"); submit.disabled = true; try { await login(false, { username: $("#loginUsername").value.trim(), password: $("#loginPassword").value }); if (state.apiOnline) { await loadData(); await loadPassport(); } } finally { submit.disabled = false; } });
    ["mapZoomIn", "mapZoomOut", "mapReset"].forEach((id) => { const button = $(`#${id}`); if (button) button.addEventListener("click", () => { const svg = $(".vko-map"); const current = Number(svg.dataset.zoom || 1); const next = id === "mapZoomIn" ? Math.min(1.45, current + .1) : id === "mapZoomOut" ? Math.max(.8, current - .1) : 1; svg.dataset.zoom = next; svg.style.transform = `scale(${next})`; }); });
  }
  async function boot() { bindEvents(); if (state.token) await loadUserProfile(); if (!state.token && !state.demoMode) showLogin(); applyCapabilities(); await loadData(); await loadPassport(); }
  document.addEventListener("DOMContentLoaded", boot);
})();
