const { requestMax } = require("../lib/max-api");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
function clean(value, max = 180) {
  return typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim().slice(0, max) : "";
}
function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function redis(parts) {
  const config = getRedisConfig();
  if (!config) return null;
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
    body: JSON.stringify(parts)
  });
  if (!response.ok) throw new Error("Redis HTTP " + response.status);
  const data = await response.json();
  if (data.error) throw new Error("Redis command failed");
  return data.result;
}
function escapeText(value) {
  return String(value || "").replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }
  const supplied = req.body && req.body.user && typeof req.body.user === "object" ? req.body.user : null;
  const user = supplied || {};
  const id = clean(String(user.id || user.user_id || ""), 80);
  const identified = Boolean(id);
  const name = clean([user.first_name, user.last_name].filter(Boolean).join(" ") || user.name || user.username || (identified ? "Пользователь MAX" : "Профиль MAX не передан"), 120);
  const username = clean(user.username, 80);
  const adminId = clean(process.env.MAX_ADMIN_USER_ID || process.env.MAX_OWNER_USER_ID || "", 80);
  const token = clean(process.env.MAX_BOT_TOKEN || "", 500);
  if (!token) {
    console.error("TRACK USER: MAX_BOT_TOKEN is not configured");
    return json(res, 503, { ok: false, error: "На сервере не настроен MAX_BOT_TOKEN" });
  }
  if (!adminId) {
    console.error("TRACK USER: MAX_ADMIN_USER_ID / MAX_OWNER_USER_ID is not configured");
    return json(res, 503, { ok: false, error: "На сервере не настроен ID администратора MAX" });
  }
  try {
    let returning = false;
    try {
      if (identified && getRedisConfig()) {
        const key = "volna:user:tracked:" + id;
        returning = Boolean(await redis(["GET", key]));
        await redis(["SET", key, JSON.stringify({ id, name, username: username || null, last_opened_at: new Date().toISOString() }), "EX", "31536000"]);
      }
    } catch (storageError) {
      console.error("TRACK USER storage warning:", storageError.message);
    }
    const profile = identified ? "[Открыть профиль](max://user/" + encodeURIComponent(id) + ")" : "MAX не передал ID пользователя";
    const text = [
      identified ? (returning ? "🔄 Повторное открытие мини-приложения «Волна»" : "🎵 Пользователь открыл мини-приложение «Волна»") : "⚠️ Открытие мини-приложения «Волна»: профиль MAX недоступен",
      "",
      "👤 Имя: " + escapeText(name),
      "🆔 ID: " + escapeText(id || "не получен"),
      "🔗 Профиль: " + profile,
      "📛 " + (username ? "@" + escapeText(username.replace(/^@/, "")) : "username отсутствует"),
      "🕐 " + new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
    ].join("\n");
    const sent = await requestMax({
      token,
      method: "POST",
      apiPath: "/messages?user_id=" + encodeURIComponent(adminId),
      body: { text }
    });
    if (!sent.ok) {
      console.error("TRACK USER MAX send failed:", sent.status, String(sent.raw || "").slice(0, 500));
      return json(res, 502, { ok: false, error: "MAX отклонил уведомление. Проверьте ID администратора и доступ бота к личным сообщениям.", status: sent.status });
    }
    return json(res, 200, { ok: true, returning });
  } catch (error) {
    console.error("TRACK USER failed:", error && error.message ? error.message : "unknown error");
    return json(res, 502, { ok: false, error: "Unable to send MAX notification" });
  }
};
