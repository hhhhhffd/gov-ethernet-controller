const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("A11Y-001 icon controls have labels and contextual surfaces have dialog semantics", () => {
  const html = fs.readFileSync("web/index.html", "utf8");
  for (const id of ["themeToggle", "refreshButton", "notificationsButton", "mapZoomIn", "mapZoomOut", "mapReset", "mapPopupClose", "drawerClose"]) {
    const control = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] || "";
    assert.ok(/data-i18n-aria-label|aria-label/.test(control), `${id} needs an accessible name`);
  }
  assert.match(html, /id="mapPopup"[^>]*role="dialog"/);
  assert.match(html, /id="detailDrawer"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="schoolSearch"[^>]*role="combobox"[^>]*aria-controls="schoolSearchResults"[^>]*aria-expanded="false"/);
  assert.match(html, /id="schoolSearchResults"[^>]*role="listbox"/);
});

test("A11Y-002 overlay focus is trapped and Escape closes contextual surfaces", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.match(app, /function trapOverlayFocus/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /closeNotifications\(\)/);
  assert.match(app, /drawerTrigger/);
  assert.match(app, /trigger\?\.getElement\?\.\(\) \|\| trigger/);
  assert.match(app, /state\.mapPopupTrigger/);
  assert.match(app, /notificationsTrigger/);
  assert.match(app, /notificationCloseLabel/);
  assert.match(app, /handleSchoolSearchKeydown/);
});

test("A11Y-003 locale labels identify the selected language and notification close is contextual", () => {
  const app = fs.readFileSync("web/app.js", "utf8");
  assert.match(app, /locale\.switch.*locale\.kk/);
  assert.match(app, /locale\.switch.*locale\.ru/);
  assert.doesNotMatch(app, /data-notifications-close aria-label=.*action\.closeMapCard/);
  assert.match(app, /setSearchComboboxState/);
  assert.match(app, /aria-activedescendant/);
});

test("RESP-001 smaller widths preserve a map workspace instead of a card feed", () => {
  const styles = fs.readFileSync("web/styles.css", "utf8");
  assert.match(styles, /@media \(max-width: 1199px\)/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /@media \(max-width: 620px\)/);
  assert.match(styles, /\.nav-overflow/);
  assert.match(styles, /#primaryNav > \[data-route="incidents"\].*display: none/);
  assert.match(styles, /\.leaflet-map\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(styles, /\.workspace\s*\{[^}]*display:\s*grid[^}]*grid-template-columns/);
});

test("RESP-002 theme tokens do not change canonical geometry", () => {
  const styles = fs.readFileSync("web/styles.css", "utf8");
  const light = styles.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(light, /--theme-(?:control-size|control-radius|shell-top|shell-right|panel-radius)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
