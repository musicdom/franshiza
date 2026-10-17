const { randomUUID } = require("node:crypto");

const INDEX_KEY = "franshiza:requests:index";
const PREFIX = "franshiza:requests:item:";
const RETENTION_SECONDS = 60 * 60 * 24 * 180;

async function redis(config, command) {
  const response = await fetch(config.redisUrl + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.redisToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([command]),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Storage request failed");
  const data = await response.json();
  if (!Array.isArray(data) || !data[0] || data[0].error) throw new Error("Storage command failed");
  return data[0].result;
}

async function redisPipeline(config, commands) {
  const response = await fetch(config.redisUrl + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.redisToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Storage request failed");
  const data = await response.json();
  if (!Array.isArray(data) || data.some((item) => item && item.error)) throw new Error("Storage command failed");
  return data.map((item) => item.result);
}

async function rateLimit(config, key, limit, windowSeconds) {
  const count = Number(await redis(config, ["INCR", "franshiza:rate:" + key]));
  if (count === 1) await redis(config, ["EXPIRE", "franshiza:rate:" + key, String(windowSeconds)]);
  return Number.isFinite(count) && count <= limit;
}

async function saveRequest(config, input) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const item = {
    id,
    createdAt: now,
    status: "new",
    name: input.name,
    contact: input.contact,
    business: input.business,
    comment: input.comment,
    productId: input.productId,
    consentAt: now,
    notificationStatus: "pending"
  };
  await redisPipeline(config, [
    ["SET", PREFIX + id, JSON.stringify(item), "EX", String(RETENTION_SECONDS)],
    ["ZADD", INDEX_KEY, String(Date.now()), id],
    ["ZREMRANGEBYSCORE", INDEX_KEY, "-inf", String(Date.now() - RETENTION_SECONDS * 1000)]
  ]);
  return item;
}

async function getRequest(config, id) {
  const raw = await redis(config, ["GET", PREFIX + id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function listRequests(config, limit = 100, offset = 0) {
  const ids = await redis(config, ["ZREVRANGE", INDEX_KEY, String(offset), String(offset + limit - 1)]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const values = await redisPipeline(config, ids.map((id) => ["GET", PREFIX + id]));
  return values.filter(Boolean).map((raw) => {
    try { return JSON.parse(raw); } catch { return null; }
  }).filter(Boolean);
}

async function updateRequest(config, id, patch) {
  const current = await getRequest(config, id);
  if (!current) return null;
  const updated = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
  await redis(config, ["SET", PREFIX + id, JSON.stringify(updated), "EX", String(RETENTION_SECONDS)]);
  return updated;
}

module.exports = { rateLimit, saveRequest, getRequest, listRequests, updateRequest };
