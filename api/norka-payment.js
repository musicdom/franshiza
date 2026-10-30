const { createHmac, timingSafeEqual, randomUUID } = require("crypto");

function json(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Norka-InitData");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.end(JSON.stringify(data));
}
function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function redis(parts) {
  const c = redisConfig();
  if (!c) throw new Error("REDIS_NOT_CONFIGURED");
  const r = await fetch(c.url, { method: "POST", headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" }, body: JSON.stringify(parts) });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || "REDIS_HTTP_" + r.status);
  return d.result;
}
function verify(req) {
  const raw = String(req.headers["x-norka-initdata"] || req.body?.initData || "");
  const token = process.env.MAX_BOT_TOKEN;
  if (!raw || !token || raw.length > 12000) return null;
  try {
    const p = new URLSearchParams(raw), entries = [...p.entries()];
    if (entries.some(([k]) => p.getAll(k).length !== 1)) return null;
    const hash = p.get("hash"), authDate = Number(p.get("auth_date"));
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate)) return null;
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > 86400 || age < -60) return null;
    const check = entries.filter(([k]) => k !== "hash").sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k,v]) => k + "=" + v).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(token).digest();
    const expected = createHmac("sha256", secret).update(check).digest();
    const supplied = Buffer.from(hash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const user = JSON.parse(p.get("user") || "null");
    return user?.id ? String(user.id) : null;
  } catch { return null; }
}
function coinsFor(price) {
  return Math.round(90 + (price - 100) * (1810 / 1900));
}
function paymentUrl(orderId, price) {
  const receiver = String(process.env.YOOMONEY_RECEIVER || "").trim();
  if (!receiver) return "";
  const u = new URL("https://yoomoney.ru/quickpay/confirm.xml");
  u.searchParams.set("receiver", receiver);
  u.searchParams.set("quickpay-form", "button");
  u.searchParams.set("sum", Number(price).toFixed(2));
  u.searchParams.set("label", orderId);
  u.searchParams.set("paymentType", "AC");
  u.searchParams.set("successURL", "https://musicdom.github.io/franshiza/");
  return u.toString();
}
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    const userId = verify(req);
    if (!userId) return json(res, 401, { ok: false, error: "MAX_AUTH_REQUIRED" });
    if (req.method === "POST") {
      const price = Number(req.body?.price);
      if (!Number.isInteger(price) || price < 100 || price > 2000 || price % 100 !== 0) return json(res, 400, { ok: false, error: "Выбери сумму от 100 до 2000 ₽ с шагом 100 ₽" });
      const receiver = String(process.env.YOOMONEY_RECEIVER || "").trim();
      if (!receiver) return json(res, 503, { ok: false, error: "Платёжный приёмник YooMoney не настроен" });
      const id = "nk_" + randomUUID().replace(/-/g, "");
      const coins = coinsFor(price);
      const order = { id, userId, price, coins, currency: "RUB", status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
      const saved = await redis(["SET", "norka:payment:order:" + id, JSON.stringify(order), "NX", "EX", "86400"]);
      if (saved !== "OK") throw new Error("ORDER_CREATE_FAILED");
      const url = paymentUrl(id, price);
      return json(res, 201, { ok: true, order: { id, price, coins, status: "pending", paymentUrl: url } });
    }
    if (req.method === "GET") {
      const id = String(req.query?.id || "");
      if (!/^nk_[a-f0-9]{32}$/.test(id)) return json(res, 404, { ok: false, error: "ORDER_NOT_FOUND" });
      const raw = await redis(["GET", "norka:payment:order:" + id]);
      if (!raw) return json(res, 404, { ok: false, error: "ORDER_NOT_FOUND" });
      const order = JSON.parse(raw);
      if (String(order.userId) !== userId) return json(res, 404, { ok: false, error: "ORDER_NOT_FOUND" });
      return json(res, 200, { ok: true, order: { id: order.id, price: order.price, coins: order.coins, status: order.status } });
    }
    return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  } catch (e) {
    console.error("NORKA PAYMENT:", String(e?.message || e));
    return json(res, 500, { ok: false, error: "Не удалось создать платёж. Попробуй ещё раз." });
  }
};
