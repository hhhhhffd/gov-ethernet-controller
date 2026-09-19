const baseURL = process.env.BROWSER_E2E_BASE_URL || "http://127.0.0.1:8080";
let chromium;
let playwrightLoadError = null;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright"));
} catch (error) {
  playwrightLoadError = error instanceof Error ? error.message : String(error);
}

const browser = chromium ? await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium",
  args: ["--no-sandbox", "--disable-crash-reporter"],
}).catch((error) => {
  playwrightLoadError = error instanceof Error ? error.message : String(error);
  return null;
}) : null;

const report = {
  generatedAt: new Date().toISOString(),
  baseURL,
  demoMode: false,
  surfaces: [],
  failures: [],
  blockers: [],
};

class AcceptanceBlocker extends Error {
  constructor(message) {
    super(message);
    this.name = "AcceptanceBlocker";
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function block(message) {
  throw new AcceptanceBlocker(message);
}

function record(surface, status, evidence) {
  const item = { surface, status, evidence };
  report.surfaces.push(item);
  if (status === "FAIL") report.failures.push(item);
  if (status === "BLOCKED_EXTERNAL") report.blockers.push(item);
  console.log(`${status} ${surface}: ${evidence}`);
}

async function surface(surfaceName, fn) {
  try {
    const evidence = await fn();
    record(surfaceName, "PASS", evidence || "live browser assertion passed");
    return true;
  } catch (error) {
    const evidence = error instanceof Error ? error.message : String(error);
    const status = error instanceof AcceptanceBlocker ? "BLOCKED_EXTERNAL" : "FAIL";
    record(surfaceName, status, evidence);
    return false;
  }
}

function basePath(path) {
  return new URL(path, baseURL).pathname;
}

async function apiRequest(page, path, options = {}) {
  const {
    method = "GET",
    body,
    auth = true,
    headers = {},
  } = options;
  return page.evaluate(async ({ path: requestPath, method: requestMethod, requestBody, useAuth, requestHeaders }) => {
    const nextHeaders = { Accept: "application/json", ...requestHeaders };
    if (requestBody !== undefined) nextHeaders["Content-Type"] = "application/json";
    if (useAuth) {
      const token = localStorage.getItem("vko_token");
      if (token) nextHeaders.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: nextHeaders,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      disposition: response.headers.get("content-disposition") || "",
      body: parsed,
      raw,
    };
  }, { path, method, requestBody: body, useAuth: auth, requestHeaders: headers });
}

function expectStatus(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  check(allowed.includes(response.status), `${label} returned HTTP ${response.status}, expected ${allowed.join(" or ")}`);
}

function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["items", "data", "results"]) {
    if (payload && Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function overviewMetric(value, suffix) {
  if (value == null || Number.isNaN(Number(value))) return "Нет данных";
  return `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}${suffix}`;
}

function assertNoDemoMode(page) {
  const url = new URL(page.url());
  check(url.searchParams.get("demo") !== "1", `demo mode is enabled in ${page.url()}`);
  check(!report.demoMode, "browser acceptance report was configured for demo mode");
}

// This is an explicit browser-only fixture. It is deliberately not written to
// web/data or used by the application outside this acceptance harness. The
// coordinates represent the shape of an authoritative registry response; the
// provenance below prevents them from being mistaken for the blocked TASK-013
// production import.
const BROWSER_MAP_FIXTURE = Object.freeze({
  registry: {
    schema_version: 1,
    artifact: "browser-e2e-test-fixture",
    provenance: { source: "browser-e2e-test-fixture", registry_available: true },
    schools: [
      {
        registry_id: "fixture-reg-001",
        school_id: "fixture-school-001",
        official_name: "Тестовая школа ВКО · мониторинг",
        district: "Усть-Каменогорск",
        locality: "Усть-Каменогорск",
        address: "ул. Тестовая, 1",
        latitude: 50.0081,
        longitude: 82.6177,
        coordinate_source: "official-fixture",
        provenance: { source: "browser-e2e-test-fixture" },
      },
      {
        registry_id: "fixture-reg-002",
        school_id: "fixture-school-002",
        official_name: "Тестовая школа ВКО · только реестр",
        district: "Глубоковский район",
        locality: "Глубокое",
        address: "ул. Тестовая, 2",
        latitude: 50.9122,
        longitude: 82.4944,
        coordinate_source: "official-fixture",
        provenance: { source: "browser-e2e-test-fixture" },
      },
    ],
  },
  mapping: {
    schema_version: 1,
    artifact: "browser-e2e-test-fixture",
    provenance: { source: "browser-e2e-test-fixture", registry_available: true },
    disclosure: { measurements_status: "synthetic-browser-fixture" },
    entries: [{ organization_id: "fixture-org-001", registry_id: "fixture-reg-001", match_status: "AUTO_MATCH", confidence: 1 }],
  },
  line: {
    id: "fixture-line-001",
    organization_id: "fixture-org-001",
    school_id: "fixture-school-001",
    school_name: "Тестовая школа ВКО · мониторинг",
    district: "Усть-Каменогорск",
    provider_name: "Fixture Telecom",
    technology: "ВОЛС",
    role: "PRIMARY",
    status: "NO_INTERNET",
    quality_state: "NO_INTERNET",
    contract_state: "UNKNOWN",
    data_state: "FRESH",
    latest: { download: 0, upload: 0, ping: null, loss: 100, at: "2026-09-19T10:00:00Z" },
    reason: "Состояние предоставлено backend LineState fixture",
    monitoring_points: [],
    measurements: [{ observed_at: "2026-09-19T10:00:00Z", connection_status: "NO_INTERNET", quality: "VALID" }],
  },
});

const FIXTURE_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fixturePayload(pathname, method, backendAvailable = true) {
  if (pathname.endsWith("/login") && method === "POST") return { token: "browser-e2e-fixture-token", user: { name: "Browser Fixture", role: "ADMIN", capabilities: [] } };
  if (pathname.endsWith("/auth/me") || pathname.endsWith("/me")) return { user: { name: "Browser Fixture", role: "ADMIN", capabilities: [] } };
  if (!backendAvailable && ["/api/lines", "/api/v1/lines", "/api/overview", "/api/v1/overview"].includes(pathname)) return null;
  if (pathname.endsWith("/lines")) return [BROWSER_MAP_FIXTURE.line];
  if (pathname.includes("/lines/fixture-line-001")) return BROWSER_MAP_FIXTURE.line;
  if (pathname.endsWith("/incidents") || pathname.endsWith("/situations") || pathname.endsWith("/notifications") || pathname.endsWith("/audit") || pathname.endsWith("/agent-versions")) return [];
  if (pathname.endsWith("/overview")) return { counts: { schools: 1, lines: 1, active_devices: 1, problem_lines: 1 }, averages: { download: null, upload: null, ping: null }, completeness: 100 };
  if (pathname.endsWith("/reports/aggregate")) return { by_line: { "fixture-line-001": { measurement_count: 4, analytics_state: "OK" } } };
  if (pathname.endsWith("/reports/analytics")) return { ranking: [{ line_id: "fixture-line-001", state: "OK", baseline_compliance: 100, contract_compliance: null }] };
  if (pathname.includes("/reports/quality-passport")) return { sufficient_data: true, items: [] };
  if (pathname.includes("/provider-cases")) return [];
  return {};
}

async function configureFixturePage(page, options = {}) {
  const { registryAvailable = true, backendAvailable = true } = options;
  const counters = { registry: 0, mapping: 0, tiles: 0, api: new Map() };
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/static/data/vko-schools.json", async (route) => {
    counters.registry += 1;
    if (!registryAvailable) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture registry unavailable" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BROWSER_MAP_FIXTURE.registry) });
  });
  await page.route("**/static/data/organization-school-map.json", async (route) => {
    counters.mapping += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BROWSER_MAP_FIXTURE.mapping) });
  });
  await page.route("https://tile.openstreetmap.org/**", async (route) => {
    counters.tiles += 1;
    return route.fulfill({ status: 200, contentType: "image/png", body: FIXTURE_TILE_PNG });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    counters.api.set(path, (counters.api.get(path) || 0) + 1);
    const payload = fixturePayload(path, request.method(), backendAvailable);
    if (payload === null) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture backend unavailable" }) });
    if (path.includes("/reports/aggregate") || path.includes("/reports/analytics")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  return counters;
}

async function openFixturePage(context, options = {}) {
  const page = await context.newPage();
  const counters = await configureFixturePage(page, options);
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#loginUsername").fill("browser-e2e-fixture");
  await page.locator("#loginPassword").fill("fixture");
  await page.locator("#loginSubmit").click();
  await page.locator("#authBackdrop").waitFor({ state: "hidden", timeout: 15000 });
  if (options.backendAvailable !== false) {
    await page.waitForFunction(() => document.querySelector("#registryDataStatus")?.dataset.state === "available", null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#lineCount")?.textContent?.trim() === "1", null, { timeout: 15000 });
  }
  return { page, counters };
}

async function fixtureMarkerContexts(page) {
  return page.evaluate(() => window.LinkwatchMap.getLayers().registryMarkers.map((marker) => marker.__linkwatchContext).concat(window.LinkwatchMap.getLayers().monitoringMarkers.map((marker) => marker.__linkwatchContext)));
}

async function runAuthoritativeMapAcceptance() {
  if (!browser) {
    const evidence = `Playwright unavailable: ${playwrightLoadError || "browser launch failed"}`;
    for (const surfaceName of ["MAP-001", "MAP-002", "MAP-003", "MAP-004", "MAP-005", "MAP-006", "MAP-007", "MAP-008", "MAP-009", "MAP-010", "MAP-011", "MAP-012"]) record(surfaceName, "BLOCKED_EXTERNAL", evidence);
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const { page, counters } = await openFixturePage(context);
  try {
    await surface("MAP-001", async () => {
      check(await page.evaluate(() => Boolean(window.LinkwatchMap?.getMap() && document.querySelector("#leafletMap.leaflet-container"))), "Leaflet map instance/container was not initialized");
      return "Leaflet map instance and .leaflet-container are present";
    });
    await surface("MAP-002", async () => {
      const tileUrl = await page.evaluate(() => window.LinkwatchMap.getConfig().tileUrl);
      check(tileUrl === "https://tile.openstreetmap.org/{z}/{x}/{y}.png", `unexpected OSM tile template: ${tileUrl}`);
      return `configured tile template=${tileUrl}; requests mocked, live OSM tiles not required`;
    });
    await surface("MAP-003", async () => {
      const attribution = page.locator(".leaflet-control-attribution");
      check(await attribution.isVisible(), "Leaflet attribution is not visible");
      check((await attribution.textContent()).includes("OpenStreetMap"), "visible attribution does not identify OpenStreetMap");
      return "visible Leaflet attribution identifies OpenStreetMap contributors";
    });
    await surface("MAP-004", async () => {
      check(counters.registry === 1, `registry JSON was fetched ${counters.registry} times`);
      check(counters.mapping === 1, `organization mapping JSON was fetched ${counters.mapping} times`);
      return `registry fetches=${counters.registry}; mapping fetches=${counters.mapping}; no N+1 asset loads`;
    });
    await surface("MAP-005", async () => {
      const marker = page.locator('.leaflet-marker-icon.linkwatch-registry-marker[title*="только реестр"]').first();
      check(await marker.count() === 1, "registry-only Leaflet marker was not rendered");
      await marker.click();
      const text = await page.locator("#mapPopup").textContent();
      check(text.includes("Не подключена к мониторингу"), "registry-only popup did not disclose neutral monitoring state");
      check(!text.includes("Текущее состояние"), "registry-only popup exposed current operational state");
      return "registry-only marker opens a neutral popup with explicit non-monitoring disclosure";
    });
    await surface("MAP-006", async () => {
      await page.locator("#mapPopupClose").click();
      const marker = page.locator(".leaflet-marker-icon.linkwatch-monitoring-marker").first();
      await marker.click();
      const context = (await fixtureMarkerContexts(page)).find((item) => item.kind === "monitoring");
      const text = await page.locator("#mapPopup").textContent();
      check(context?.status === "NO_INTERNET", `monitoring marker context status was ${context?.status}`);
      check(text.includes("Текущее состояние") && text.includes("Нет соединения"), "monitoring popup did not use canonical backend LineState");
      return "monitoring marker context and popup use backend LineState=NO_INTERNET";
    });
    await surface("MAP-007", async () => {
      check(await page.locator("#mapPopup").isVisible(), "marker click did not open popup");
      check((await page.locator("#mapPopupTitle").textContent()).includes("мониторинг"), "popup title does not identify the monitored school");
      return "Leaflet monitoring marker click opened the existing accessible popup";
    });
    await surface("MAP-008", async () => {
      await page.locator("#mapPopupOpenLine").click();
      await page.locator("#detailDrawer.open").waitFor({ state: "visible", timeout: 10000 });
      const context = await page.locator("#drawerContext").textContent();
      check(context.includes("fixture-line-001"), "popup action opened the wrong line drawer");
      return "popup action opened existing line drawer for fixture-line-001";
    });
    await surface("MAP-009", async () => {
      await page.locator("#drawerClose").click();
      const marker = page.locator('.leaflet-marker-icon.linkwatch-registry-marker[title*="только реестр"]').first();
      await marker.click();
      const text = await page.locator("#mapPopup").textContent();
      check(!text.includes("NO_DATA") && !text.includes("Нет данных") && !text.includes("Нет актуальных данных"), "registry-only popup exposed fake NO_DATA/metric state");
      return "registry-only popup has no fake status, NO_DATA, or operational metrics";
    });
    await surface("MAP-010", async () => {
      await page.locator("#mapPopupClose").click();
      await page.locator("#mapListMode").selectOption("current");
      await page.locator(".leaflet-marker-icon.linkwatch-monitoring-marker").first().click();
      check((await page.locator("#mapPopupSummary").textContent()).includes("Current operational data"), "current popup did not announce current truth");
      await page.locator("#mapPopupClose").click();
      await page.locator("#mapListMode").selectOption("historical");
      await page.waitForFunction(() => document.querySelector("#mapFooterNote")?.textContent?.includes("Historical evidence"), null, { timeout: 15000 });
      await page.locator(".leaflet-marker-icon.linkwatch-monitoring-marker").first().click();
      const historicalText = await page.locator("#mapPopup").textContent();
      check((await page.locator("#mapPopupSummary").textContent()).includes("current state не используется"), "historical popup did not disclose truth boundary");
      check(historicalText.includes("Историческое evidence") && !historicalText.includes("Текущее состояние"), "historical popup reused current state fields");
      return "current popup uses latest LineState; historical popup uses backend evidence and excludes current state";
    });
    await surface("MAP-011", async () => {
      await page.locator("#mapPopupClose").click();
      await page.locator("#mapListMode").selectOption("current");
      await page.locator("#coverageFilter").selectOption("all");
      await page.waitForFunction(() => document.querySelector("#mapVisibleCount")?.textContent?.trim() === "2", null, { timeout: 5000 });
      const allRegistryIDs = await page.evaluate(() => window.LinkwatchMap.getLayers().registryMarkers.map((marker) => marker.__linkwatchContext.registryId));
      await page.locator("#coverageFilter").selectOption("monitored");
      await page.waitForFunction(() => document.querySelector("#mapVisibleCount")?.textContent?.trim() === "1", null, { timeout: 5000 });
      const monitoredRegistryIDs = await page.evaluate(() => window.LinkwatchMap.getLayers().registryMarkers.map((marker) => marker.__linkwatchContext.registryId));
      check(allRegistryIDs.includes("fixture-reg-002"), "all-school coverage omitted registry-only school");
      check(!monitoredRegistryIDs.includes("fixture-reg-002"), "LINKWATCH-only coverage retained registry-only school");
      return `coverage all=${allRegistryIDs.join(",")}; monitored=${monitoredRegistryIDs.join(",") || "none"}`;
    });
    await surface("MAP-012", async () => {
      const failureContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const { page: failurePage } = await openFixturePage(failureContext, { registryAvailable: false, backendAvailable: false });
        await failurePage.waitForFunction(() => document.querySelector("#noticeTitle")?.textContent?.includes("Сервер мониторинга недоступен"), null, { timeout: 15000 });
        const notice = await failurePage.locator("#noticeText").textContent();
        check(!notice.includes("Демо-срез"), "API/registry failure silently enabled demo data");
        check((await failurePage.locator("#lineCount").textContent()).trim() === "0", "API failure rendered sample operational lines");
        check((await failurePage.locator("#registryDataStatus").textContent()).includes("недоступен"), "registry failure was not visible");
        return "API/registry failures render explicit unavailable states with zero sample lines and no demo mode";
      } finally {
        await failureContext.close();
      }
    });
  } finally {
    await context.close();
  }
}

async function waitForAuthenticatedApp(page, expectedLineCount) {
  await page.locator("#authBackdrop").waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForFunction(() => Boolean(localStorage.getItem("vko_token")), null, { timeout: 5000 });
  await page.waitForFunction((count) => document.querySelector("#lineCount")?.textContent?.trim() === String(count), expectedLineCount, { timeout: 15000 });
  assertNoDemoMode(page);
}

async function login(page, username, password) {
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  assertNoDemoMode(page);
  await page.locator("#loginUsername").fill(username);
  await page.locator("#loginPassword").fill(password);
  await page.locator("#loginSubmit").click();
  await page.locator("#authBackdrop").waitFor({ state: "hidden", timeout: 15000 });

  const token = await page.evaluate(() => localStorage.getItem("vko_token"));
  check(token, `${username} login did not persist a session token`);
  const me = await apiRequest(page, "/api/v1/auth/me");
  expectStatus(me, 200, `${username} auth/me`);
  const lines = await apiRequest(page, "/api/v1/lines");
  expectStatus(lines, 200, `${username} lines`);
  await waitForAuthenticatedApp(page, unwrap(lines.body).length);
  return { token, me: me.body, lines: unwrap(lines.body) };
}

async function assertDownload(page, selector, expectedExtension, label) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.locator(selector).click(),
  ]);
  const filename = download.suggestedFilename();
  check(filename.toLowerCase().endsWith(expectedExtension), `${label} download filename was ${filename}`);
  return filename;
}

async function runUnauthenticatedErrorChecks() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    const unauthenticated = await apiRequest(page, "/api/v1/overview", { auth: false });
    expectStatus(unauthenticated, 401, "unauthenticated overview");

    await page.locator("#loginUsername").fill("browser-e2e-nobody");
    await page.locator("#loginPassword").fill("wrong-password");
    await page.locator("#loginSubmit").click();
    await page.waitForFunction(() => document.querySelector("#authMessage")?.textContent?.includes("Не удалось войти"), null, { timeout: 10000 });
    const message = await page.locator("#authMessage").textContent();
    check(message.includes("Не удалось войти"), `invalid login message was ${message}`);
    return "401 API and invalid-login UI were observed without demo fallback";
  } finally {
    await page.close();
  }
}

async function runBackendUnavailableCheck() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    const loginResponse = await apiRequest(page, "/api/login", { method: "POST", auth: false, body: { username: "admin", password: "demo" } });
    expectStatus(loginResponse, 200, "offline-state setup login");
    const token = loginResponse.body?.token;
    check(token, "offline-state setup did not return a token");
    await page.evaluate((value) => localStorage.setItem("vko_token", value), token);
    await page.route("**/api/**", (route) => route.abort());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#noticeTitle")?.textContent?.includes("Сервер мониторинга недоступен") && document.querySelector("#lineCount")?.textContent?.trim() === "0", null, { timeout: 15000 });
    const notice = await page.locator("#noticeText").textContent();
    check(!notice.includes("Демо-срез"), "backend-unavailable state silently entered demo mode");
    check(await page.locator("#linesTableBody [data-line-id]").count() === 0, "backend-unavailable state showed operational sample lines");
    return "aborted API requests produced explicit unavailable state with zero live lines and no sample rows";
  } finally {
    await page.close();
  }
}

async function main() {
  check(!new URL(baseURL).searchParams.has("demo"), "base URL must not carry a demo query parameter");
  await runAuthoritativeMapAcceptance();
  if (!browser) return;
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const admin = await adminContext.newPage();
  let providerContext;
  let provider;

  try {
    await surface("login", async () => {
      const session = await login(admin, "admin", "demo");
      check(session.me?.role === "ADMIN", `admin login returned role ${session.me?.role}`);
      check(session.lines.length > 0, "live admin session returned no lines");
      return `admin session established; /auth/me=200; live lines=${session.lines.length}; URL has no ?demo=1`;
    });

    const adminReady = Boolean(await admin.evaluate(() => localStorage.getItem("vko_token")));
    if (!adminReady) {
      for (const name of [
        "overview", "map", "school grouping", "line detail", "device detail", "history", "incident list/detail", "manual incident",
        "notifications", "situations", "ProviderCase", "AI draft", "human review", "provider send", "quality passport", "analytics",
        "export preview", "CSV", "XLSX", "audit", "admin", "contract admin", "agent version view", "error states",
      ]) block(`admin session was not established; ${name} was not executable`);
      return;
    }

    await surface("overview", async () => {
      const overview = await apiRequest(admin, "/api/v1/overview");
      expectStatus(overview, 200, "overview");
      const averages = overview.body?.averages || {};
      const expected = [
        ["#kpiAverageDownload", averages.download, " Мбит/с", "download"],
        ["#kpiAverageUpload", averages.upload, " Мбит/с", "upload"],
        ["#kpiAveragePing", averages.ping, " мс", "ping"],
      ];
      for (const [selector, value, suffix, name] of expected) {
        const actual = (await admin.locator(selector).textContent()).trim();
        check(actual === overviewMetric(value, suffix), `${name} rendered ${actual}; backend value renders ${overviewMetric(value, suffix)}`);
      }
      check((await admin.locator("#noticeTitle").textContent()).includes("Демо-срез") === false, "overview is showing demo notice");
      return `HTTP 200; Download=${averages.download ?? "null"}, Upload=${averages.upload ?? "null"}, Ping=${averages.ping ?? "null"}; UI matches backend/null semantics`;
    });

    await surface("map", async () => {
      await admin.locator("#mapListMode").selectOption("current");
      await admin.waitForFunction(() => document.querySelector("#mapFooterNote")?.textContent?.includes("latest LineState"), null, { timeout: 5000 });
      const lines = unwrap((await apiRequest(admin, "/api/v1/lines")).body);
      const markers = admin.locator("#leafletMap .leaflet-marker-icon.linkwatch-monitoring-marker");
      const registryState = await admin.locator("#registryDataStatus").getAttribute("data-state");
      if (registryState === "available") check(await markers.count() > 0, "available registry produced no monitored Leaflet marker");
      else check(["unavailable", "mapping-unavailable"].includes(registryState), `unexpected registry state ${registryState}`);
      check((await admin.locator("#mapModeLabel").textContent()).includes("ТЕКУЩЕЕ СОСТОЯНИЕ"), "current map mode was not announced");
      if (!await markers.count()) return `live lines=${lines.length}; registry state=${registryState}; no marker rendered without authoritative registry coordinates`;
      const marker = markers.first();
      await marker.click({ force: true });
      await admin.locator("#mapPopup").waitFor({ state: "visible" });
      const popupTrigger = admin.locator("#leafletMap .leaflet-marker-icon[aria-expanded='true']");
      check(await popupTrigger.count() === 1, "map popup did not identify its marker trigger");
      const popupText = await admin.locator("#mapPopup").textContent();
      for (const label of ["School ID", "Район", "Провайдер", "Технология", "Роль линии", "Текущее состояние", "Download · latest", "Upload · latest", "Ping · latest", "Последнее наблюдение"]) {
        check(popupText.includes(label), `map popup is missing ${label}`);
      }
      await admin.keyboard.press("Escape");
      check(await admin.locator("#mapPopup").evaluate((element) => element.classList.contains("hidden")), "map popup did not close with Escape");
      check(await admin.evaluate(() => document.activeElement?.classList.contains("linkwatch-monitoring-marker")), "map popup close did not restore marker focus");
      await marker.press("Enter");
      await admin.locator("#mapPopup").waitFor({ state: "visible" });
      await admin.keyboard.press("Escape");
      const noDataMarker = admin.locator("#leafletMap .leaflet-marker-icon.linkwatch-status-no_data").first();
      if (await noDataMarker.count()) {
        await noDataMarker.click({ force: true });
        await admin.locator("#mapPopup").waitFor({ state: "visible" });
        check((await admin.locator("#mapPopup").textContent()).includes("Нет данных"), "NO_DATA marker popup did not show Нет данных");
        await admin.keyboard.press("Escape");
      }
      return `current monitored markers=${await markers.count()}; Leaflet popup mouse+keyboard paths passed; NO_DATA marker=${await noDataMarker.count() ? "present" : "not present in live fixture"}`;
    });

    await surface("school grouping", async () => {
      await admin.locator("[data-table-view='schools']").click();
      await admin.waitForFunction(() => document.querySelectorAll("#linesTableBody .school-card").length > 0, null, { timeout: 5000 });
      const cards = admin.locator("#linesTableBody .school-card");
      const cardCount = await cards.count();
      check(cardCount > 0, "school grouping rendered no school cards");
      check((await admin.locator("#tableSummary").textContent()).includes("школ"), "school grouping summary did not identify schools");
      check(await admin.locator("#linesTableBody [data-line-id]").count() > 0, "school grouping lost line navigation links");
      await admin.locator("[data-table-view='lines']").click();
      return `${cardCount} school cards; grouped view retains line links and current-state summary`;
    });

    const liveLines = unwrap((await apiRequest(admin, "/api/v1/lines")).body);
    const primaryLine = liveLines.find((line) => line.latest?.at) || liveLines[0];
    check(primaryLine?.id, "no live line is available for detail checks");
    const lineDetailResponse = await apiRequest(admin, `/api/v1/lines/${encodeURIComponent(primaryLine.id)}`);
    expectStatus(lineDetailResponse, 200, "line detail API");
    const lineDetail = lineDetailResponse.body?.data || lineDetailResponse.body || {};

    await surface("line detail", async () => {
      await admin.locator("#mapListMode").selectOption("current");
      const lineButton = admin.locator(`#linesTableBody [data-line-id='${primaryLine.id}']`).first();
      await lineButton.click();
      await admin.locator("#detailDrawer.open").waitFor({ state: "visible", timeout: 15000 });
      check((await admin.locator("#drawerTitle").textContent()).trim() !== "—", "line drawer has no title");
      for (const selector of ["#drawerStatus", "#drawerAxes", "#drawerVerdict", "#drawerMetrics", "#drawerContext", "#drawerTimeline"]) {
        check(await admin.locator(selector).textContent(), `line drawer surface ${selector} is empty`);
      }
      check((await admin.locator("#drawerVerdict").textContent()).includes("Evidence chain"), "line detail did not expose evidence chain");
      return `line ${primaryLine.id} API/UI detail loaded with status, two axes, evidence, metrics, context and timeline`;
    });

    await surface("device detail", async () => {
      const device = lineDetail.monitoring_points?.flatMap((point) => point.devices || [])[0];
      check(device?.id, `line ${primaryLine.id} detail has no device for live device surface`);
      const deviceResponse = await apiRequest(admin, `/api/v1/devices/${encodeURIComponent(device.id)}`);
      expectStatus(deviceResponse, 200, "device detail API");
      check(Array.isArray(deviceResponse.body?.measurements), "device detail API did not expose measurements array");
      const deviceButton = admin.locator(`[data-device-id='${device.id}']`).first();
      await deviceButton.click();
      await admin.waitForFunction((deviceID) => {
        const context = document.querySelector("#drawerContext")?.textContent || "";
        return context.includes("Device ID") && context.includes(deviceID);
      }, device.id, { timeout: 15000 });
      const context = await admin.locator("#drawerContext").textContent();
      check(context.includes("Device ID") && context.includes(device.id), "device drawer did not identify device ID");
      check((await admin.locator("#drawerAxes").textContent()).includes("Точка мониторинга"), "device drawer did not expose monitoring point");
      await admin.locator("#drawerClose").click();
      return `device ${device.id} API/UI detail loaded; measurements=${deviceResponse.body.measurements.length}`;
    });

    await surface("history", async () => {
      const history = lineDetail.measurements || lineDetail.history?.items || [];
      check(Array.isArray(history), "line detail history is not an array");
      await admin.locator("[data-table-view='lines']").click();
      const historicalRequests = [];
      const trackRequest = (request) => {
        if (/\/reports\/(aggregate|analytics)/.test(request.url())) historicalRequests.push(request.url());
      };
      admin.on("request", trackRequest);
      await admin.locator("#mapListMode").selectOption("historical");
      await admin.waitForFunction(() => {
        const note = document.querySelector("#mapFooterNote")?.textContent || "";
        return note.includes("Historical evidence") || note.includes("недоступно");
      }, null, { timeout: 15000 });
      const historicalNote = await admin.locator("#mapFooterNote").textContent();
      check(historicalNote.includes("Historical evidence"), `historical map did not load backend evidence: ${historicalNote}`);
      check((await admin.locator("#lineModeNote").textContent()).includes("Исторический режим"), "historical list mode was not announced");
      check(historicalRequests.some((url) => basePath(url).includes("/reports/aggregate")), "historical map did not request aggregate report");
      check(historicalRequests.some((url) => basePath(url).includes("/reports/analytics")), "historical map did not request analytics report");
      for (const period of ["day", "week", "month"]) {
        await admin.locator("#periodFilter").selectOption(period);
        await admin.waitForFunction(() => document.querySelector("#mapFooterNote")?.textContent?.includes("Historical evidence"), null, { timeout: 15000 });
      }
      await admin.locator("#periodFilter").selectOption("custom");
      check(await admin.locator("#fromDateFilter").inputValue(), "custom history did not set from date");
      check(await admin.locator("#toDateFilter").inputValue(), "custom history did not set to date");
      await admin.waitForFunction(() => document.querySelector("#mapFooterNote")?.textContent?.includes("Historical evidence"), null, { timeout: 15000 });
      check(await admin.locator("#statusFilter").isDisabled(), "current status filter remained active in historical mode");
      await admin.locator("#mapListMode").selectOption("current");
      await admin.waitForFunction(() => document.querySelector("#mapFooterNote")?.textContent?.includes("latest LineState"), null, { timeout: 5000 });
      check((await admin.locator("#lineModeNote").textContent()).includes("Период не меняет current truth"), "return to current mode did not restore canonical semantics");
      admin.off("request", trackRequest);
      return `line history array=${history.length}; current/historical modes exercised for day/week/month/custom; aggregate+analytics requests observed`;
    });

    await surface("incident list/detail", async () => {
      await admin.locator("[data-view='incidents']").first().click();
      await admin.locator("#incidentBoard").waitFor({ state: "visible" });
      const incidentsResponse = await apiRequest(admin, "/api/v1/incidents");
      expectStatus(incidentsResponse, 200, "incidents API");
      const incidents = unwrap(incidentsResponse.body);
      if (!incidents.length) {
        check((await admin.locator("#incidentBoard").textContent()).includes("Инцидентов нет"), "incident empty state is not explicit");
        return "HTTP 200; explicit empty incident state rendered";
      }
      check(await admin.locator("#incidentBoard .incident-card").count() >= incidents.length, "incident cards do not cover live API items");
      const incident = incidents[0];
      const detailResponse = await apiRequest(admin, `/api/v1/incidents/${incident.id}`);
      expectStatus(detailResponse, 200, "incident detail API");
      const card = admin.locator("#incidentBoard .incident-card").first();
      const cardText = await card.textContent();
      check(cardText.includes("Opening evidence"), "incident card did not render opening evidence");
      check(cardText.includes("timeline") || cardText.includes("Timeline") || await card.locator(".incident-timeline").count(), "incident card did not render timeline surface");
      return `HTTP 200; ${incidents.length} incident cards; incident ${incident.id} detail and append-only timeline visible`;
    });

    await surface("manual incident", async () => {
      check(await admin.locator("#manualIncidentButton").isVisible(), "manual incident action is hidden for ADMIN");
      const invalid = await apiRequest(admin, "/api/v1/incidents", { method: "POST", body: { line_id: "", description: "browser-e2e validation probe", source: "MANUAL" } });
      expectStatus(invalid, [404, 422], "invalid manual incident");
      const manualDescription = "browser-e2e bounded manual incident fixture";
      let incidents = unwrap((await apiRequest(admin, "/api/v1/incidents")).body);
      if (!incidents.some((item) => item.source === "MANUAL" && item.description === manualDescription)) {
        const activeLineIDs = new Set(incidents.filter((item) => String(item.status).toUpperCase() !== "CLOSED").map((item) => item.line_id));
        const manualLine = liveLines.find((line) => !activeLineIDs.has(line.id)) || primaryLine;
        const created = await apiRequest(admin, "/api/v1/incidents", { method: "POST", body: { line_id: manualLine.id, description: manualDescription, source: "MANUAL" } });
        expectStatus(created, 201, "valid manual incident");
        check((created.body?.source || created.body?.data?.source) === "MANUAL", "valid manual incident response did not preserve MANUAL source");
        incidents = unwrap((await apiRequest(admin, "/api/v1/incidents")).body);
      }
      check(incidents.some((item) => item.source === "MANUAL"), "live incident list has no manual incident evidence");
      return `manual action visible; invalid mutation returned ${invalid.status} without creating an object; bounded MANUAL incident fixture is visible`;
    });

    await surface("notifications", async () => {
      await admin.locator("[data-view='notifications']").first().click();
      await admin.locator("#notificationList").waitFor({ state: "visible" });
      await admin.waitForFunction(() => !document.querySelector("#notificationList")?.textContent?.includes("Загрузка уведомлений"), null, { timeout: 15000 });
      const response = await apiRequest(admin, "/api/v1/notifications?limit=50");
      expectStatus(response, 200, "notifications API");
      const items = unwrap(response.body);
      if (!items.length) check((await admin.locator("#notificationList").textContent()).includes("Уведомлений нет"), "notification empty state is not explicit");
      else check(await admin.locator("#notificationList .notification-item").count() >= items.length, "notification UI does not cover API items");
      return `HTTP 200; notification items=${items.length}; ${items.length ? "delivery cards rendered" : "explicit empty state rendered"}`;
    });

    await surface("situations", async () => {
      const response = await apiRequest(admin, "/api/v1/situations");
      expectStatus(response, 200, "situations API");
      const situations = unwrap(response.body);
      const listText = await admin.locator("#situationsList").textContent();
      if (!situations.length) {
        check(listText.includes("Нет текущих связанных ситуаций"), "situations empty state is not explicit");
        return "HTTP 200; explicit empty correlation state rendered";
      }
      check(await admin.locator("#situationsList .situation-card").count() >= situations.length, "situation cards do not cover live items");
      await admin.locator("#situationsList .situation-card").first().click();
      await admin.locator("#detailDrawer.open").waitFor({ state: "visible", timeout: 10000 });
      check((await admin.locator("#drawerVerdict").textContent()).includes("не доказывает") || (await admin.locator("#drawerVerdict").textContent()).includes("корреляц"), "situation detail did not state correlation-only semantics");
      await admin.locator("#drawerClose").click();
      return `HTTP 200; situation cards=${situations.length}; correlation-only detail opened`;
    });

    await surface("quality passport", async () => {
      await admin.locator("[data-view='reports']").first().click();
      await admin.locator("#passportGrid").waitFor({ state: "visible" });
      await admin.waitForFunction(() => !document.querySelector("#passportGrid")?.textContent?.includes("Загрузка"), null, { timeout: 15000 });
      const response = await apiRequest(admin, "/api/v1/reports/quality-passport?period=week");
      expectStatus(response, 200, "quality passport API");
      check(await admin.locator("#passportGrid .passport-item").count() >= 6, "quality passport cards are incomplete");
      const sufficient = response.body?.sufficient_data;
      const note = await admin.locator(".quality-note b").textContent();
      if (sufficient === false) check(note.includes("Недостаточно") || note.includes("Нет данных"), `insufficient-data passport rendered ${note}`);
      return `HTTP 200; passport cards=${await admin.locator("#passportGrid .passport-item").count()}; sufficient_data=${sufficient ?? "unknown"}; UI preserves insufficient/NO_DATA semantics`;
    });

    await surface("analytics", async () => {
      const response = await apiRequest(admin, "/api/v1/reports/analytics?period=week&limit=500");
      expectStatus(response, 200, "analytics API");
      await admin.waitForFunction(() => document.querySelector("#passportGrid .analytics-inline") || document.querySelector("#passportGrid")?.textContent?.includes("NO_DATA"), null, { timeout: 15000 });
      const text = await admin.locator("#passportGrid").textContent();
      check(text.includes("историчес") || text.includes("NO_DATA"), "analytics UI did not identify historical/no-data semantics");
      if (response.body?.current_state_used === false) check(text.includes("current state не используется"), "analytics UI did not preserve current-state boundary");
      return `HTTP 200; analytics status=${response.body?.status || "unknown"}; historical-only boundary rendered`;
    });

    await surface("export preview", async () => {
      const raw = await apiRequest(admin, "/api/v1/exports/preview?kind=raw&format=csv&period=week");
      const aggregate = await apiRequest(admin, "/api/v1/exports/preview?kind=aggregate&format=xlsx&period=week");
      expectStatus(raw, 200, "raw export preview");
      expectStatus(aggregate, 200, "aggregate export preview");
      check(!(await admin.locator("#exportPreviewSummary").textContent()).includes("Preview не загружен"), "export preview remains unloaded in UI");
      check(raw.body?.scope_enforced !== false && aggregate.body?.scope_enforced !== false, "export preview did not confirm scope enforcement");
      return `raw CSV preview=200, aggregate XLSX preview=200; scope_enforced=${raw.body?.scope_enforced ?? "not reported"}`;
    });

    await surface("CSV", async () => {
      await admin.locator("#exportKind").selectOption("raw");
      await admin.locator("#exportFormat").selectOption("csv");
      const filename = await assertDownload(admin, "#exportDownload", ".csv", "raw CSV");
      return `live export download produced ${filename}`;
    });

    await surface("XLSX", async () => {
      await admin.locator("#exportKind").selectOption("aggregate");
      await admin.locator("#exportFormat").selectOption("xlsx");
      const filename = await assertDownload(admin, "#exportDownload", ".xlsx", "aggregate XLSX");
      return `live export download produced ${filename}`;
    });

    await surface("audit", async () => {
      await admin.locator("[data-view='audit']").first().click();
      await admin.locator("#auditTable").waitFor({ state: "visible" });
      await admin.waitForFunction(() => !document.querySelector("#auditTable")?.textContent?.includes("Журнал не загружен"), null, { timeout: 15000 });
      const response = await apiRequest(admin, "/api/v1/audit?limit=50");
      expectStatus(response, 200, "audit API");
      check((await admin.locator("#auditTable").textContent()).length > 0, "audit UI is empty without an explicit state");
      return `HTTP 200; audit rows=${unwrap(response.body).length}; read-only table rendered`;
    });

    await surface("agent version view", async () => {
      const response = await apiRequest(admin, "/api/v1/agent-versions?limit=50");
      expectStatus(response, 200, "agent versions API");
      const versions = unwrap(response.body);
      check((await admin.locator("#agentVersionsTable").textContent()).length > 0, "agent version table has no empty/data state");
      if (!versions.length) return "HTTP 200; explicit no-observed-agent-version state rendered";
      await admin.locator("#agentVersionsTable [data-agent-version]").first().click();
      await admin.waitForFunction(() => document.querySelector("#agentVersionDevices")?.hidden === false, null, { timeout: 10000 });
      return `HTTP 200; observed versions=${versions.length}; version device drill-down opened`;
    });

    await surface("admin", async () => {
      await admin.locator("[data-view='admin']").first().click();
      await admin.locator("#adminView").waitFor({ state: "visible" });
      const resources = ["organizations", "devices", "providers", "lines", "monitoring-points", "users", "schedule", "policies", "contracts", "districts", "technologies"];
      const statuses = [];
      for (const resource of resources) {
        const path = resource === "schedule" ? "schedules" : resource === "districts" || resource === "technologies" ? `catalogs/${resource}` : resource;
        const response = await apiRequest(admin, `/api/v1/admin/${path}`);
        expectStatus(response, 200, `admin ${resource} API`);
        statuses.push(`${resource}=200`);
        await admin.locator(`[data-admin-resource='${resource}']`).click();
        await admin.waitForFunction(() => !document.querySelector("#adminResourceTable")?.textContent?.includes("Загрузка реестра"), null, { timeout: 15000 });
        check((await admin.locator("#adminFormTitle").textContent()).length > 0, `admin ${resource} form did not render`);
      }
      check((await admin.locator("#adminView").textContent()).includes("Предпросмотр влияния"), "admin impact preview control is missing");
      return `${statuses.join(", ")}; all live admin tabs loaded; impact preview affordance present`;
    });

    await surface("contract admin", async () => {
      await admin.locator("[data-admin-resource='contracts']").click();
      await admin.waitForFunction(() => !document.querySelector("#adminResourceTable")?.textContent?.includes("Загрузка реестра"), null, { timeout: 15000 });
      check((await admin.locator("#adminFormTitle").textContent()).includes("effective"), "contract form is not an effective-version form");
      for (const name of ["line_id", "contract_no", "contract_date", "valid_from", "download_min", "upload_min", "ping_max", "jitter_max", "packet_loss_max", "availability_min", "reason"]) {
        check(await admin.locator(`#adminResourceForm [name='${name}']`).count() === 1, `contract form field ${name} is missing`);
      }
      const contracts = unwrap((await apiRequest(admin, "/api/v1/admin/contracts")).body);
      check(contracts.length > 0, "live contract admin has no history rows");
      check(await admin.locator("#adminResourceTable .contract-current").count() > 0, "contract table does not mark current version");
      const existing = contracts[0];
      const overlap = await apiRequest(admin, "/api/v1/admin/contracts", {
        method: "POST",
        body: {
          line_id: existing.line_id,
          valid_from: existing.valid_from,
          contract_no: "browser-e2e-overlap-probe",
          download_min: existing.download_min,
          upload_min: existing.upload_min,
          ping_max: existing.ping_max,
          jitter_max: existing.jitter_max,
          packet_loss_max: existing.packet_loss_max,
          availability_min: existing.availability_min,
          reason: "browser acceptance conflict probe",
        },
      });
      expectStatus(overlap, 409, "overlapping contract version");
      const after = unwrap((await apiRequest(admin, "/api/v1/admin/contracts")).body);
      check(after.length === contracts.length, "overlap rejection changed contract history length");
      return `contract history rows=${contracts.length}; current marker rendered; overlap mutation rejected 409 with history preserved`;
    });

    await surface("error states", async () => {
      const notFound = await apiRequest(admin, "/api/v1/lines/browser-e2e-missing-line");
      expectStatus(notFound, 404, "missing line detail");
      const providerReady = await (async () => {
        providerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        provider = await providerContext.newPage();
        try {
          return await login(provider, "provider-a", "demo");
        } catch (error) {
          await provider.close();
          await providerContext.close();
          provider = undefined;
          providerContext = undefined;
          throw error;
        }
      })();
      check(providerReady.me?.role === "PROVIDER", `provider login returned role ${providerReady.me?.role}`);
      const forbidden = await apiRequest(provider, "/api/v1/admin/contracts");
      expectStatus(forbidden, 403, "provider admin contracts");
      check(await provider.locator("[data-view='admin']").evaluate((element) => element.hidden), "provider admin navigation is visible");
      return "401 unauthenticated, 403 provider admin, 404 missing line and invalid-login UI were verified";
    });

    await surface("ProviderCase", async () => {
      const response = await apiRequest(admin, "/api/v1/provider-cases?limit=50");
      expectStatus(response, 200, "provider cases API");
      const cases = unwrap(response.body);
      check(response.body?.human_send_gate === true, "provider cases API did not expose human_send_gate=true");
      if (!cases.length) block("live backend returned an empty ProviderCase queue; populated workspace/evidence needs an authorized case fixture");
      check(await provider.locator(".provider-workspace").count() > 0, "provider workspace UI did not render populated queue");
      check((await provider.locator(".provider-workspace").textContent()).includes("SERVER-SCOPED QUEUE"), "provider workspace scope label is missing");
      return `HTTP 200; populated provider queue=${cases.length}; provider role UI rendered scoped queue`;
    });

    const providerCasesResponse = await apiRequest(admin, "/api/v1/provider-cases?limit=50");
    const providerCases = unwrap(providerCasesResponse.body);
    if (providerCases.length) {
      const pendingCase = providerCases.find((item) => item.status !== "SENT") || providerCases[0];
      await surface("AI draft", async () => {
        const ai = await apiRequest(admin, `/api/v1/provider-cases/${pendingCase.id}/ai-draft`, {
          method: "POST",
          headers: { "Idempotency-Key": `browser-e2e-${Date.now()}` },
          body: {},
        });
        if ([502, 503].includes(ai.status)) block(`authorized live AI model unavailable: HTTP ${ai.status}; provider case remains usable`);
        expectStatus(ai, 200, "AI draft");
        check(ai.body?.status === "DRAFT" && ai.body?.draft_text, "AI draft response is not an editable draft");
        check(!/password|token|secret|private.?key/i.test(ai.raw), "AI draft response leaked a credential-shaped field");
        return `HTTP 200; editable DRAFT persisted for provider case ${pendingCase.id}; response is secret-safe`;
      });

      await surface("human review", async () => {
        const gate = await apiRequest(admin, `/api/v1/provider-cases/${pendingCase.id}/send`, {
          method: "POST",
          body: { reviewed: false },
        });
        expectStatus(gate, 409, "unreviewed provider send");
        check(/review/i.test(gate.raw), "409 provider review gate did not explain required review");
        return "unreviewed send rejected HTTP 409 before transport; human gate is active";
      });

      await surface("provider send", async () => {
        block("successful external provider delivery was not attempted: no authorized provider endpoint was configured for this browser run");
      });
    } else {
      for (const name of ["AI draft", "human review", "provider send"]) {
        record(name, "BLOCKED_EXTERNAL", "no live ProviderCase exists; no fake case or sample data was used");
      }
    }

    await surface("backend unavailable", runBackendUnavailableCheck);
    await surface("authentication error states", runUnauthenticatedErrorChecks);

    if (provider) await provider.close();
    if (providerContext) await providerContext.close();
    await admin.close();
    await adminContext.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  const evidence = error instanceof Error ? error.message : String(error);
  report.failures.push({ surface: "harness bootstrap", status: "FAIL", evidence });
  console.error(`FAIL harness bootstrap: ${evidence}`);
  try {
    await browser.close();
  } catch (_) {
    // Browser cleanup is best effort after a bootstrap failure.
  }
}

const passCount = report.surfaces.filter((item) => item.status === "PASS").length;
const failCount = report.failures.length;
const blockerCount = report.blockers.length;
console.log(`BROWSER E2E ${failCount ? "FAIL" : blockerCount ? "BLOCKED" : "PASS"}: live browser surfaces PASS=${passCount} FAIL=${failCount} BLOCKED_EXTERNAL=${blockerCount}; demo=off`);
if (failCount) process.exitCode = 1;
else if (blockerCount) process.exitCode = 2;
