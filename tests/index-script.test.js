const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("inline Mini App JavaScript parses without syntax errors", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length > 0, "index.html should contain an inline application script");
  assert.doesNotThrow(() => new vm.Script(scripts[scripts.length - 1], {
    filename: "index.html inline script"
  }));
});
