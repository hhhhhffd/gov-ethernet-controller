const PRIMARY_VIEWS = Object.freeze(["map", "incidents", "reports"]);
const SECONDARY_VIEWS = Object.freeze(["notifications", "admin", "audit"]);

export function createShellRouter({ canAccess = () => true, onChange } = {}) {
  let view = "map";
  let overlay = null;
  function snapshot() { return Object.freeze({ view, overlay }); }
  function notify() { onChange?.(snapshot()); }
  return {
    getState: snapshot,
    navigate(nextView) {
      if (![...PRIMARY_VIEWS, ...SECONDARY_VIEWS].includes(nextView) || !canAccess(nextView)) return false;
      view = nextView;
      notify();
      return true;
    },
    openOverlay(nextOverlay) { overlay = nextOverlay || null; notify(); return snapshot(); },
    closeOverlay() { overlay = null; notify(); },
    primaryViews: PRIMARY_VIEWS,
    secondaryViews: SECONDARY_VIEWS,
  };
}
