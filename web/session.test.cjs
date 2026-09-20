const assert = require("node:assert/strict");
const test = require("node:test");

const sessionModule = () => import("./core/session.mjs");
const TOKEN_STORAGE_KEY = "vko_token";

function memoryStorage(initialToken = "") {
  const values = new Map(initialToken ? [[TOKEN_STORAGE_KEY, initialToken]] : []);
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

test("AUTH-001 login stores token, then uses server-authoritative /auth/me", async () => {
  const { createSession, TOKEN_KEY, LOGIN_PATHS, ME_PATHS } = await sessionModule();
  const storage = memoryStorage();
  const calls = [];
  const api = {
    async tryRequest(paths, options = {}) {
      calls.push({ paths, options });
      if (calls.length === 1) return { token: "session-token", user: { role: "SCHOOL", capabilities: ["admin.manage"] } };
      return { user: { id: "user-1", username: "operator", role: "DISTRICT", scopes: [{ scope_type: "DISTRICT", scope_id: "d-1" }], capabilities: ["line.read", "incident.read"] } };
    },
  };
  const session = createSession({ api, storage });

  const state = await session.login({ username: "operator", password: "secret" });

  assert.deepEqual(calls[0].paths, LOGIN_PATHS);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[1].paths, ME_PATHS);
  assert.equal(state.authenticated, true);
  assert.equal(state.user.role, "DISTRICT");
  assert.deepEqual(state.user.capabilities, ["line.read", "incident.read"]);
  assert.equal(storage.getItem(TOKEN_KEY), "session-token");
});

test("AUTH-002 logout confirms revocation before clearing, and fail-safe clears on outage", async () => {
  const { createSession, TOKEN_KEY, ME_PATHS, LOGOUT_PATHS } = await sessionModule();
  const storage = memoryStorage("session-token");
  const calls = [];
  const api = {
    async tryRequest(paths, options = {}) {
      calls.push({ paths, options });
      return { user: { role: "SCHOOL", capabilities: ["line.read"] } };
    },
  };
  const session = createSession({ api, storage });
  await session.bootstrap();
  const result = await session.logout();

  assert.deepEqual(calls.at(-1).paths, LOGOUT_PATHS);
  assert.equal(calls.at(-1).options.method, "POST");
  assert.deepEqual(result, { serverConfirmed: true });
  assert.equal(session.authenticated, false);
  assert.equal(storage.getItem(TOKEN_KEY), null);

  const failedStorage = memoryStorage("session-token");
  const failedApi = {
    async tryRequest(paths) {
      if (paths === ME_PATHS) return { user: { role: "SCHOOL", capabilities: ["line.read"] } };
      throw Object.assign(new Error("backend unavailable"), { status: 503 });
    },
  };
  const failedSession = createSession({ api: failedApi, storage: failedStorage });
  await failedSession.bootstrap();
  await assert.rejects(() => failedSession.logout(), (error) => error.status === 503 && error.localStateCleared === true);
  assert.equal(failedSession.token, "");
  assert.equal(failedStorage.getItem(TOKEN_KEY), null);
});

test("invalid or revoked token cannot establish authenticated state", async () => {
  const { createSession, TOKEN_KEY, ME_PATHS } = await sessionModule();
  const storage = memoryStorage("expired-token");
  const api = { async tryRequest(paths) { assert.deepEqual(paths, ME_PATHS); throw httpError(401); } };
  const session = createSession({ api, storage });

  await assert.rejects(() => session.bootstrap(), (error) => error.status === 401);
  assert.equal(session.authenticated, false);
  assert.equal(session.token, "");
  assert.equal(storage.getItem(TOKEN_KEY), null);
});

test("CAP-001 and CAP-002 use explicit capabilities, not role labels", async () => {
  const { createCapabilityState } = await import("./core/capabilities.mjs");
  const adminWithoutManagement = createCapabilityState({ role: "ADMIN", capabilities: ["line.read", "audit.read"] });
  const operatorWithManagement = createCapabilityState({ role: "SCHOOL", capabilities: ["admin.manage", "notification.read"] });

  assert.equal(adminWithoutManagement.has("admin.manage"), false);
  assert.equal(adminWithoutManagement.has("audit.read"), true);
  assert.equal(adminWithoutManagement.has("notification.read"), false);
  assert.equal(operatorWithManagement.has("admin.manage"), true);
  assert.equal(operatorWithManagement.has("notification.read"), true);
});

test("session generation prevents a stale bootstrap from restoring the previous user", async () => {
  const { createSession, ME_PATHS } = await sessionModule();
  const storage = memoryStorage("old-session");
  let resolveProfile;
  const profile = new Promise((resolve) => { resolveProfile = resolve; });
  const api = { async tryRequest(paths) { assert.deepEqual(paths, ME_PATHS); return profile; } };
  const session = createSession({ api, storage });
  const pending = session.bootstrap();
  const oldGeneration = session.generation;

  session.clear();
  resolveProfile({ user: { role: "SCHOOL", capabilities: ["line.read"] } });
  const result = await pending;

  assert.equal(result.authenticated, false);
  assert.equal(session.user, null);
  assert.equal(session.token, "");
  assert.ok(session.generation > oldGeneration);
});

test("router writes navigations and restores routes on browser history changes", async () => {
  const { createShellRouter } = await import("./core/router.mjs");
  const location = { pathname: "/", search: "", hash: "" };
  const historyCalls = [];
  const history = {
    pushState(_state, _title, url) { historyCalls.push(["push", url]); location.hash = String(url).split("#")[1] ? `#${String(url).split("#")[1]}` : ""; },
    replaceState(_state, _title, url) { historyCalls.push(["replace", url]); location.hash = String(url).split("#")[1] ? `#${String(url).split("#")[1]}` : ""; },
  };
  const eventHandlers = new Map();
  const eventTarget = {
    addEventListener(name, handler) { eventHandlers.set(name, handler); },
    removeEventListener(name) { eventHandlers.delete(name); },
  };
  const changes = [];
  const router = createShellRouter({ locationObject: location, historyObject: history, eventTarget, onChange: (snapshot) => changes.push(snapshot.view) });

  assert.equal(router.navigate("reports"), true);
  assert.equal(location.hash, "#reports");
  assert.deepEqual(historyCalls[0], ["push", "/#reports"]);
  location.hash = "";
  eventHandlers.get("popstate")();
  assert.equal(router.getState().view, "map");
  assert.deepEqual(changes, ["reports", "map"]);
  router.destroy();
  assert.equal(eventHandlers.size, 0);
});

test("map integration ignores lines that resolve after the session generation changed", async () => {
  const { createMapIntegration } = await import("./integration/map-integration.mjs");
  const dataModel = require("./data-model.js");
  const registryPayload = { schools: [{ registry_id: "school-1", official_name: "School 1", district: "District", latitude: 50, longitude: 82 }] };
  const mappingPayload = { entries: [{ organization_id: "org-1", registry_id: "school-1", match_status: "AUTO_MATCH", confidence: 1 }] };
  const line = { id: "line-1", organization_id: "org-1", status: "OK", school_name: "School 1" };
  const pendingLines = new Promise((resolve) => { globalThis.__resolveMapLines = resolve; });
  let generation = 1;
  let renders = 0;
  const integration = createMapIntegration({
    session: { get generation() { return generation; } },
    api: { tryRequest() { return pendingLines; } },
    reports: {},
    dataModel: {
      ...dataModel,
      createDataLoader() { return { load: async () => ({ registryPayload, mappingPayload, registryUnavailable: false, mappingUnavailable: false }) }; },
    },
    mapApi: { render() { renders += 1; }, setPresentation() {}, setMapPresentation() {} },
  });

  const pendingLoad = integration.loadCurrent();
  generation = 2;
  globalThis.__resolveMapLines([line]);
  await pendingLoad;
  delete globalThis.__resolveMapLines;

  assert.deepEqual(integration.state.lines, []);
  assert.equal(integration.state.model, null);
  assert.equal(renders, 0);
  assert.equal(integration.state.loading, false);
});

test("map integration keeps an unmapped backend line in state, render context, and diagnostics", async () => {
  const { createMapIntegration, normalizeLine } = await import("./integration/map-integration.mjs");
  const dataModel = require("./data-model.js");
  const registryPayload = { schools: [{ registry_id: "registry-1", official_name: "Registry school", latitude: 50, longitude: 82 }] };
  const mappingPayload = { provenance: { operational_mapping_status: "NOT_PROVIDED" }, entries: [] };
  const rendered = [];
  const integration = createMapIntegration({
    session: { generation: 1 },
    api: { tryRequest: async () => [{ id: "line-unmapped", organization_id: "org-unmapped", school_id: "backend-school", latitude: 50.35, longitude: 82.62, status: "OK" }] },
    reports: {},
    dataModel: {
      ...dataModel,
      createDataLoader() { return { load: async () => ({ registryPayload, mappingPayload, registryUnavailable: false, mappingUnavailable: false }) }; },
    },
    mapApi: {
      render(context) { rendered.push(context); },
      setPresentation() {},
      setMapPresentation() {},
    },
  });

  assert.equal(normalizeLine({ pk: 42 }).id, null, "malformed backend rows must not receive a synthetic line id");
  await integration.loadCurrent();

  assert.equal(integration.state.lines.length, 1);
  assert.equal(integration.state.lines[0].mappingStatus, "MISSING_MAPPING");
  assert.equal(integration.state.view.lines.length, 0, "unmapped lines have no map marker without registry identity");
  assert.equal(integration.state.view.unmappedLines.length, 1);
  assert.equal(integration.state.view.authoritativeLines.length, 1);
  assert.equal(rendered.at(-1).lines.length, 1, "the map boundary must receive the authoritative row for diagnostics");
  assert.equal(integration.mappingDiagnostics().unmappedLineCount, 1);
  assert.equal(integration.registryStatus().state, "mapping-incomplete");
});
