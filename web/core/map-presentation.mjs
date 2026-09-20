export const CANONICAL_DARK_MAP_STYLE = "alidade-smooth-dark";
export const CANONICAL_LIGHT_MAP_STYLE = "alidade-smooth";

// Kept as a compatibility export for consumers of the previous adapter shape.
// Light mode now has its own canonical style, so there is no fallback.
export const LIGHT_MAP_FALLBACK = null;

function supportedTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function supportedLocale(locale) {
  return locale === "kk" ? "kk" : "ru";
}

// Tile URLs and attribution remain owned by web/map.js. This adapter exposes
// only the agreed canonical style names and presentation state.
export function createMapPresentationAdapter({ theme = "dark", locale = "ru" } = {}) {
  let currentTheme = supportedTheme(theme);
  let currentLocale = supportedLocale(locale);

  function snapshot() {
    return Object.freeze({
      theme: currentTheme,
      locale: currentLocale,
      style: currentTheme === "light" ? CANONICAL_LIGHT_MAP_STYLE : CANONICAL_DARK_MAP_STYLE,
      fallback: null,
      labels: "application-presentation",
    });
  }

  return {
    get theme() { return currentTheme; },
    get locale() { return currentLocale; },
    setTheme(nextTheme) { currentTheme = supportedTheme(nextTheme); return snapshot(); },
    setLocale(nextLocale) { currentLocale = supportedLocale(nextLocale); return snapshot(); },
    snapshot,
  };
}
