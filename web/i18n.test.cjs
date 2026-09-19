const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

test("LANG-001 and LANG-002 translate all shell keys in RU and KK", async () => {
  const { MESSAGES, createI18n } = await import("./core/i18n.mjs");
  const html = fs.readFileSync("web/index.html", "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)].map((match) => match[1]);
  for (const locale of ["ru", "kk"]) {
    const i18n = createI18n({ locale, storage: memoryStorage(), root: { setAttribute() {} } });
    for (const key of keys) assert.equal(typeof MESSAGES[locale][key], "string", locale + " is missing " + key);
    assert.notEqual(i18n.t("status.NO_INTERNET"), "NO_INTERNET");
  }
});

test("presentation dictionaries have identical RU and KK coverage", async () => {
  const { MESSAGES } = await import("./core/i18n.mjs");
  assert.deepEqual(Object.keys(MESSAGES.ru).sort(), Object.keys(MESSAGES.kk).sort());
});

test("LANG-003 persists locale and updates html.lang", async () => {
  const { LOCALE_STORAGE_KEY, createI18n } = await import("./core/i18n.mjs");
  const storage = memoryStorage();
  const root = { lang: "", setAttribute(name, value) { if (name === "lang") this.lang = value; } };
  const i18n = createI18n({ storage, root });
  i18n.setLocale("kk");
  assert.equal(root.lang, "kk");
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), "kk");
  assert.equal(createI18n({ storage, root }).locale, "kk");
});

test("LANG-004 map presentation follows locale and never exposes unknown API values", async () => {
  const { createI18n } = await import("./core/i18n.mjs");
  const { createPresentation } = await import("./core/presentation.mjs");
  const storage = memoryStorage();
  const presentation = createPresentation(createI18n({ storage, root: { setAttribute() {} } }));
  assert.equal(presentation.status("NO_INTERNET").label, "Нет интернета");
  assert.equal(presentation.status("new_backend_code").label, "Состояние неизвестно");
  assert.equal(presentation.schoolName({ officialName: "Official", nameKk: "Ресми атау" }), "Official");
  const kk = createPresentation(createI18n({ locale: "kk", storage, root: { setAttribute() {} } }));
  assert.equal(kk.status("NO_INTERNET").label, "Интернет жоқ");
  assert.equal(kk.schoolName({ officialName: "Official", nameKk: "Ресми атау" }), "Ресми атау");
  assert.equal(kk.schoolName({ officialName: "Official", officialNameKk: "Ресми атау" }), "Ресми атау");
  assert.equal(kk.event("PROVIDER_CASE_DELIVERY_FAILED"), "Провайдерге өтініш жеткізілмеді");
  assert.equal(kk.action("configuration.impact_preview"), "Өзгерістер әсерін тексеру");
  assert.equal(kk.action("unrecognized_action"), "Жүйелік әрекет");
  assert.match(fs.readFileSync("web/app.js", "utf8"), /i18n\.subscribe\(refreshLocale\)/);
  assert.match(fs.readFileSync("web/map.js", "utf8"), /setPresentation/);
});
