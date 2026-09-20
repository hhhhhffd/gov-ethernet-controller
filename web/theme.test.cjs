const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function root() {
  return {
    attributes: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

function lightThemeBlock(styles) {
  const match = styles.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "light token block is required");
  return match[1];
}

test("THEME-001 Dark theme matches reference geometry", async () => {
  const { createThemeState } = await import("./core/theme.mjs");
  const target = root();
  const theme = createThemeState({ storage: memoryStorage(), root: target, matchMedia: () => ({ matches: false }) });
  const styles = fs.readFileSync("web/styles.css", "utf8");
  const html = fs.readFileSync("web/index.html", "utf8");
  assert.equal(theme.theme, "dark");
  assert.equal(target.attributes["data-theme"], "dark");
  assert.match(styles, /--theme-control-size:\s*37px/);
  assert.match(styles, /--theme-control-radius:\s*10px/);
  assert.match(styles, /\.reference-nav-item[\s\S]*height:\s*var\(--theme-control-size\)/);
  assert.match(styles, /\.reference-icon-button[\s\S]*width:\s*var\(--theme-control-size\)/);
  assert.match(html, /id="themeToggle"/);
});

test("THEME-002 Light theme preserves exact geometry", async () => {
  const { createThemeState } = await import("./core/theme.mjs");
  const target = root();
  const theme = createThemeState({ storage: memoryStorage(), root: target, matchMedia: () => ({ matches: true }) });
  const styles = fs.readFileSync("web/styles.css", "utf8");
  assert.equal(theme.theme, "light", "system preference is only the initial default");
  assert.equal(target.attributes["data-theme"], "light");
  assert.doesNotMatch(lightThemeBlock(styles), /--theme-(?:control-size|control-radius|shell-top|shell-right|panel-radius)|\b(?:width|height|padding|margin|gap|font-size)\s*:/);
});

test("THEME-003 Theme persists reload", async () => {
  const { THEME_STORAGE_KEY, createThemeState } = await import("./core/theme.mjs");
  const storage = memoryStorage();
  const first = createThemeState({ storage, root: root(), matchMedia: () => ({ matches: false }) });
  first.setTheme("light");
  const reloaded = createThemeState({ storage, root: root(), matchMedia: () => ({ matches: false }) });
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "light");
  assert.equal(reloaded.preference, "light");
  assert.equal(reloaded.theme, "light");
});

test("THEME-004 Map presentation adapter preserves canonical basemap and locale state", async () => {
  const {
    CANONICAL_DARK_MAP_STYLE,
    CANONICAL_LIGHT_MAP_STYLE,
    LIGHT_MAP_FALLBACK,
    createMapPresentationAdapter,
  } = await import("./core/map-presentation.mjs");
  const adapter = createMapPresentationAdapter({ theme: "dark", locale: "ru" });
  const dark = adapter.snapshot();
  const light = adapter.setTheme("light");
  const kk = adapter.setLocale("kk");
  const mapSource = fs.readFileSync("web/map.js", "utf8");
  assert.equal(dark.style, CANONICAL_DARK_MAP_STYLE);
  assert.equal(dark.fallback, null);
  assert.equal(light.style, CANONICAL_LIGHT_MAP_STYLE);
  assert.equal(light.fallback, LIGHT_MAP_FALLBACK);
  assert.equal(kk.locale, "kk");
  assert.equal(Object.hasOwn(light, "tileUrl"), false, "adapter must not invent a light provider URL");
  assert.equal(CANONICAL_LIGHT_MAP_STYLE, "alidade-smooth");
  assert.match(mapSource, /alidade_smooth_dark/);
  assert.match(mapSource, /alidade_smooth/);
  assert.match(mapSource, /Stadia Maps/);
  assert.match(mapSource, /setMapPresentation/);
});
