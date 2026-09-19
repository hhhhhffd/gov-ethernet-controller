const TOKEN_KEY = "vko_token";

export function createSession({ api, storage = globalThis.localStorage, onChange } = {}) {
  let token = storage?.getItem(TOKEN_KEY) || "";
  let user = null;
  const listeners = new Set();

  function snapshot() {
    return Object.freeze({ token, user, authenticated: Boolean(token && user) });
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
    notify();
  }
  async function login(credentials) {
    const response = await api.tryRequest([
      "/api/login",
      "/api/auth/login",
      "/api/v1/auth/login",
      "/api/v1/login",
    ], { method: "POST", body: JSON.stringify(credentials), _authRetried: true });
    const nextToken = response?.token || response?.access_token || response?.session;
    if (!nextToken) throw new Error("Ответ авторизации не содержит сессию");
    setToken(nextToken);
    user = response.user || null;
    notify();
    await bootstrap();
    return snapshot();
  }
  async function bootstrap() {
    if (!token) return snapshot();
    try {
      const response = await api.tryRequest(["/api/auth/me", "/api/v1/auth/me"]);
      user = response?.user || response;
      notify();
    } catch (error) {
      if ([401, 403].includes(error.status)) clear();
      throw error;
    }
    return snapshot();
  }
  async function logout() {
    if (token) await api.tryRequest(["/api/auth/logout", "/api/v1/auth/logout"], { method: "POST" });
    clear();
  }

  return {
    get token() { return token; },
    get user() { return user; },
    get authenticated() { return Boolean(token && user); },
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
