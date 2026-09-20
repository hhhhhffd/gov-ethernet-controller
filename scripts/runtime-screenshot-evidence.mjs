import fs from "node:fs";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = (process.env.RUNTIME_EVIDENCE_BASE_URL || "http://127.0.0.1:18080").replace(/\/$/, "");
const login = process.env.RUNTIME_EVIDENCE_LOGIN;
const password = process.env.RUNTIME_EVIDENCE_PASSWORD;
const outputDir = path.resolve(process.env.RUNTIME_EVIDENCE_OUTPUT || "artifacts");
const chromiumPath = process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium";

if (!login || !password) throw new Error("RUNTIME_EVIDENCE_LOGIN and RUNTIME_EVIDENCE_PASSWORD are required");

const viewport = { width: 1355, height: 880 };
const evidence = {
  baseURL,
  viewport,
  fixtureBoundary: {
    apiInterception: false,
    registryInterception: false,
    tileInterception: false,
    note: "The browser used the running server, its static registry/mapping assets, and direct Stadia tile responses."
  },
  runtime: {},
  network: { api: [], registry: [], mapping: [], tiles: [], failures: [] },
  screenshots: [],
  states: {},
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, predicate, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForPage(page, label, predicate, timeout = 20000) {
  await page.waitForFunction(predicate, undefined, { timeout }).catch((error) => {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function settleMapTiles(page) {
  await waitForPage(page, "loaded map tiles", () => document.querySelectorAll(".leaflet-tile-loaded").length >= 4);
  await sleep(1200);
}

async function screenshot(page, filename) {
  const target = path.join(outputDir, filename);
  await page.screenshot({ path: target, fullPage: false, animations: "disabled" });
  evidence.screenshots.push({ file: path.relative(process.cwd(), target), width: viewport.width, height: viewport.height });
}

function responseRecord(response) {
  const url = new URL(response.url());
  return { path: `${url.pathname}${url.search}`, status: response.status(), contentType: response.headers()["content-type"] || "" };
}

async function mapSnapshot(page) {
  return page.evaluate(() => {
    const map = window.LinkwatchMap?.getMap?.();
    const layers = window.LinkwatchMap?.getLayers?.();
    const lastRender = window.LinkwatchMap?.getLastRender?.();
    return {
      theme: document.documentElement.dataset.theme,
      mapTheme: document.querySelector("#leafletMap")?.dataset.mapTheme || "",
      mapStyle: document.querySelector("#leafletMap")?.dataset.mapStyle || "",
      mapLocale: document.querySelector("#leafletMap")?.dataset.mapLocale || "",
      zoom: map?.getZoom?.() ?? null,
      center: map?.getCenter?.() ? { latitude: map.getCenter().lat, longitude: map.getCenter().lng } : null,
      registryMarkers: layers?.registryMarkers?.length ?? 0,
      renderedClusters: document.querySelectorAll(".leaflet-marker-icon.linkwatch-registry-cluster").length,
      renderedRegistryMarkers: document.querySelectorAll(".leaflet-marker-icon.linkwatch-registry-marker").length,
      monitoringMarkers: layers?.monitoringMarkers?.length ?? 0,
      visibleSchools: document.querySelector("#mapVisibleSchoolCount")?.textContent?.trim() || "",
      lineCount: document.querySelector("#lineCount")?.textContent?.trim() || "",
      registryState: document.querySelector("#registryDataStatus")?.dataset.state || "",
      registryStatus: document.querySelector("#registryDataStatus")?.textContent || "",
      tileUrl: window.LinkwatchMap?.getConfig?.()?.tileUrl || "",
      lastRender: lastRender ? {
        mode: lastRender.mode,
        registryMarkerCount: lastRender.registryMarkerCount,
        monitoringMarkerCount: lastRender.monitoringMarkerCount,
        monitoringLineCount: lastRender.monitoringLineCount,
        fitCoordinateCount: lastRender.fitCoordinateCount,
        registryClusterCount: lastRender.registryClusterCount,
        registryVisibleMarkerCount: lastRender.registryVisibleMarkerCount,
      } : null,
    };
  });
}

async function boxSnapshot(page) {
  return page.evaluate(() => {
    const selectors = ["#mapWrap", ".shell-top-left", ".shell-top-right", "#mapFilter", ".map-tools"];
    return Object.fromEntries(selectors.map((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return [selector, box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null];
    }));
  });
}

function uniquePaths(items) {
  return [...new Map(items.map((item) => [`${item.path}|${item.status}`, item])).values()];
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ["--no-sandbox", "--disable-crash-reporter"] });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  context.setDefaultTimeout(12000);
  await context.addInitScript(() => localStorage.setItem("linkwatch_theme", "dark"));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error instanceof Error ? error.message : String(error)));
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("tiles.stadiamaps.com") || url.includes("/api/") || url.includes("/static/data/")) {
      evidence.network.failures.push({ url, error: request.failure()?.errorText || "unknown" });
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    const record = responseRecord(response);
    if (url.includes("/api/")) evidence.network.api.push(record);
    if (url.endsWith("/static/data/vko-schools.json")) evidence.network.registry.push(record);
    if (url.endsWith("/static/data/organization-school-map.json")) evidence.network.mapping.push(record);
    if (url.includes("tiles.stadiamaps.com/tiles/alidade_smooth_dark/")) evidence.network.tiles.push({ ...record, host: new URL(url).host });
  });

  try {
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#loginForm").waitFor({ state: "visible" });
    await screenshot(page, "task025-runtime-login-1355x880.png");
    evidence.states.login = { visible: true, title: await page.title() };

    await page.locator("#loginUsername").fill(login);
    await page.locator("#loginPassword").fill(password);
    await page.locator("#loginSubmit").click();
    await page.locator("#authBackdrop").waitFor({ state: "hidden" });
    await page.locator("#authenticatedWorkspace").waitFor({ state: "visible" });
    await waitForPage(page, "actual registry and line counts", () => document.querySelector("#mapVisibleSchoolCount")?.textContent?.trim() === "370" && document.querySelector("#lineCount")?.textContent?.trim() === "4");
    await waitForPage(page, "real registry clusters", () => document.querySelectorAll(".leaflet-marker-icon.linkwatch-registry-cluster").length > 0);
    await waitFor("a successful direct Stadia tile response", () => evidence.network.tiles.some((item) => item.status === 200));
    await settleMapTiles(page);

    evidence.runtime.authenticated = true;
    evidence.runtime.initialMap = await mapSnapshot(page);
    const assetSummary = await page.evaluate(async () => {
      const [registryResponse, mappingResponse] = await Promise.all([
        fetch("/static/data/vko-schools.json"),
        fetch("/static/data/organization-school-map.json"),
      ]);
      const registry = await registryResponse.json();
      const mapping = await mappingResponse.json();
      return {
        registryStatus: registryResponse.status,
        registrySchools: Array.isArray(registry?.schools) ? registry.schools.length : null,
        school32: registry?.schools?.find((school) => String(school.registry_id ?? school.registryId) === "18383") || null,
        mappingStatus: mappingResponse.status,
        mappingEntries: Array.isArray(mapping?.entries) ? mapping.entries.length : null,
        mappingRegistryOnly: Array.isArray(mapping?.registry_only) ? mapping.registry_only.length : null,
        mappingStatusLabel: mapping?.provenance?.operational_mapping_status || null,
      };
    });
    evidence.runtime.assets = assetSummary;
    evidence.runtime.initialBoxes = await boxSnapshot(page);
    evidence.runtime.pageErrorsAfterBootstrap = pageErrors.slice();
    await screenshot(page, "task025-runtime-map-dark-1355x880.png");

    const darkBoxes = await boxSnapshot(page);
    await page.locator("#themeToggle").click();
    await waitForPage(page, "light theme", () => document.documentElement.dataset.theme === "light");
    await settleMapTiles(page);
    evidence.runtime.lightMap = await mapSnapshot(page);
    evidence.runtime.lightBoxes = await boxSnapshot(page);
    await screenshot(page, "task025-runtime-map-light-1355x880.png");
    evidence.runtime.themeGeometryEqual = JSON.stringify(darkBoxes) === JSON.stringify(evidence.runtime.lightBoxes);

    await page.locator("#themeToggle").click();
    await waitForPage(page, "dark theme restore", () => document.documentElement.dataset.theme === "dark");
    await page.locator("#mapReset").click();
    await waitForPage(page, "reset map cluster view", () => document.querySelectorAll(".leaflet-marker-icon.linkwatch-registry-cluster").length > 0);

    const clusterBefore = await mapSnapshot(page);
    const cluster = page.locator(".leaflet-marker-icon.linkwatch-registry-cluster").first();
    await cluster.click();
    await waitForPage(page, "cluster expansion zoom", () => Number(window.LinkwatchMap?.getMap?.()?.getZoom?.() || 0) > 7);
    await page.locator("#mapPopup").waitFor({ state: "visible" });
    await settleMapTiles(page);
    evidence.states.clusterExpanded = {
      before: clusterBefore,
      after: await mapSnapshot(page),
      popupTitle: await page.locator("#mapPopupTitle").textContent(),
      memberCount: await page.locator("#mapPopup [data-popup-registry-id]").count(),
    };
    await screenshot(page, "task025-runtime-cluster-expanded-1355x880.png");
    await page.locator("#mapPopupClose").click();
    await page.locator("#mapReset").click();
    await waitForPage(page, "map reset after cluster", () => document.querySelectorAll(".leaflet-marker-icon.linkwatch-registry-cluster").length > 0);

    const search = page.locator("#schoolSearch");
    await search.fill("Средняя школа №32");
    await page.locator('#schoolSearchResults [data-registry-id="18383"]').waitFor({ state: "visible" });
    await page.locator('#schoolSearchResults [data-registry-id="18383"]').click();
    await page.locator("#mapPopup").waitFor({ state: "visible" });
    await settleMapTiles(page);
    evidence.states.school32 = {
      popupTitle: await page.locator("#mapPopupTitle").textContent(),
      popupSummary: await page.locator("#mapPopupSummary").textContent(),
      popupFields: await page.locator("#mapPopupFields").innerText(),
      map: await mapSnapshot(page),
      searchResultRegistryId: "18383",
    };
    await screenshot(page, "task025-runtime-school32-1355x880.png");
    await page.locator("#mapPopupClose").click();
    await search.fill("");
    await waitForPage(page, "map reset after school search", () => document.querySelectorAll(".leaflet-marker-icon.linkwatch-registry-cluster").length > 0);

    await page.locator('#primaryNav > [data-route="incidents"]:visible').click();
    await waitForPage(page, "incidents route", () => document.querySelector("#authenticatedWorkspace")?.dataset.route === "incidents");
    await page.locator('#incidentsSurface [data-incident-id]').first().waitFor({ state: "visible" });
    evidence.states.incidentsList = { count: await page.locator('#incidentsSurface [data-incident-id]').count(), text: (await page.locator("#incidentsSurface").innerText()).slice(0, 2500) };
    await screenshot(page, "task025-runtime-incidents-list-1355x880.png");
    await page.locator('#incidentsSurface [data-incident-id]').first().click();
    await page.locator("#incidentsSurface [data-incident-open-line]").waitFor({ state: "visible" });
    evidence.states.incidentDetail = { text: (await page.locator("#incidentsSurface").innerText()).slice(0, 4500) };
    await screenshot(page, "task025-runtime-incident-detail-1355x880.png");
    await page.locator("#incidentsSurface [data-incident-open-line]").click();
    await page.locator("#detailDrawer").waitFor({ state: "visible" });
    await waitForPage(page, "line detail drawer", () => document.querySelector("#detailDrawer")?.getAttribute("aria-hidden") === "false");
    evidence.states.lineDetail = { title: await page.locator("#drawerTitle").textContent(), text: (await page.locator("#detailDrawer").innerText()).slice(0, 4500) };
    await screenshot(page, "task025-runtime-line-detail-1355x880.png");
    await page.locator("#drawerClose").click();

    await page.locator('#primaryNav > [data-route="reports"]:visible').click();
    await waitForPage(page, "reports route", () => document.querySelector("#authenticatedWorkspace")?.dataset.route === "reports");
    await page.locator("#reportsSurface [data-report-filters]").waitFor({ state: "visible" });
    await waitForPage(page, "reports loaded", () => !document.querySelector("#reportsSurface .reports-shell")?.textContent?.includes("Загрузка"));
    evidence.states.reports = { text: (await page.locator("#reportsSurface").innerText()).slice(0, 6000) };
    await screenshot(page, "task025-runtime-reports-1355x880.png");

    evidence.runtime.pageErrorsFinal = pageErrors.slice();
    evidence.network.api = uniquePaths(evidence.network.api);
    evidence.network.registry = uniquePaths(evidence.network.registry);
    evidence.network.mapping = uniquePaths(evidence.network.mapping);
    evidence.network.tiles = uniquePaths(evidence.network.tiles);
    evidence.runtime.runtimeAssertions = {
      actualAPI: evidence.network.api.length > 0,
      actualRegistry: evidence.network.registry.some((item) => item.status === 200),
      actualMappingAsset: evidence.network.mapping.some((item) => item.status === 200),
      actualAlidadeTiles: evidence.network.tiles.some((item) => item.status === 200),
      noPageErrors: evidence.runtime.pageErrorsFinal.length === 0,
      mappingIsNotPopulated: evidence.runtime.assets.mappingEntries === 0 && evidence.runtime.initialMap.monitoringMarkers === 0,
    };
    check(evidence.runtime.runtimeAssertions.actualAPI, "no API responses were observed");
    check(evidence.runtime.runtimeAssertions.actualRegistry, "the real registry response was not observed");
    check(evidence.runtime.runtimeAssertions.actualAlidadeTiles, "a successful Alidade tile response was not observed");
    check(evidence.runtime.runtimeAssertions.noPageErrors, `page errors: ${evidence.runtime.pageErrorsFinal.join("; ")}`);

    fs.writeFileSync(path.join(outputDir, "task025-runtime-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({
      status: "PASS",
      baseURL,
      viewport,
      screenshots: evidence.screenshots.map((item) => item.file),
      initialMap: evidence.runtime.initialMap,
      clusterExpanded: evidence.states.clusterExpanded,
      school32: { popupTitle: evidence.states.school32.popupTitle, zoom: evidence.states.school32.map.zoom },
      incidents: evidence.states.incidentsList.count,
      reports: Boolean(evidence.states.reports),
      network: { api: evidence.network.api.length, registry: evidence.network.registry, mapping: evidence.network.mapping, tiles: evidence.network.tiles.length },
      mappingIsNotPopulated: evidence.runtime.runtimeAssertions.mappingIsNotPopulated,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

await main();
