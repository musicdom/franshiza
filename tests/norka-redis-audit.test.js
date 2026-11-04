"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ALLOWED_COMMANDS, redisConfig, exactIds, parseHash, auditRedis } = require("../scripts/norka-redis-audit");

test("only read-only commands are allowed", () => {
  assert.deepEqual([...ALLOWED_COMMANDS].sort(), ["GET", "HGETALL", "SCAN"]);
});

test("Redis credentials must be paired by provider", () => {
  assert.throws(() => redisConfig({ KV_REST_API_URL: "https://redis.invalid" }), /incomplete/);
  assert.deepEqual(redisConfig({ KV_REST_API_URL: "https://redis.invalid/", KV_REST_API_TOKEN: "token" }), { url: "https://redis.invalid", token: "token" });
});

test("user key scan excludes nested tracked keys", () => {
  assert.deepEqual(exactIds(["norka:user:1", "norka:user:tracked:1", "norka:user:2:extra"], "norka:user:*"), ["1"]);
});

test("HGETALL array response is normalized", () => {
  assert.deepEqual(parseHash(["berries", "4", "coins", "2"]), { berries: "4", coins: "2" });
});

test("audit reports aggregates only", async () => {
  const values = {
    "norka:user:1": JSON.stringify({ berries: 10, coins: 3 }),
    "norka:user:2": "{bad",
    "norka:wallet:1": ["berries", "8", "coins", "3"],
    "norka:wallet:3": ["berries", "1", "coins", "0"]
  };
  const redis = async args => {
    if (args[0] === "SCAN") return ["0", Object.keys(values).filter(k => k.startsWith(args[3].replace("*", "")))];
    if (args[0] === "GET") return values[args[1]] ?? null;
    if (args[0] === "HGETALL") return values[args[1]] ?? [];
    throw new Error("Unexpected command");
  };
  const result = await auditRedis(redis);
  assert.equal(result.profileCount, 2);
  assert.equal(result.walletCount, 2);
  assert.equal(result.berriesMismatches, 1);
  assert.equal(result.malformedProfileJson, 1);
  assert.equal(result.profilesWithoutWallet, 1);
  assert.equal(result.walletsWithoutProfile, 1);
  assert.equal(JSON.stringify(result).includes("norka:user:1"), false);
});
