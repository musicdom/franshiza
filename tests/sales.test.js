const test = require("node:test");
const assert = require("node:assert/strict");
const sales = require("../lib/sales");

test("catalog has unique ids and complete sales information", () => {
  assert.ok(sales.PRODUCTS.length >= 8);
  assert.equal(new Set(sales.PRODUCTS.map(p => p.id)).size, sales.PRODUCTS.length);
  for (const p of sales.PRODUCTS) {
    assert.ok(p.name && p.category && p.price && p.problem && p.demo && p.limitations);
    assert.ok(p.features.length > 0);
  }
});
