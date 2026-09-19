const TOKEN_KEY = "vko_token";

const LOGIN_PATHS = Object.freeze([
  "/api/login",
  "/api/auth/login",
  "/api/v1/auth/login",
  "/api/v1/login",
]);
const ME_PATHS = Object.freeze(["/api/auth/me", "/api/v1/auth/me"]);
const LOGOUT_PATHS = Object.freeze(["/api/auth/logout", "/api/v1/auth/logout"]);

export function createSession({ api, storage = globalThis.localStorage, onChange } = {}) {
  let token = storage?.getItem(TOKEN_KEY) || "";
  let user = null;
  let phase = token ? "resolving" : "anonymous";
  const listeners = new Set();

  function snapshot() {
    return Object.freeze({
      token,
      user,
      phase,
      resolving: phase === "resolving",
      authenticated: phase === "authenticated" && Boolean(token && user),
    });
  }
  function notify() {
    const next = snapshot();
    onChange?.(next);
    listeners.forEach((listener) => listener(next));
  }
  function setToken(nextToken) {
    token = nextToken || "";
    if (token) storage?.setItem(TOKEN_KEY, token);
    else storage?.removeItem(TOKEN_KEY);
  }
  function clear() {
    setToken("");
    user = null;
    phase = "anonymous";
    notify();
  }
  async function login(credentials) {
    clear();
    try {
      const response = await api.tryRequest(LOGIN_PATHS, { method: "POST", body: JSON.stringify(credentials), _authRetried: true });
      const nextToken = response?.token || response?.access_token || response?.session;
      if (!nextToken) throw new Error("Ответ авторизации не содержит сессию");
      setToken(nextToken);
      phase = "resolving";
      notify();
      await bootstrap();
      return snapshot();
    } catch (error) {
      clear();
      throw error;
    }
  }
  async function bootstrap() {
    if (!token) {
      phase = "anonymous";
      return snapshot();
    }
    phase = "resolving";
    notify();
    try {
      const response = await api.tryRequest(ME_PATHS, { _authRetried: true });
      const nextUser = response?.user || response;
      if (!nextUser || !nextUser.role || !Array.isArray(nextUser.capabilities)) {
        throw new Error("Ответ профиля не содержит серверные полномочия");
      }
      user = nextUser;
      phase = "authenticated";
      notify();
    } catch (error) {
      clear();
      throw error;
    }
    return snapshot();
  }
  async function logout() {
    if (!token) {
      clear();
      return { serverConfirmed: true };
    }
    try {
      await api.tryRequest(LOGOUT_PATHS, { method: "POST", _authRetried: true });
      clear();
      return { serverConfirmed: true };
    } catch (error) {
      clear();
      error.localStateCleared = true;
      throw error;
    }
  }

  return {
    get token() { return token; },
    get user() { return user; },
    get authenticated() { return phase === "authenticated" && Boolean(token && user); },
    get resolving() { return phase === "resolving"; },
    getState: snapshot,
    login,
    bootstrap,
    logout,
    clear,
    hasToken: () => Boolean(token),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export { TOKEN_KEY };
export { LOGIN_PATHS, ME_PATHS, LOGOUT_PATHS };
