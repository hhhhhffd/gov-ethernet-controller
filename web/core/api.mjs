/* The browser talks to LINKWATCH through one authenticated request boundary. */
export function createApiClient({ getToken, onUnauthorized, onForbidden } = {}) {
  let recoveryHandlers = { onUnauthorized, onForbidden };

  const request = async (path, options = {}) => {
    const { _authRetried = false, _capabilityRetried = false, ...fetchOptions } = options;
    const headers = {
      Accept: "application/json",
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(fetchOptions.headers || {}),
    };
    const token = getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(path, { ...fetchOptions, headers });
    if (response.status === 401 && !_authRetried) {
      await recoveryHandlers.onUnauthorized?.();
      return request(path, { ...options, _authRetried: true });
    }
    if (response.status === 403 && token && !_capabilityRetried) {
      await recoveryHandlers.onForbidden?.();
      return request(path, { ...options, _capabilityRetried: true });
    }
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(body || `HTTP ${response.status}`);
      error.status = response.status;
      error.path = path;
      throw error;
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("json") ? response.json() : response;
  };

  const tryRequest = async (paths, options = {}) => {
    let lastError = null;
    for (const path of paths) {
      try {
        return await request(path, options);
      } catch (error) {
        lastError = error;
        if (![404, 405].includes(error.status)) break;
      }
    }
    throw lastError || new Error("API недоступен");
  };

  return {
    request,
    tryRequest,
    setRecoveryHandlers(nextHandlers) {
      recoveryHandlers = { ...recoveryHandlers, ...nextHandlers };
    },
    async download(paths, options = {}) {
      const response = await tryRequest(paths, options);
      if ((typeof Response !== "undefined" && response instanceof Response) || typeof response?.blob === "function") return response;
      throw new Error("Ожидался файл, но сервер вернул JSON");
    },
  };
}

export function unwrapCollection(value, keys = ["items", "data", "results"]) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (value && Array.isArray(value[key])) return value[key];
  return [];
}

export function apiAliases(path) {
  return [`/api${path}`, `/api/v1${path}`];
}
