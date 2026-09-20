const baseURL = process.env.BROWSER_E2E_BASE_URL || "http://127.0.0.1:8080";
let chromium;
let playwrightLoadError = null;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")); }
catch (error) { playwrightLoadError = error instanceof Error ? error.message : String(error); }

const report = { surfaces: [], failures: [], blockers: [] };
function check(condition, message) { if (!condition) throw new Error(message); }
function record(surface, status, evidence) { report.surfaces.push({ surface, status, evidence }); if (status === "FAIL") report.failures.push({ surface, status, evidence }); if (status === "BLOCKED_EXTERNAL") report.blockers.push({ surface, status, evidence }); }
async function surface(name, callback) { try { record(name, "PASS", await callback()); } catch (error) { record(name, "FAIL", error instanceof Error ? error.message : String(error)); } }

const BROWSER_MAP_FIXTURE = Object.freeze({
  registry: { schema_version: 1, artifact: "browser-e2e-test-fixture", provenance: { source: "browser-e2e-test-fixture" }, schools: [
    { registry_id: "fixture-reg-001", official_name: "Тестовая школа ВКО · мониторинг", district: "Усть-Каменогорск", locality: "Усть-Каменогорск", address: "ул. Тестовая, 1", latitude: 50.0081, longitude: 82.6177, coordinate_source: "official-fixture" },
    { registry_id: "fixture-reg-002", official_name: "Тестовая школа ВКО · только реестр", district: "Глубоковский район", locality: "Глубокое", address: "ул. Тестовая, 2", latitude: 50.9122, longitude: 82.4944, coordinate_source: "official-fixture" },
    { registry_id: "18383", official_name: "Средняя школа №32", district: "Усть-Каменогорск", address: "ул. Школьная, 32", latitude: 49.988825, longitude: 82.575407, coordinate_source: "official-fixture" },
  ] },
  mapping: { schema_version: 1, artifact: "browser-e2e-test-fixture", entries: [{ organization_id: "fixture-org-001", registry_id: "fixture-reg-001", match_status: "AUTO_MATCH", confidence: 1 }] },
  line: { id: "fixture-line-001", organization_id: "fixture-org-001", school_id: "fixture-school-001", school_name: "Тестовая школа ВКО · мониторинг", district: "Усть-Каменогорск", provider_name: "Fixture Telecom", technology: "ВОЛС", role: "PRIMARY", status: "NO_INTERNET", quality_state: "NO_INTERNET", data_state: "FRESH", latest: { download: 0, upload: 0, ping: null, loss: 100, at: "2026-09-19T10:00:00Z" }, reason: "Состояние предоставлено backend LineState fixture", measurements: [] },
});
const FIXTURE_TILE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function fixturePayload(pathname, method, backendAvailable, logoutAvailable = true) {
  if (pathname.endsWith("/login") && method === "POST") return { token: "browser-e2e-fixture-token", user: { name: "Browser Fixture", role: "ADMIN", capabilities: ["line.read", "incident.read", "report.read", "report.export"] } };
  if (pathname.endsWith("/auth/me")) return { user: { name: "Browser Fixture", role: "ADMIN", scopes: [{ scope_type: "OBLAST", scope_id: "fixture" }], capabilities: ["line.read", "incident.read", "report.read", "report.export"] } };
  if (pathname.endsWith("/auth/logout") && method === "POST") return logoutAvailable ? { revoked: true } : null;
  if (!backendAvailable && (pathname.endsWith("/lines") || pathname.endsWith("/overview"))) return null;
  if (pathname.includes("/lines/")) return BROWSER_MAP_FIXTURE.line;
  if (pathname.endsWith("/lines")) return [BROWSER_MAP_FIXTURE.line];
  if (pathname.includes("/reports/aggregate")) return { by_line: { "fixture-line-001": { measurement_count: 4, analytics_state: "OK" } } };
  if (pathname.includes("/reports/analytics")) return { ranking: [{ line_id: "fixture-line-001", state: "OK" }] };
  if (pathname.endsWith("/incidents") || pathname.endsWith("/situations") || pathname.endsWith("/notifications")) return [];
  return {};
}

async function configureFixturePage(page, { registryAvailable = true, backendAvailable = true, logoutAvailable = true } = {}) {
  const counters = { registry: 0, mapping: 0, tiles: 0 };
  const requests = { me: 0, logout: 0 };
  await page.route("**/static/data/vko-schools.json", (route) => { counters.registry += 1; return registryAvailable ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BROWSER_MAP_FIXTURE.registry) }) : route.fulfill({ status: 503, body: "unavailable" }); });
  await page.route("**/static/data/organization-school-map.json", (route) => { counters.mapping += 1; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BROWSER_MAP_FIXTURE.mapping) }); });
  await page.route("https://tiles.stadiamaps.com/**", (route) => { counters.tiles += 1; return route.fulfill({ status: 200, contentType: "image/png", body: FIXTURE_TILE_PNG }); });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/auth/me")) requests.me += 1;
    if (pathname.endsWith("/auth/logout")) requests.logout += 1;
    const payload = fixturePayload(pathname, request.method(), backendAvailable, logoutAvailable);
    return payload === null ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture backend unavailable" }) }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  return { counters, requests };
}

async function openFixturePage(context, options = {}) {
  const page = await context.newPage();
  const { counters, requests } = await configureFixturePage(page, options);
  await page.addInitScript(() => {
    if (localStorage.getItem("__browser_e2e_initialized") !== "1") {
      localStorage.clear();
      localStorage.setItem("linkwatch_theme", "dark");
      localStorage.setItem("__browser_e2e_initialized", "1");
    }
  });
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#loginUsername").fill("browser-e2e-fixture");
  await page.locator("#loginPassword").fill("fixture");
  await page.locator("#loginSubmit").click();
  await page.locator("#authBackdrop").waitFor({ state: "hidden", timeout: 15000 });
  if (options.backendAvailable !== false) {
    await page.waitForFunction(() => document.querySelector("#registryDataStatus")?.dataset.state === "available", null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("#lineCount")?.textContent?.trim() === "1", null, { timeout: 15000 });
  }
  return { page, counters, requests };
}

async function runMapAcceptance() {
  if (!chromium) { record("map scaffold", "BLOCKED_EXTERNAL", `Playwright unavailable: ${playwrightLoadError || "browser launch failed"}`); return; }
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium", args: ["--no-sandbox", "--disable-crash-reporter"] });
  const context = await browser.newContext({ viewport: { width: 1355, height: 880 } });
  context.setDefaultTimeout(8000);
  const { page, counters, requests } = await openFixturePage(context);
  try {
    await surface("authenticated scaffold", async () => { check(await page.locator("#authenticatedWorkspace").isVisible(), "authenticated workspace is hidden"); check(await page.locator("#leafletMap.leaflet-container").count() === 1, "Leaflet map container is missing"); check(counters.registry === 1 && counters.mapping === 1, "map assets were loaded more than once"); return "login, bootstrap, Leaflet container and cached registry assets are present"; });
    await surface("auth reload and capability gates", async () => {
      await page.locator("#accountButton").click();
      check(await page.locator("#adminMenuButton").isHidden(), "admin control was exposed without admin.manage");
      check(await page.locator("#auditMenuButton").isHidden(), "audit control was exposed without audit.read");
      check(await page.locator('[data-capability="notification.read"]:visible').count() === 0, "notifications were exposed without notification.read");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("#authBackdrop").waitFor({ state: "hidden", timeout: 15000 });
      check(requests.me >= 2, "reload did not resolve the stored session through /auth/me");
      check(await page.evaluate(() => localStorage.getItem("vko_token")) === "browser-e2e-fixture-token", "reload did not retain the session token");
      return "account entries and notifications follow server capabilities; reload revalidates /auth/me";
    });
    await surface("full-screen map shell", async () => {
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const mapBox = await page.locator("#mapWrap").boundingBox();
      check(mapBox && Math.abs(mapBox.x) < 1 && Math.abs(mapBox.y) < 1 && Math.abs(mapBox.width - viewport.width) < 1 && Math.abs(mapBox.height - viewport.height) < 1, "map workspace does not fill the viewport");
      check(await page.locator(".map-workspace").count() === 1 && await page.locator(".map-card, .map-controls, .session-bar, .dashboard-grid, .kpi-grid, .activity-panel, .sidebar, .rail").count() === 0, "legacy shell surface is still present");
      check(await page.locator(".primary-nav [data-route]:visible").count() === 3, "capability-aware primary nav does not expose exactly Map, Incidents and Reports");
      check(await page.locator(".leaflet-control-zoom").count() === 0 && await page.locator(".map-tools").count() === 1 && await page.locator(".map-tools button").count() === 3, "map has duplicate or missing zoom/fit controls");
      await page.locator('.primary-nav [data-route="reports"]').click();
      await page.waitForFunction(() => document.querySelector("#authenticatedWorkspace")?.dataset.route === "reports");
      check(await page.locator('.primary-nav [data-route="reports"]').getAttribute("aria-current") === "page" && new URL(page.url()).hash === "#reports", "primary navigation has no route effect");
      await page.locator('.primary-nav [data-route="map"]').click();
      const darkGeometry = await page.evaluate(() => ["#mapWrap", ".shell-top-left", ".primary-nav .reference-nav-item", "#schoolSearch", ".map-tools button"].flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => { const box = element.getBoundingClientRect(); return [selector, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]; })));
      await page.screenshot({ path: "artifacts/task006-shell-1355x880.png", scale: "css" });
      await page.screenshot({ path: "artifacts/task022-dark-1355x880.png", scale: "css" });
      await page.locator("#themeToggle").click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      const lightGeometry = await page.evaluate(() => ["#mapWrap", ".shell-top-left", ".primary-nav .reference-nav-item", "#schoolSearch", ".map-tools button"].flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => { const box = element.getBoundingClientRect(); return [selector, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]; })));
      await page.screenshot({ path: "artifacts/task022-light-1355x880.png", scale: "css" });
      check(JSON.stringify(darkGeometry) === JSON.stringify(lightGeometry), "dark and light themes changed canonical geometry");
      await page.locator("#themeToggle").click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      return "map fills 1355×880, shell is isolated, nav is capability-aware, one map tool stack is visible, and dark/light geometry matches";
    });
    await surface("registry-only marker", async () => { const marker = page.locator('.leaflet-marker-icon.linkwatch-registry-marker[title*="только реестр"]').first(); check(await marker.count() === 1, "registry-only marker is missing"); await marker.click(); const text = await page.locator("#mapPopup").textContent(); check(text.includes("Не подключена к мониторингу"), "registry-only state is not explicit"); check(!text.includes("Текущее состояние"), "registry-only popup exposed operational state"); return "registry-only popup stays neutral"; });
    await surface("current monitoring marker", async () => { await page.locator("#mapPopupClose").click(); await page.locator(".leaflet-marker-icon.linkwatch-monitoring-marker").first().click(); const contextData = await page.evaluate(() => window.LinkwatchMap.getLayers().monitoringMarkers[0].__linkwatchContext); const text = await page.locator("#mapPopup").textContent(); check(contextData.status === "NO_INTERNET", `marker status was ${contextData.status}`); check(text.includes("Текущее состояние"), "monitoring popup did not disclose current state"); return "monitoring marker preserves backend LineState identity"; });
    await surface("contextual line boundary", async () => { await page.locator("#mapPopupOpenLine").click(); await page.locator("#detailDrawer").waitFor({ state: "visible" }); const drawerText = await page.locator("#drawerContext, #drawerLine").allTextContents(); check(drawerText.join(" ").includes("fixture-line-001"), "line context lost line identity"); await page.locator("#drawerClose").click(); await page.locator("#mapPopupClose").click(); return "map popup opens the contextual line surface"; });
    await surface("real school search, filters and map counts", async () => {
      await page.locator("#schoolSearch").fill("№32");
      const result = page.locator('.school-search-result[data-registry-id="18383"]');
      await result.waitFor({ state: "visible" });
      await result.click();
      check((await page.locator("#mapPopupTitle").textContent()).includes("№32"), "search selection did not open the real registry school");
      await page.waitForFunction(() => (window.LinkwatchMap.getMap()?.getZoom?.() || 0) >= 14);
      await page.locator("#mapPopupClose").click();
      await page.locator("#schoolSearch").fill("not-a-real-school");
      await page.locator("#mapFilterStatus").waitFor({ state: "visible" });
      check((await page.locator("#mapFilterStatus").textContent()).includes("Школы не найдены"), "zero search result is not explicit");
      await page.locator("#schoolSearch").fill("");
      await page.locator(".map-filter-details summary").click();
      await page.locator("#districtFilter").selectOption("Усть-Каменогорск");
      await page.locator("#providerFilter").selectOption("Fixture Telecom");
      await page.locator("#statusFilter").selectOption("NO_INTERNET");
      await page.locator("#coverageFilter").selectOption("monitored");
      await page.waitForFunction(() => document.querySelector("#mapVisibleSchoolCount")?.textContent?.trim() === "1");
      check((await page.locator("#mapAttentionCount").textContent()).trim() === "1", "attention count is not derived from filtered operational truth");
      check(await page.locator(".leaflet-marker-icon.linkwatch-monitoring-marker").count() === 1, "filters did not constrain the monitoring layer");
      await page.locator("#mapFiltersReset").click();
      await page.waitForFunction(() => document.querySelector("#mapVisibleSchoolCount")?.textContent?.trim() === "3");
      return "search uses registry fields, filters constrain real map layers, and counts follow the filtered view";
    });
    await surface("historical boundary", async () => { await page.locator("#mapListMode").selectOption("historical"); await page.waitForFunction(() => { const text = document.querySelector("#mapFooterNote")?.textContent || ""; return text.includes("Исторические данные") && text.includes("текущее состояние не используется"); }); await page.locator(".leaflet-marker-icon.linkwatch-monitoring-marker").first().click(); const text = await page.locator("#mapPopup").textContent(); check(text.includes("текущее состояние не используется"), "historical popup reused current state"); return "historical mode remains explicitly separate from current LineState"; });
    await surface("coverage boundary", async () => { await page.locator("#mapPopupClose").click(); await page.locator("#mapListMode").selectOption("current"); await page.locator("#coverageFilter").selectOption("monitored"); await page.waitForFunction(() => window.LinkwatchMap.getLayers().registryMarkers.length === 1); const ids = await page.evaluate(() => window.LinkwatchMap.getLayers().registryMarkers.map((marker) => marker.__linkwatchContext.registryId)); check(ids.length === 1 && ids[0] === "fixture-reg-001", "monitored coverage changed registry identity"); await page.locator("#coverageFilter").selectOption("all"); return "coverage changes presentation scope without replacing registry data"; });
    await surface("neutral cluster", async () => { const cluster = page.locator(".leaflet-marker-icon.linkwatch-registry-cluster").first(); await cluster.waitFor({ state: "visible" }); check(await cluster.count() === 1, "registry cluster marker is missing"); await cluster.click(); const text = await page.locator("#mapPopup").textContent(); check(text.includes("Школ в группе") && !text.includes("Текущее состояние"), `cluster is not neutral: ${JSON.stringify(text)}`); const school = page.locator('[data-popup-registry-id="18383"]'); check(await school.count() === 1, "cluster member school is missing"); await school.click(); check((await page.locator("#mapPopupTitle").textContent()).includes("№32"), "cluster member selection lost school identity"); return "cluster member selection remains registry-backed"; });
    await surface("logout and local cleanup", async () => {
      await page.locator("#accountButton").click();
      await page.locator("#logoutButton").click();
      await page.locator("#authBackdrop").waitFor({ state: "visible", timeout: 5000 });
      check(await page.locator("#authenticatedWorkspace").isHidden(), "workspace remained visible after logout");
      check(requests.logout === 1, "logout did not call the backend endpoint");
      check(await page.evaluate(() => localStorage.getItem("vko_token")) === null, "logout left the local token active");
      return "confirmed logout revokes through the real endpoint and returns to login";
    });
  } finally { await context.close(); await browser.close(); }
}

async function runErrorAcceptance() {
  if (!chromium) return;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium", args: ["--no-sandbox", "--disable-crash-reporter"] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  context.setDefaultTimeout(8000);
  try {
    await surface("backend unavailable", async () => { const { page } = await openFixturePage(context, { backendAvailable: false, registryAvailable: false }); await page.waitForFunction(() => document.querySelector("#operationalStatus")?.dataset.state === "unavailable"); check((await page.locator("#lineCount").textContent()).trim() === "0", "backend failure rendered operational data"); check((await page.locator("#mapError").textContent()).includes("Сервер мониторинга"), "backend failure was not explicit"); return "backend and registry failures remain explicit with no demo fallback"; });
  } finally { await context.close(); await browser.close(); }
}

async function runInvalidLogin() {
  if (!chromium) return;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium", args: ["--no-sandbox", "--disable-crash-reporter"] });
  const context = await browser.newContext();
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid credentials" }) }));
  try { await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" }); await page.locator("#loginUsername").fill("wrong"); await page.locator("#loginPassword").fill("wrong"); await page.locator("#loginSubmit").click(); await page.waitForFunction(() => document.querySelector("#authMessage")?.textContent?.includes("Не удалось войти")); record("authentication error", "PASS", "invalid login keeps the real auth surface visible"); }
  catch (error) { record("authentication error", "FAIL", error instanceof Error ? error.message : String(error)); }
  finally { await context.close(); await browser.close(); }
}

async function runInvalidStoredToken() {
  if (!chromium) return;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium", args: ["--no-sandbox", "--disable-crash-reporter"] });
  const context = await browser.newContext();
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("vko_token", "expired-fixture-token"));
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "expired session" }) }));
  try {
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#authBackdrop").waitFor({ state: "visible", timeout: 5000 });
    check(await page.locator("#authenticatedWorkspace").isHidden(), "invalid token exposed the authenticated workspace");
    check(await page.evaluate(() => localStorage.getItem("vko_token")) === null, "invalid token was not cleared");
    record("invalid stored token", "PASS", "expired /auth/me response returns to login and clears local state");
  } catch (error) { record("invalid stored token", "FAIL", error instanceof Error ? error.message : String(error)); }
  finally { await context.close(); await browser.close(); }
}

async function runLogoutFailSafe() {
  if (!chromium) return;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium", args: ["--no-sandbox", "--disable-crash-reporter"] });
  const context = await browser.newContext();
  context.setDefaultTimeout(8000);
  try {
    const { page } = await openFixturePage(context, { logoutAvailable: false });
    await page.locator("#accountButton").click();
    await page.locator("#logoutButton").click();
    await page.locator("#authBackdrop").waitFor({ state: "visible", timeout: 5000 });
    check(await page.evaluate(() => localStorage.getItem("vko_token")) === null, "failed logout left the local token active");
    check((await page.locator("#toastRegion").textContent()).includes("Сеанс не удалось завершить"), "failed logout warning was not shown");
    record("logout fail-safe", "PASS", "backend logout outage still clears local state and shows a non-blocking warning");
  } catch (error) { record("logout fail-safe", "FAIL", error instanceof Error ? error.message : String(error)); }
  finally { await context.close(); await browser.close(); }
}

if (chromium) {
  await runMapAcceptance();
  await runErrorAcceptance();
  await runInvalidLogin();
  await runInvalidStoredToken();
  await runLogoutFailSafe();
} else record("browser harness", "BLOCKED_EXTERNAL", `Playwright unavailable: ${playwrightLoadError || "browser launch failed"}`);

const passCount = report.surfaces.filter((item) => item.status === "PASS").length;
console.log(`BROWSER E2E ${report.failures.length ? "FAIL" : report.blockers.length ? "BLOCKED" : "PASS"}: live scaffold surfaces PASS=${passCount} FAIL=${report.failures.length} BLOCKED_EXTERNAL=${report.blockers.length}; demo=off`);
for (const item of report.surfaces) console.log(`${item.status} ${item.surface}: ${item.evidence}`);
if (report.failures.length) process.exitCode = 1;
else if (report.blockers.length) process.exitCode = 2;
