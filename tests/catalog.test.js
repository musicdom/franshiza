const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const match = source.match(/const PRODUCTS = (\[[\s\S]*?\n\]);/);
assert.ok(match, "app.js must define the PRODUCTS catalog");
const sandbox = {};
vm.runInNewContext("globalThis.PRODUCTS = " + match[1], sandbox);
const products = sandbox.PRODUCTS;

test("catalog contains at least 20 product concepts", () => {
  assert.ok(products.length >= 20, `Expected at least 20 concepts, got ${products.length}`);
});

test("product IDs are unique and URL-safe", () => {
  const ids = products.map((product) => product.id);
  assert.equal(new Set(ids).size, ids.length, "Product IDs must be unique");
  for (const id of ids) assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("every concept has the fields needed by catalog and detail views", () => {
  for (const product of products) {
    for (const field of ["id", "name", "category", "type", "status", "summary", "problem", "audience", "price", "level"]) {
      assert.equal(typeof product[field], "string", `${product.id}: ${field} must be a string`);
      assert.ok(product[field].trim(), `${product.id}: ${field} must not be empty`);
    }
    assert.ok(Array.isArray(product.features) && product.features.length > 0, `${product.id}: features required`);
    assert.ok(Array.isArray(product.steps) && product.steps.length > 0, `${product.id}: steps required`);
    assert.ok(Array.isArray(product.tags) && product.tags.length > 0, `${product.id}: tags required`);
  }
});

test("industry coverage includes at least 12 categories", () => {
  assert.ok(new Set(products.map((product) => product.category)).size >= 12);
});

test("only truthful concept status is used until implementations are verified", () => {
  for (const product of products) assert.equal(product.status, "concept", `${product.id} must not be advertised as ready`);
});

test("product types and statuses are supported by the interface", () => {
  const allowedTypes = new Set(["Бот", "Мини-приложение", "Каталог", "Автоматизация"]);
  for (const product of products) {
    assert.ok(allowedTypes.has(product.type), `${product.id}: unsupported type ${product.type}`);
    assert.equal(product.status, "concept");
  }
});
