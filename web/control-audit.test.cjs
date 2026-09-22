const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("UI-001 visible controls are bound or are native form controls", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  const app = fs.readFileSync("web/app.js", "utf8");
  const staticButtons = [...html.matchAll(/<button[^>]*id="([^"]+)"[^>]*>/g)].map((match) => match[1]);
  for (const id of staticButtons) {
    assert.ok(app.includes(`#${id}`), `${id} must be bound or route-gated`);
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
  assert.doesNotMatch(app, /mapApiAction\(/);
  assert.match(app, /LinkwatchMap\?\.getMap\?\.\(\)/);
  assert.match(app, /providerCase\.actionState !== "idle"/);
  assert.match(app, /state\.admin\.mutationState === "saving"/);
});

test("UI-004 capability-gated workflow controls use real helpers and pending states", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  for (const action of ["provider_fixed", "send_to_provider", "assign", "status"]) {
    assert.match(app, new RegExp(`data-incident-action=\\"${action}\\"`));
  }
  for (const action of ["live-verify", "merge", "split"]) {
    assert.match(app, new RegExp(`data-situation-action=\\"${action}\\"`));
  }
  assert.match(app, /incidentActions\(detail, state\.capabilities/);
  assert.match(app, /situationActions\(situation, state\.capabilities/);
  assert.match(app, /data-notification-dispatch/);
  assert.match(app, /root\.querySelectorAll\("\[data-notification-dispatch\]"\)/);
  assert.match(app, /providerCaseDeliveryRequest\(detail/);
  assert.match(app, /boundaries\.providerCases\.retry/);
  assert.match(app, /boundaries\.incidents\.manageSituation/);
  assert.match(app, /await boundaries\.incidents\.get\(incidentID\)/);
  assert.match(app, /await boundaries\.notifications\.list\(\{ limit: "50" \}\)/);
  assert.match(app, /availableNotification\.actions\?\.canDispatch/);
});

test("UI-005 admin and notification diagnostics stay out of primary human copy", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.match(app, /presentAdminRecord\(view\.resource, item/);
  assert.doesNotMatch(app, /adminTechnicalDetails/);
  assert.doesNotMatch(app, /class="admin-technical"/);
  assert.match(app, /view\.preview\?\.result/);
  assert.doesNotMatch(app, /function adminFieldLabel\(/);
  assert.doesNotMatch(app, /function adminDisplayValue\(/);
  assert.doesNotMatch(app, /<p>\" \+ escapeHtml\(item\.message\)/);
  assert.match(app, /state\.admin\.mutationState = "saving";\s*state\.admin\.preview = null;\s*state\.admin\.message = "";\s*renderAdminSurface\(\);\s*try/s);
});
