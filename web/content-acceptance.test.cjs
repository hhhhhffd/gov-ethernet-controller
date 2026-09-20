const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("CONTENT-001 product dictionaries contain no prohibited backend jargon", async () => {
  const { MESSAGES } = await import("./core/i18n.mjs");
  const visibleCopy = Object.values(MESSAGES).flatMap((locale) => Object.values(locale)).join("\n");
  for (const prohibited of [/\bBackend\b/i, /\bLineState\b/i, /provider\.case/i, /incident\.status/i, /\boutage\b/i, /SYSTEM ONLINE/i, /LIVE DATA/i, /source_type/i, /delivery_status/i, /HTTP \d{3}/i]) {
    assert.doesNotMatch(visibleCopy, prohibited, String(prohibited));
  }
});

test("CONTENT-002 normal surfaces have concise empty/error copy and real retry controls", () => {
  const source = fs.readFileSync("web/app.js", "utf8");
  assert.match(source, /incidents\.empty/);
  assert.match(source, /incidents\.unavailable/);
  assert.match(source, /data-incidents-refresh/);
  assert.match(source, /reports\.unavailable/);
  assert.match(source, /admin\.unavailable/);
  assert.match(source, /audit\.unavailable/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*['"`][^\n]*(?:SYSTEM ONLINE|LIVE DATA|LineState|provider\.case)/i);
});

test("CONTENT-003 technical values are confined to explicit details or diagnostics", () => {
  const source = fs.readFileSync("web/app.js", "utf8");
  assert.match(source, /<details><summary.*audit\.technical/);
  assert.match(source, /<details><summary.*admin\.details/);
  assert.doesNotMatch(source, /textContent\s*=\s*[^;]*source_type/);
});
