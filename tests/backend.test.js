const test = require("node:test");
const assert = require("node:assert/strict");
const { safeEqual, signSession, verifySession, requireSameOrigin } = require("../lib/server/http");

test("admin session signature validates only before expiry", () => {
  const secret = "test-secret-that-is-long-enough-for-tests";
  const valid = signSession(Date.now() + 60_000, secret);
  assert.equal(verifySession(valid, secret), true);
  assert.equal(verifySession(valid, "different-test-secret"), false);
  assert.equal(verifySession(signSession(Date.now() - 1000, secret), secret), false);
});

test("malformed and modified session tokens are rejected", () => {
  const secret = "test-secret-that-is-long-enough-for-tests";
  assert.equal(verifySession("", secret), false);
  assert.equal(verifySession("not-a-token", secret), false);
  const valid = signSession(Date.now() + 60_000, secret);
  assert.equal(verifySession(valid + "x", secret), false);
});

test("constant-time comparison helper handles equal and different strings", () => {
  assert.equal(safeEqual("same-value", "same-value"), true);
  assert.equal(safeEqual("same-value", "different"), false);
  assert.equal(safeEqual("", ""), true);
});

test("state-changing requests require a matching Origin host", () => {
  assert.equal(requireSameOrigin({ headers: { origin: "https://example.com", host: "example.com" } }), true);
  assert.equal(requireSameOrigin({ headers: { origin: "https://attacker.example", host: "example.com" } }), false);
  assert.equal(requireSameOrigin({ headers: { host: "example.com" } }), false);
});
