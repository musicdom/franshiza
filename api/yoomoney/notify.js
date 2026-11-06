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
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + encodeURIComponent(String(value)).replace(/[!'()*]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase()))
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
    const body = typeof req.body === "string" ? Object.fromEntries(new URLSearchParams(req.body)) : req.body && typeof req.body === "object" ? req.body : {};
    const fields = body.fields && typeof body.fields === "object" ? body.fields : body;
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
    const referrerId = String(await redis(["GET", "norka:referral:inviter:" + userId]) || "");
    const referralBonusCoins = Math.floor((Number(orderSnapshot.coins) || 0) * 0.02);
    const referralRewardAt = new Date().toISOString();
    const referralLedgerItem = JSON.stringify({
      type: "referral_first_topup",
      title: "Бонус за первое пополнение приглашённого друга",
      berries: 100,
      coins: referralBonusCoins,
      at: referralRewardAt
    });
    const referralRewardRecord = JSON.stringify({referrerId,berries:100,coins:referralBonusCoins,purchaseCoins:Number(orderSnapshot.coins)||0,at:referralRewardAt});

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
      "if existing then if existing==tostring(order.id) then return {2,coins,0,0} else return redis.error_reply('DUPLICATE_OPERATION') end end;",
      "redis.call('HINCRBY',KEYS[2],'coins',coins);",
      "redis.call('SET',KEYS[3],ARGV[2]);",
      "order.status='paid'; order.operationId=ARGV[2]; order.paidAmount=tonumber(ARGV[3]); order.withdrawAmount=tonumber(ARGV[1]); order.paidAt=ARGV[4];",
      "redis.call('SET',KEYS[1],cjson.encode(order));",
      "redis.call('LPUSH',KEYS[4],cjson.encode({type='coin_purchase',title='Покупка монет',coins=coins,at=ARGV[4],orderId=order.id}));",
      "redis.call('LTRIM',KEYS[4],'0','99');",
      "local rewarded=0; local bonusCoins=0;",
      "if ARGV[5]~='' and ARGV[5]~=tostring(order.userId) and redis.call('SET',KEYS[5],'1','NX')=='OK' then",
      "  local bonusBerries=100; bonusCoins=tonumber(ARGV[7]) or 0;",
      "  redis.call('HINCRBY',KEYS[6],'berries',bonusBerries); if bonusCoins>0 then redis.call('HINCRBY',KEYS[6],'coins',bonusCoins) end;",
      "  redis.call('INCRBY',KEYS[7],bonusBerries); redis.call('ZINCRBY',KEYS[8],bonusBerries,ARGV[5]);",
      "  redis.call('HINCRBY',KEYS[9],'berries',bonusBerries); if bonusCoins>0 then redis.call('HINCRBY',KEYS[9],'coins',bonusCoins) end;",
      "  redis.call('LPUSH',KEYS[10],ARGV[6]); redis.call('LTRIM',KEYS[10],'0','99'); redis.call('SET',KEYS[11],ARGV[8]); rewarded=1;",
      "end;",
      "return {1,coins,rewarded,bonusCoins};"
    ].join(" ");

    const result = await redis([
      "EVAL", script, "11",
      "norka:payment:order:" + orderId,
      "norka:wallet:" + userId,
      "norka:payment:operation:" + operationId,
      "norka:ledger:" + userId,
      "norka:referral:first_topup:" + userId,
      "norka:wallet:" + (referrerId || "__no_referrer__"),
      "norka:berries:earned:" + (referrerId || "__no_referrer__"),
      "norka:berries:ranking",
      "norka:referral:stats:" + (referrerId || "__no_referrer__"),
      "norka:ledger:" + (referrerId || "__no_referrer__"),
      "norka:referral:reward:" + userId,
      String(withdrawAmount), operationId, String(amount), now,
      referrerId, referralLedgerItem, String(referralBonusCoins), referralRewardRecord
    ]);

    return json(res, 200, { ok: true, status: "paid", coinsAdded: Array.isArray(result) ? Number(result[1]) || 0 : 0, referralRewardApplied: Array.isArray(result) && Number(result[2]) === 1, referralBonusCoins: Array.isArray(result) ? Number(result[3]) || 0 : 0 });
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
