export const THEME_STORAGE_KEY = "linkwatch_theme";
export const SUPPORTED_THEMES = Object.freeze(["dark", "light"]);

function preferredSystemTheme(matchMedia) {
  return matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

export function createThemeState({ storage = globalThis.localStorage, root = globalThis.document?.documentElement, matchMedia = globalThis.matchMedia } = {}) {
  const storedPreference = storage?.getItem(THEME_STORAGE_KEY);
  let preference = SUPPORTED_THEMES.includes(storedPreference) ? storedPreference : null;
  let theme = preference || preferredSystemTheme(matchMedia);
  const listeners = new Set();
  function apply() {
    root?.setAttribute("data-theme", theme);
    root?.style.setProperty("color-scheme", theme);
  }
  apply();
  return {
    get theme() { return theme; },
    get preference() { return preference; },
    setTheme(nextTheme) {
      if (!SUPPORTED_THEMES.includes(nextTheme)) return theme;
      theme = nextTheme;
      preference = theme;
      storage?.setItem(THEME_STORAGE_KEY, theme);
      apply();
      listeners.forEach((listener) => listener(theme));
      return theme;
    },
    toggle() { return this.setTheme(theme === "dark" ? "light" : "dark"); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
