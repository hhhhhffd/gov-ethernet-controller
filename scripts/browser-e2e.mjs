const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = process.env.BROWSER_E2E_BASE_URL || "http://127.0.0.1:8080";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_E2E_CHROMIUM || "/usr/sbin/chromium",
  args: ["--no-sandbox", "--disable-crash-reporter"],
});

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function login(page, username, password) {
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#loginUsername").fill(username);
  await page.locator("#loginPassword").fill(password);
  await page.locator("#loginSubmit").click();
  await page.locator("#lineCount").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#lineCount")?.textContent?.trim() !== "—");
}

async function seedSession(page, username, password) {
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  const token = await page.evaluate(async ({ username: login, password: secret }) => {
    const response = await fetch("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login, password: secret }) });
    if (!response.ok) throw new Error(`login returned ${response.status}`);
    return (await response.json()).token;
  }, { username, password });
  await page.evaluate((value) => localStorage.setItem("vko_token", value), token);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#lineCount").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#lineCount")?.textContent?.trim() !== "—");
}

const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await login(admin, "admin", "demo");
check(await admin.locator("#linesTableBody").isVisible(), "admin line list surface did not load");
await admin.locator("#passportButton").click();
await admin.locator("#passportGrid").waitFor({ state: "visible" });
await admin.waitForTimeout(1000);
check(await admin.locator("#passportGrid").textContent(), "passport did not render");
check(await admin.locator("#exportDownload").isVisible(), "export flow is not visible");
await admin.locator("[data-view='incidents']").first().click();
await admin.locator("#incidentBoard").waitFor({ state: "visible" });
const providerDraft = admin.locator("[data-incident-action='draft']").first();
if (await providerDraft.count()) {
  await providerDraft.click();
  await admin.waitForTimeout(500);
}
const providerGate = await admin.evaluate(async () => {
  const headers = { Authorization: `Bearer ${localStorage.getItem("vko_token")}` };
  const cases = await (await fetch("/api/v1/provider-cases?limit=1", { headers })).json();
  const item = cases.items?.[0];
  if (!item) return { status: null };
  const response = await fetch(`/api/v1/provider-cases/${item.id}/send`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ reviewed: false }) });
  return { status: response.status };
});
check(providerGate.status === null || providerGate.status === 409, `provider send gate returned ${providerGate.status}`);
await admin.locator("[data-view='notifications']").first().click();
await admin.locator("#notificationList").waitFor({ state: "visible" });
await admin.locator("[data-view='audit']").first().click();
await admin.locator("#auditTable").waitFor({ state: "visible" });
await admin.locator("#passportButton").click();
await admin.locator("#exportDownload").waitFor({ state: "visible" });
const exportStatus = await admin.evaluate(async () => {
  const response = await fetch("/api/v1/exports/preview?kind=raw&format=csv&period=week", { headers: { Authorization: `Bearer ${localStorage.getItem("vko_token")}` } });
  return response.status;
});
check(exportStatus === 200, `admin export preview returned ${exportStatus}`);
const download = await Promise.all([
  admin.waitForEvent("download"),
  admin.locator("#exportDownload").click(),
]);
check(download[0].suggestedFilename().includes("vko-"), "export download filename was not produced");
await admin.close();

const providerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const provider = await providerContext.newPage();
await seedSession(provider, "provider-a", "demo");
check(await provider.locator("[data-view='admin']").evaluate((element) => element.hidden), "provider saw admin navigation");
await provider.waitForTimeout(1000);
check(await provider.locator(".provider-workspace").count() === 1, "provider workspace UI did not render");
const providerCases = await provider.evaluate(async () => {
  const response = await fetch("/api/v1/provider-cases?limit=10", { headers: { Authorization: `Bearer ${localStorage.getItem("vko_token")}` } });
  return { status: response.status, body: response.ok ? await response.json() : null };
});
check(providerCases.status === 200, `provider workspace returned ${providerCases.status}`);
const adminStatus = await provider.evaluate(async () => (await fetch("/api/v1/admin/devices", { headers: { Authorization: `Bearer ${localStorage.getItem("vko_token")}` } })).status);
check(adminStatus === 403, `provider admin boundary returned ${adminStatus}, expected 403`);
await provider.close();
await providerContext.close();

const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mobile = await mobileContext.newPage();
await seedSession(mobile, "admin", "demo");
check(await mobile.locator("#menuToggle").isVisible(), "mobile navigation control did not render");
check(await mobile.locator("#linesTableBody").isVisible(), "mobile line table did not render");
await mobileContext.close();

console.log("BROWSER E2E PASS: admin/provider authenticated journeys");
await browser.close();
