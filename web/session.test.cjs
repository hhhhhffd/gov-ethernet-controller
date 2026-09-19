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
