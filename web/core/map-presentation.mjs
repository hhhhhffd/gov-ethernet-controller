export const CANONICAL_DARK_MAP_STYLE = "alidade-smooth-dark";
export const LIGHT_MAP_FALLBACK = "preserve-canonical-dark-basemap";

function supportedTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function supportedLocale(locale) {
  return locale === "kk" ? "kk" : "ru";
}

// Stadia's verified Alidade Smooth Dark URL and attribution remain owned by
// web/map.js. A confirmed light provider has not been supplied, so this
// adapter deliberately never fabricates a light tile URL.
export function createMapPresentationAdapter({ theme = "dark", locale = "ru" } = {}) {
  let currentTheme = supportedTheme(theme);
  let currentLocale = supportedLocale(locale);

  function snapshot() {
    const isLight = currentTheme === "light";
    return Object.freeze({
      theme: currentTheme,
      locale: currentLocale,
      style: CANONICAL_DARK_MAP_STYLE,
      fallback: isLight ? LIGHT_MAP_FALLBACK : null,
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
