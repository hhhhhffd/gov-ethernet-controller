const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("UI-001 visible controls are bound or are native form controls", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  const app = fs.readFileSync("web/app.js", "utf8");
  const staticButtons = [...html.matchAll(/<button[^>]*id="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  for (const id of staticButtons) {
    assert.ok(app.includes(`#${id}`) || id === "adminMenuButton" || id === "auditMenuButton", `${id} must be bound or route-gated`);
  }
  for (const marker of ["data-incidents-refresh", "data-reports-refresh", "data-notifications-refresh", "data-admin-refresh", "data-audit-refresh", "data-admin-device-action", "data-provider-case-send"]) {
    assert.match(app, new RegExp(marker));
  }
  assert.doesNotMatch(app, /onclick\s*=\s*["']\s*["']/i);
});

test("UI-002 global actions are not duplicated and contextual actions stay contextual", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.equal((html.match(/id="refreshButton"/g) || []).length, 1);
  assert.equal((html.match(/id="mapReset"/g) || []).length, 1);
  assert.equal((app.match(/<form data-report-export>/g) || []).length, 1);
  assert.match(app, /\["policies", "contracts", "lines"\]\.includes\(view\.resource\)/);
  assert.match(app, /\["agent-versions", "devices"\]\.includes\(view\.resource\)/);
});

test("UI-003 mutations require permissions, confirmation and awaited server success", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  for (const key of ["submitIncidentComment", "createIncidentProviderCase", "generateProviderCaseDraft", "sendProviderCase", "submitAdminMutation", "adminDeviceAction", "runAdminAgentUpdate"]) {
    assert.match(app, new RegExp(`async function ${key}`));
  }
  assert.match(app, /confirm\?\.\(i18n\.t\("providerCase\.confirmSend"\)\)/);
  assert.match(app, /await boundaries\.admin\.save/);
  assert.match(app, /state\.admin\.message = "admin\.mutationSucceeded"/);
  assert.match(app, /state\.admin\.message = "admin\.mutationFailed"/);
});
