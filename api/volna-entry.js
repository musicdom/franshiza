const { requestMax } = require("../lib/max-api");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function clean(value, max = 200) {
  return typeof value === "string" ? value.replace(/[\\r\\n\\t]+/g, " ").trim().slice(0, max) : "";
}
function escapeText(value) {
  return String(value || "").replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}
const recentByIp = new Map();
function allowed(ip) {
  const now = Date.now();
  const previous = recentByIp.get(ip) || 0;
  if (now - previous < 15000) return false;
  recentByIp.set(ip, now);
  if (recentByIp.size > 500) {
    for (const [key, time] of recentByIp) if (now - time > 60000) recentByIp.delete(key);
  }
  return true;
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (!allowed(ip)) return json(res, 429, { ok: false, error: "Please wait before trying again" });
  const token = process.env.MAX_BOT_TOKEN;
  const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
  if (!token || !adminChatId) {
    console.error("VOLUME ENTRY: MAX_BOT_TOKEN or MAX_ADMIN_CHAT_ID is not configured");
    return json(res, 503, { ok: false, error: "Notification service is not configured" });
  }
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const name = clean(body.name, 120) || "Не передано платформой";
    const username = clean(body.username, 80);
    const userId = clean(body.userId, 80);
    const source = clean(body.source, 120) || "Волна";
    const enteredAt = clean(body.enteredAt, 40) || new Date().toISOString();
    const language = clean(body.language, 30);
    const lines = [
      "🎵 Новый вход в мини-приложение «Волна»",
      "Имя: " + escapeText(name),
      username ? "Username: @" + escapeText(username.replace(/^@/, "")) : "",
      userId ? "ID из клиента (не проверен сервером): " + escapeText(userId) : "ID MAX: недоступен",
      "Источник: " + escapeText(source),
      "Время: " + escapeText(enteredAt),
      language ? "Язык браузера: " + escapeText(language) : "",
      "",
      "Примечание: профильные поля поступили из клиента и не подтверждены подписью MAX."
    ].filter(Boolean);
    const result = await requestMax({
      token,
      method: "POST",
      apiPath: "/messages?chat_id=" + encodeURIComponent(String(adminChatId)),
      body: { text: lines.join("\n") }
    });
    if (!result.ok) {
      console.error("MAX entry notification failed:", result.status, String(result.raw || "").slice(0, 200));
      return json(res, 502, { ok: false, error: "MAX notification failed" });
    }
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error("MAX entry notification error:", error && error.message ? error.message : "unknown error");
    return json(res, 502, { ok: false, error: "Unable to notify MAX" });
  }
};
