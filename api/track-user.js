const { requestMax } = require("../lib/max-api");

function cors(req,res){const o=String(req.headers.origin||"");if(["https://musicdom.github.io","https://franshiza.vercel.app"].includes(o)||/^https:\/\/franshiza-[a-z0-9-]+\.vercel\.app$/.test(o))res.setHeader("Access-Control-Allow-Origin",o);res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");}
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
  cors(req,res);
  if(req.method==="OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const supplied = payload.user && typeof payload.user === "object" ? payload.user : null;
  const user = supplied || {};
  const id = clean(String(user.id || user.user_id || ""), 80);
  const identified = Boolean(id);
  const name = clean([user.first_name, user.last_name].filter(Boolean).join(" ") || user.name || user.username || (identified ? "Пользователь MAX" : "Профиль MAX не передан"), 120);
  const username = clean(user.username, 80);
  const language = clean(String(payload.language_code || user.language_code || ""), 40);
  const photoUrl = clean(String(payload.photo_url || user.photo_url || user.avatar_url || ""), 500);
  const chat = payload.chat && typeof payload.chat === "object" ? payload.chat : {};
  const chatId = clean(String(chat.id || ""), 80);
  const chatType = clean(String(payload.chat_type || chat.type || ""), 40);
  const queryId = clean(String(payload.query_id || ""), 180);
  const startParam = clean(String(payload.start_param || ""), 512);
  const authDate = payload.auth_date ? clean(String(payload.auth_date), 40) : "";
  const platform = clean(String(payload.platform || ""), 80);
  const version = clean(String(payload.version || ""), 80);
  const deviceName = clean(String(payload.device_name || ""), 120);
  const ip = clean(String(payload.ip || ""), 80);
  const webappFields = Array.isArray(payload.webapp_fields) ? payload.webapp_fields.map(v => clean(String(v), 60)).filter(Boolean).slice(0, 40) : [];
  let adminId = "";
  let recipientParam = "";
  const configuredUserId = clean(process.env.MAX_ADMIN_USER_ID || process.env.MAX_OWNER_USER_ID || "163701646", 80);
  const configuredChatId = clean(process.env.MAX_ADMIN_CHAT_ID || "", 80);
  const token = clean(process.env.MAX_BOT_TOKEN || "", 500);
  if (!token) {
    console.error("TRACK USER: MAX_BOT_TOKEN is not configured");
    return json(res, 503, { ok: false, error: "На сервере не настроен MAX_BOT_TOKEN" });
  }
  if (configuredUserId) {
    adminId = configuredUserId;
    recipientParam = "user_id";
  } else if (configuredChatId) {
    adminId = configuredChatId;
    recipientParam = "chat_id";
  }  if (!adminId) {
    try {
      const saved = await redis(["GET", "maxbiz:admin:recipient"]);
      if (saved) {
        const recipient = typeof saved === "string" ? JSON.parse(saved) : saved;
        if (recipient.chat_id) {
          adminId = clean(String(recipient.chat_id), 80);
          recipientParam = "chat_id";
        } else if (recipient.user_id) {
          adminId = clean(String(recipient.user_id), 80);
          recipientParam = "user_id";
        }
      }
    } catch (lookupError) {
      console.error("TRACK USER: saved administrator lookup failed:", lookupError.message);
    }
  }
  if (!adminId) {
    console.error("TRACK USER: administrator is not configured; run /admin_setup with the setup secret");
    return json(res, 503, { ok: false, error: "Администратор не привязан. Выполните /admin_setup с секретом настройки в личном чате бота." });
  }
  try {
    let returning = false;
    try {
      if (identified && getRedisConfig()) {
        const key = "norka:user:tracked:" + id;
        returning = Boolean(await redis(["GET", key]));
        await redis(["SET", key, JSON.stringify({ id, name, username: username || null, last_opened_at: new Date().toISOString() }), "EX", "31536000"]);
      }
    } catch (storageError) {
      console.error("TRACK USER storage warning:", storageError.message);
    }
    const profile = identified ? "[Открыть профиль](max://user/" + encodeURIComponent(id) + ")" : "MAX не передал ID пользователя";
    const text = [
      identified ? (returning ? "🔄 Повторное открытие мини-приложения «Норка»" : "🎵 Пользователь открыл мини-приложение «Гармоника»") : "⚠️ Открытие мини-приложения «Норка»: профиль MAX недоступен",
      "",
      "👤 Имя: " + escapeText(name),
      "🆔 ID: " + escapeText(id || "не получен"),
      "🔗 Профиль: " + profile,
      "📛 " + (username ? "@" + escapeText(username.replace(/^@/, "")) : "username отсутствует"),
      "🌐 Язык: " + escapeText(language || "не передан"),
      "🖼 Фото профиля: " + (photoUrl ? escapeText(photoUrl) : "не передано"),
      "💬 Чат: " + escapeText(chatId || "не передан") + (chatType ? " (" + escapeText(chatType) + ")" : ""),
      "🔎 Query ID: " + escapeText(queryId || "не передан"),
      "🚀 Стартовый параметр: " + escapeText(startParam || "не передан"),
      "🕒 Auth date: " + escapeText(authDate || "не передан"),
      "📱 Платформа: " + escapeText(platform || "не передана"),
      "🧩 Версия MAX: " + escapeText(version || "не передана"),
      "📟 Устройство: " + escapeText(deviceName || "не передано"),
      "🌍 IP из WebApp: " + escapeText(ip || "не передан"),
      "🗂 Поля initData: " + escapeText(webappFields.join(", ") || "не переданы"),
      "🕐 Время события: " + new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
    ].join("\n");
    const sent = await requestMax({
      token,
      method: "POST",
      apiPath: "/messages?" + recipientParam + "=" + encodeURIComponent(adminId),
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
