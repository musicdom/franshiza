const crypto = require("crypto");

function json(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(parts) {
  const config = redisConfig();
  if (!config) throw new Error("REDIS_NOT_CONFIGURED");
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
    body: JSON.stringify(parts)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "REDIS_HTTP_" + response.status);
  return data.result;
}

function validSignature(fields) {
  const secret = String(process.env.YOOMONEY_NOTIFICATION_SECRET || "").trim();
  const received = String(fields.sign || "").toLowerCase();
  if (!secret || !/^[a-f0-9]{64}$/.test(received)) return false;
  const payload = Object.entries(fields)
    .filter(([key]) => key !== "sign")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
    .join("&");
  const calculated = crypto.createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(received, "hex");
  return supplied.length === calculated.length && crypto.timingSafeEqual(supplied, calculated);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const fields = req.body && typeof req.body.fields === "object" && req.body.fields ? req.body.fields : null;
    if (!fields || !validSignature(fields)) return json(res, 401, { ok: false, error: "INVALID_NOTIFICATION_SIGNATURE" });

    const orderId = String(fields.label || "");
    const operationId = String(fields.operation_id || "");
    const notificationType = String(fields.notification_type || "");
    const currency = String(fields.currency || "");
    const unaccepted = String(fields.unaccepted || "").toLowerCase();
    const codepro = String(fields.codepro || "").toLowerCase();
    const amount = Number(fields.amount);
    const withdrawAmount = Number(fields.withdraw_amount);

    if (!/^nk_[a-f0-9]{32}$/.test(orderId) || !operationId) return json(res, 400, { ok: false, error: "INVALID_PAYMENT_REFERENCE" });
    if (!["p2p-incoming", "card-incoming"].includes(notificationType)) return json(res, 400, { ok: false, error: "UNSUPPORTED_NOTIFICATION" });
    if (currency !== "643" || unaccepted === "true" || codepro === "true" || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(withdrawAmount) || withdrawAmount < 0) {
      return json(res, 400, { ok: false, error: "INVALID_PAYMENT" });
    }

    const orderRaw = await redis(["GET", "norka:payment:order:" + orderId]);
    if (!orderRaw) return json(res, 404, { ok: false, error: "ORDER_NOT_FOUND" });
    let orderSnapshot;
    try { orderSnapshot = JSON.parse(orderRaw); } catch { return json(res, 500, { ok: false, error: "ORDER_INVALID" }); }
    const userId = String(orderSnapshot.userId || "");
    if (!userId) return json(res, 400, { ok: false, error: "ORDER_INVALID" });

    const now = new Date().toISOString();
    const script = [
      "local raw=redis.call('GET',KEYS[1]);",
      "if not raw then return redis.error_reply('ORDER_NOT_FOUND') end;",
      "local order=cjson.decode(raw);",
      "if order.status=='paid' then return {2,tonumber(order.coins) or 0} end;",
      "if tostring(order.currency)~='RUB' or tonumber(order.price)==nil or tonumber(order.price)<=0 then return redis.error_reply('ORDER_INVALID') end;",
      "if tonumber(ARGV[1])+0.000001<tonumber(order.price) then return redis.error_reply('PAYMENT_AMOUNT_TOO_LOW') end;",
      "local coins=tonumber(order.coins);",
      "if coins==nil or coins<1 or coins~=math.floor(coins) or not order.userId then return redis.error_reply('ORDER_INVALID') end;",
      "local existing=redis.call('GET',KEYS[3]);",
      "if existing then if existing==ARGV[2] then return {2,coins} else return redis.error_reply('DUPLICATE_OPERATION') end end;",
      "redis.call('HINCRBY',KEYS[2],'coins',coins);",
      "redis.call('SET',KEYS[3],ARGV[2]);",
      "order.status='paid'; order.operationId=ARGV[2]; order.paidAmount=tonumber(ARGV[3]); order.withdrawAmount=tonumber(ARGV[1]); order.paidAt=ARGV[4];",
      "redis.call('SET',KEYS[1],cjson.encode(order));",
      "redis.call('LPUSH',KEYS[4],cjson.encode({type='coin_purchase',title='Покупка монет',coins=coins,at=ARGV[4],orderId=order.id}));",
      "redis.call('LTRIM',KEYS[4],'0','99');",
      "return {1,coins};"
    ].join(" ");

    const result = await redis([
      "EVAL", script, "4",
      "norka:payment:order:" + orderId,
      "norka:wallet:" + userId,
      "norka:payment:operation:" + operationId,
      "norka:ledger:" + userId,
      String(withdrawAmount), operationId, String(amount), now
    ]);

    return json(res, 200, { ok: true, status: "paid", coinsAdded: Array.isArray(result) ? Number(result[1]) || 0 : 0 });
  } catch (error) {
    const message = String(error && error.message || "PAYMENT_HANDLER_ERROR");
    if (message.includes("ORDER_NOT_FOUND")) return json(res, 404, { ok: false, error: "ORDER_NOT_FOUND" });
    if (message.includes("PAYMENT_AMOUNT_TOO_LOW")) return json(res, 400, { ok: false, error: "PAYMENT_AMOUNT_TOO_LOW" });
    if (message.includes("DUPLICATE_OPERATION")) return json(res, 409, { ok: false, error: "DUPLICATE_OPERATION" });
    if (message.includes("ORDER_INVALID")) return json(res, 400, { ok: false, error: "ORDER_INVALID" });
    console.error("NORKA YOOMONEY:", message);
    return json(res, 500, { ok: false, error: "PAYMENT_PROCESSING_FAILED" });
  }
};
