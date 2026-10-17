const { requestMax } = require("../lib/max-api");

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
  if (!redis) throw new Error("Lead storage is not configured");
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
  if (!getRedisConfig()) throw new Error("Lead storage is not configured");
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await redisCommand(["SET", `maxbiz:lead:${id}`, JSON.stringify(lead), "EX", "2592000"]);
  await redisCommand(["LPUSH", "maxbiz:leads", id]);
  await redisCommand(["LTRIM", "maxbiz:leads", "0", "499"]);
  return id;
}

async function sendMessage(chatId, text, attachments = []) {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) throw new Error("MAX_BOT_TOKEN is not configured");
  const response = await requestMax({
    token,
    method: "POST",
    apiPath: `/messages?chat_id=${encodeURIComponent(String(chatId))}`,
    body: { text, ...(attachments.length ? { attachments } : {}) }
  });
  if (!response.ok) {
    throw new Error(`MAX send message failed: ${response.status} ${response.raw.slice(0, 200)}`);
  }
}

function cleanText(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const welcomeKeyboard = [{
  type: "inline_keyboard",
  payload: {
    buttons: [
      [{ type: "open_app", text: "🚀 Открыть каталог", web_app: "se14711525_bot" }],
      [
        { type: "message", text: "🏪 Подобрать бота" },
        { type: "message", text: "💰 Узнать цены" }
      ],
      [
        { type: "message", text: "⚙️ Как это работает" },
        { type: "message", text: "👨‍💼 Связаться с менеджером" }
      ]
    ]
  }
}];

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
        ? `Здравствуйте! 👋 Вы выбрали решение «${product}».

Это «Франшиза» — готовые идеи и боты для бизнеса в MAX.

Расскажите, для какого бизнеса нужен бот и что он должен делать. Подберём сценарий и сориентируем по срокам и стоимости.`
        : "Здравствуйте! 👋 Это «Франшиза» — готовые идеи и боты для бизнеса в MAX.\n\nПомогаем автоматизировать:\n• Приём заявок и запись клиентов\n• Продажи и консультации\n• Ответы на частые вопросы\n• Каталог товаров и услуг\n\nВыберите раздел ниже или напишите сферу бизнеса и задачу. Например: «Салон красоты — нужна онлайн-запись». Подберём подходящее решение и расскажем о запуске.";
      await sendMessage(chatId, greeting, welcomeKeyboard);
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

      const command = text.toLowerCase().trim().replace(/^\/+/, "").split(/\s+/)[0];
      if (command === "id" || command === "chatid" || command === "мойid") {
        await sendMessage(chatId, `ID этого чата: ${chatId}`);
        return json(res, 200, { ok: true, command: "id" });
      }
      if (command === "старт" || command === "start" || command === "menu") {
        await sendMessage(chatId, "Здравствуйте! 👋 Это «Франшиза» — готовые идеи и боты для бизнеса в MAX. Помогаем автоматизировать заявки, запись клиентов, продажи, консультации и каталоги товаров. Выберите действие ниже или откройте каталог решений.", welcomeKeyboard);
        return json(res, 200, { ok: true, command: "start" });
      }

      const normalizedText = text.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "").trim();
      if (normalizedText.includes("подобрать бота")) {
        await sendMessage(chatId, "Отлично! 🏪 Напишите, какая у вас сфера бизнеса и что бот должен делать. Например: «Салон красоты — запись клиентов», «Магазин — каталог и заявки», «Кафе — меню и бронирование». Мы передадим запрос менеджеру для подбора сценария.");
        return json(res, 200, { ok: true, action: "choose_bot" });
      }
      if (normalizedText.includes("узнать цены")) {
        await sendMessage(chatId, "💰 Ориентировочные цены: бот для салона красоты — от 7 900 ₽, для кафе — от 9 900 ₽, бот-каталог для магазина — от 12 900 ₽. Итоговая стоимость зависит от функций и интеграций. Нажмите «Открыть каталог», чтобы посмотреть решения подробнее.", welcomeKeyboard);
        return json(res, 200, { ok: true, action: "prices" });
      }
      if (normalizedText.includes("как это работает")) {
        await sendMessage(chatId, "⚙️ Как всё проходит: 1. Рассказываете о бизнесе и задаче. 2. Согласуем функции, сроки и стоимость. 3. Подготавливаем решение и помогаем запустить. Оплата — после согласования состава работ. Чтобы начать, нажмите «Подобрать бота» или напишите свою задачу.");
        return json(res, 200, { ok: true, action: "how_it_works" });
      }
      if (normalizedText.includes("связаться с менеджером")) {
        await sendMessage(chatId, "👨‍💼 Напишите одним сообщением, какой у вас бизнес и что хотите автоматизировать. Ваш запрос сохранится как заявка, и мы сможем обсудить подходящее решение.");
        return json(res, 200, { ok: true, action: "manager" });
      }

      const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
      if (adminChatId) {
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        const product = cleanText(body.text, 1200);
        try {
          await sendMessage(adminChatId, `Новая заявка с сайта MAX Бизнес\nОт: ${senderName}\nЧат: ${chatId}\nСообщение: ${product}`);
        } catch (notificationError) {
          console.error("MAX admin notification failed:", notificationError && notificationError.message ? notificationError.message : "unknown error");
        }
      } else {
        console.warn("MAX_ADMIN_CHAT_ID is not configured; lead saved without admin notification");
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
