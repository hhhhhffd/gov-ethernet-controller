const THEME_KEY = "linkwatch_theme";

export function createThemeState({ storage = globalThis.localStorage, root = document.documentElement } = {}) {
  let theme = storage?.getItem(THEME_KEY) || "dark";
  function apply() {
    root?.setAttribute("data-theme", theme);
    root?.style.setProperty("color-scheme", theme);
  }
  apply();
  return {
    get theme() { return theme; },
    setTheme(nextTheme) {
      if (!["dark", "light"].includes(nextTheme)) return theme;
      theme = nextTheme;
      storage?.setItem(THEME_KEY, theme);
      apply();
      return theme;
    },
    mapPresentation() { return { theme, basemap: theme === "light" ? "light-compatible" : "dark-compatible" }; },
  };
}
