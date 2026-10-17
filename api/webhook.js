const API = "https://platform-api2.max.ru";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redisCommand(parts) {
  const redis = getRedisConfig();
  if (!redis) return false;
  const response = await fetch(redis.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redis.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(parts)
  });
  if (!response.ok) throw new Error("Redis request failed");
  const result = await response.json();
  if (result.error) throw new Error("Redis command failed");
  return true;
}

async function saveLead(lead) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await redisCommand(["SET", `maxbiz:lead:${id}`, JSON.stringify(lead), "EX", "2592000"]);
  await redisCommand(["LPUSH", "maxbiz:leads", id]);
  await redisCommand(["LTRIM", "maxbiz:leads", "0", "499"]);
}

async function sendMessage(chatId, text) {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) throw new Error("MAX_BOT_TOKEN is not configured");
  const response = await fetch(`${API}/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`MAX send message failed: ${response.status} ${detail.slice(0, 200)}`);
  }
}

function cleanText(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const expectedSecret = process.env.MAX_WEBHOOK_SECRET;
  if (!expectedSecret) return json(res, 503, { ok: false, error: "Webhook secret is not configured" });
  if (req.headers["x-max-bot-api-secret"] !== expectedSecret) {
    return json(res, 401, { ok: false, error: "Unauthorized" });
  }

  const update = req.body && typeof req.body === "object" ? req.body : {};
  const type = update.update_type;
  const chatId = update.chat_id || (update.message && update.message.recipient && update.message.recipient.chat_id);

  try {
    if (type === "bot_started") {
      if (!chatId) return json(res, 200, { ok: true, ignored: "missing chat id" });
      const payload = cleanText(update.payload, 128);
      const product = payload.startsWith("product:") ? cleanText(payload.slice(8), 100) : "";
      await saveLead({
        type: "bot_started",
        chat_id: String(chatId),
        user_id: update.user && update.user.user_id ? String(update.user.user_id) : null,
        user_name: cleanText(update.user && update.user.name, 120),
        username: cleanText(update.user && update.user.username, 120),
        product: product || null,
        payload: payload || null,
        created_at: new Date().toISOString()
      });
      const greeting = product
        ? `Здравствуйте! Вы выбрали: «${product}». Расскажите, пожалуйста, о вашей компании и что именно хотите автоматизировать. Мы обсудим сценарий, сроки и стоимость.`
        : "Здравствуйте! Это MAX Бизнес. Помогаем подобрать ботов и автоматизацию для бизнеса. Напишите, какая у вас сфера и какую задачу хотите решить.";
      await sendMessage(chatId, greeting);
      return json(res, 200, { ok: true });
    }

    if (type === "message_created") {
      const message = update.message || {};
      const sender = message.sender || {};
      const body = message.body || {};
      const text = cleanText(body.text);
      if (sender.is_bot || !chatId || !text) return json(res, 200, { ok: true, ignored: true });

      await saveLead({
        type: "message_created",
        chat_id: String(chatId),
        user_id: sender.user_id ? String(sender.user_id) : null,
        user_name: cleanText(sender.name, 120),
        username: cleanText(sender.username, 120),
        text,
        created_at: new Date().toISOString()
      });

      const command = text.toLowerCase().trim().replace(/^\\/+/, "").split(/\\s+/)[0];
      if (command === "старт" || command === "start") {
        await sendMessage(chatId, "Привет! 👋 Это MAX Бизнес.\n\nПомогаем подобрать готового бота для бизнеса и автоматизировать работу.\n\nНапиши, для какой сферы нужен бот и что он должен делать — подберём подходящее решение.");
        return json(res, 200, { ok: true, command: "start" });
      }

      const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
      if (adminChatId) {
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        const product = cleanText(body.text, 1200);
        await sendMessage(adminChatId, `Новая заявка с сайта MAX Бизнес\nОт: ${senderName}\nЧат: ${chatId}\nСообщение: ${product}`);
      }

      await sendMessage(chatId, "Спасибо, сообщение получил. Заявка сохранена. Мы уточним детали и обсудим подходящее решение.");
      return json(res, 200, { ok: true });
    }

    return json(res, 200, { ok: true, ignored: type || "unknown update type" });
  } catch (error) {
    console.error("MAX webhook processing failed:", error && error.message ? error.message : "unknown error");
    return json(res, 200, { ok: true, processing_error: true });
  }
};
