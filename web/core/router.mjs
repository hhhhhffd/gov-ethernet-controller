const PRIMARY_VIEWS = Object.freeze(["map", "incidents", "situations", "cases", "reports"]);
const SECONDARY_VIEWS = Object.freeze(["notifications", "admin", "audit"]);
const ALL_VIEWS = Object.freeze([...PRIMARY_VIEWS, ...SECONDARY_VIEWS]);

function routeFromLocation(locationObject) {
  const route = String(locationObject?.hash || "").replace(/^#/, "");
  return route || "map";
}

export function createShellRouter({ canAccess = () => true, onChange, historyObject = globalThis.history, locationObject = globalThis.location, eventTarget = globalThis } = {}) {
  let view = "map";
  let overlay = null;
  const listeners = [];
  function snapshot() { return Object.freeze({ view, overlay }); }
  function notify() { onChange?.(snapshot()); }
  function canNavigate(nextView) { return ALL_VIEWS.includes(nextView) && canAccess(nextView); }
  function writeLocation(nextView, replace) {
    if (!historyObject) return;
    const method = replace ? "replaceState" : "pushState";
    if (typeof historyObject[method] !== "function") return;
    const base = `${locationObject?.pathname || ""}${locationObject?.search || ""}`;
    const hash = nextView === "map" ? "" : `#${nextView}`;
    historyObject[method]({ route: nextView }, "", `${base}${hash}` || hash || "/");
  }
  function syncFromLocation({ replaceInvalid = true } = {}) {
    const candidate = routeFromLocation(locationObject);
    const nextView = canNavigate(candidate) ? candidate : "map";
    if (nextView === view) {
      if (replaceInvalid && candidate !== nextView) writeLocation(nextView, true);
      return false;
    }
    view = nextView;
    notify();
    if (replaceInvalid && candidate !== nextView) writeLocation(nextView, true);
    return true;
  }
  function handleHistoryChange() { syncFromLocation(); }
  if (eventTarget?.addEventListener) {
    eventTarget.addEventListener("popstate", handleHistoryChange);
    eventTarget.addEventListener("hashchange", handleHistoryChange);
    listeners.push(["popstate", handleHistoryChange], ["hashchange", handleHistoryChange]);
  }
  return {
    getState: snapshot,
    navigate(nextView, { replace = false, silentHistory = false } = {}) {
      if (!canNavigate(nextView)) return false;
      if (view === nextView) {
        if (!silentHistory) writeLocation(nextView, replace);
        return true;
      }
      view = nextView;
      notify();
      if (!silentHistory) writeLocation(nextView, replace);
      return true;
    },
    syncFromLocation,
    openOverlay(nextOverlay) { overlay = nextOverlay || null; notify(); return snapshot(); },
    closeOverlay() { overlay = null; notify(); },
    primaryViews: PRIMARY_VIEWS,
    secondaryViews: SECONDARY_VIEWS,
    destroy() { listeners.forEach(([eventName, listener]) => eventTarget?.removeEventListener?.(eventName, listener)); },
  };
}
