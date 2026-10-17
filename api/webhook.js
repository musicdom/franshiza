const { requestMax } = require("../lib/max-api");
const sales = require("../lib/sales");
const salesFlow = require("../lib/sales-flow");

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
  payload: { buttons: [
    [{ type: "callback", text: "🛍 Каталог решений", payload: String("🛍 Каталог решений") }, { type: "callback", text: "🎯 Подобрать бота", payload: String("🎯 Подобрать бота") }],
    [{ type: "callback", text: "👀 Демонстрации", payload: String("👀 Демонстрации") }, { type: "callback", text: "💬 Задать вопрос", payload: String("💬 Задать вопрос") }],
    [{ type: "callback", text: "📦 Мои заявки", payload: String("📦 Мои заявки") }, { type: "callback", text: "🔔 Уведомления", payload: String("🔔 Уведомления") }],
    [{ type: "open_app", text: "🌐 Открыть сайт-каталог", web_app: "se14711525_bot" }]
  ] }
}];

const businessKeyboard = [{
  type: "inline_keyboard",
  payload: {
    buttons: [
      [{ type: "callback", text: "💇 Салон красоты", payload: String("💇 Салон красоты") }, { type: "callback", text: "🍽️ Кафе / ресторан", payload: String("🍽️ Кафе / ресторан") }],
      [{ type: "callback", text: "🛍️ Магазин", payload: String("🛍️ Магазин") }, { type: "callback", text: "🏢 Другое", payload: String("🏢 Другое") }],
      [{ type: "callback", text: "🏠 Меню", payload: String("🏠 Меню") }]
    ]
  }
}];

async function safeSaveLead(lead) {
  try {
    await saveLead(lead);
    return true;
  } catch (error) {
    console.error("MAX lead storage failed:", error && error.message ? error.message : "unknown error");
    return false;
  }
}

async function getChatSession(chatId) {
  try {
    const redis = getRedisConfig();
    if (!redis) return null;
    const response = await fetch(redis.url, { method: "POST", headers: { Authorization: `Bearer ${redis.token}`, "Content-Type": "application/json" }, body: JSON.stringify(["GET", `maxbiz:session:${chatId}`]) });
    if (!response.ok) return null;
    const result = await response.json();
    return result.result ? JSON.parse(result.result) : null;
  } catch (error) {
    console.error("MAX session read failed:", error && error.message ? error.message : "unknown error");
    return null;
  }
}
async function setChatSession(chatId, session) {
  try { await redisCommand(["SET", `maxbiz:session:${chatId}`, JSON.stringify(session), "EX", "86400"]); }
  catch (error) { console.error("MAX session write failed:", error && error.message ? error.message : "unknown error"); }
}
async function clearChatSession(chatId) {
  try { await redisCommand(["DEL", `maxbiz:session:${chatId}`]); }
  catch (error) { console.error("MAX session clear failed:", error && error.message ? error.message : "unknown error"); }
}
const goalKeyboard = [{ type: "inline_keyboard", payload: { buttons: [
  [{ type: "callback", text: "📅 Запись клиентов", payload: String("📅 Запись клиентов") }, { type: "callback", text: "📩 Приём заявок", payload: String("📩 Приём заявок") }],
  [{ type: "callback", text: "🛍️ Каталог / заказы", payload: String("🛍️ Каталог / заказы") }, { type: "callback", text: "💬 Ответы на вопросы", payload: String("💬 Ответы на вопросы") }],
  [{ type: "callback", text: "⚙️ Несколько функций", payload: String("⚙️ Несколько функций") }],
  [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
] } }];
const detailKeyboard = [{ type: "inline_keyboard", payload: { buttons: [
  [{ type: "callback", text: "🤝 Помогите определиться", payload: String("🤝 Помогите определиться") }],
  [{ type: "callback", text: "💰 Цена и сроки", payload: String("💰 Цена и сроки") }, { type: "callback", text: "👨‍💼 Менеджер", payload: String("👨‍💼 Менеджер") }],
  [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
] } }];

function getProductScenario(product) {
  const scenarios = [
    { match: ["салон красоты"], title: "Бот для салона красоты", summary: "Клиент выбирает услугу, указывает удобное время и оставляет заявку администратору.", features: "• Выбор услуги\n• Желаемые дата и время\n• Передача заявки администратору", buttons: ["📅 Настроить запись", "💇 Список услуг", "💰 Цена и сроки"] },
    { match: ["кафе", "ресторан"], title: "Бот для кафе и ресторана", summary: "Клиент знакомится с меню и отправляет запрос на заказ или бронирование столика.", features: "• Меню и информация о заведении\n• Запрос на заказ или столик\n• Передача обращения сотруднику", buttons: ["🍽️ Меню и заказы", "🪑 Бронирование столика", "💰 Цена и сроки"] },
    { match: ["каталог для магазина", "магазин"], title: "Бот-каталог для магазина", summary: "Клиент выбирает товар, задаёт вопрос и отправляет заявку продавцу.", features: "• Категории и карточки товаров\n• Цена и описание при наличии данных\n• Заявка по выбранному товару", buttons: ["🛍️ Каталог товаров", "📩 Заявки на покупку", "💰 Цена и сроки"] },
    { match: ["автосервис"], title: "Бот для автосервиса", summary: "Клиент указывает автомобиль, описывает проблему и оставляет запрос на визит.", features: "• Марка и модель авто\n• Описание проблемы или услуги\n• Предпочтительное время визита", buttons: ["🔧 Запись в сервис", "🚘 Заявка по авто", "💰 Цена и сроки"] },
    { match: ["недвижимости"], title: "Бот для недвижимости", summary: "Клиент уточняет тип объекта, бюджет и требования, а агент получает заявку для подбора.", features: "• Тип объекта и цель поиска\n• Бюджет и предпочтения\n• Передача заявки агенту", buttons: ["🏠 Подбор недвижимости", "📩 Заявка клиента", "💰 Цена и сроки"] },
    { match: ["клиники"], title: "Бот для клиники", summary: "Клиент получает общую информацию и оставляет запрос на запись или обратную связь.", features: "• Направления и общая информация\n• Запрос на запись или звонок\n• Передача вопроса администратору", buttons: ["🩺 Запись в клинику", "ℹ️ Услуги и вопросы", "💰 Цена и сроки"] },
    { match: ["онлайн-школы"], title: "Бот для онлайн-школы", summary: "Показывает информацию об обучении, отвечает на частые вопросы и собирает заявки учеников.", features: "• Презентация программы\n• Ответы на частые вопросы\n• Заявка на обучение", buttons: ["🎓 Заявка на обучение", "📚 Программа курса", "💰 Цена и сроки"] },
    { match: ["эксперта", "консультанта"], title: "Бот для эксперта и консультанта", summary: "Клиент знакомится с услугами, описывает запрос и оставляет заявку на консультацию.", features: "• Описание услуг\n• Уточнение задачи клиента\n• Заявка на консультацию", buttons: ["💬 Заявка на консультацию", "📋 Описание услуг", "💰 Цена и сроки"] },
    { match: ["ассистент"], title: "Бизнес-ассистент в MAX", summary: "Отвечает на согласованные частые вопросы, собирает первичную информацию и передаёт сложные вопросы человеку.", features: "• Ответы на типовые вопросы\n• Сбор сведений по сценарию\n• Передача вопроса менеджеру", buttons: ["💬 Настроить ответы", "📩 Сбор заявок", "💰 Цена и сроки"] }
  ];
  return scenarios.find((item) => item.match.some((part) => String(product || "").toLowerCase().includes(part))) || {
    title: product || "Бизнес-бот",
    summary: "Уточним, какие действия должен выполнять этот бот именно для вашего бизнеса.",
    features: "• Согласуем функции и сценарий\n• Определим, какие данные собирать\n• Настроим передачу заявок",
    buttons: ["⚙️ Уточнить функции", "📩 Приём заявок", "💰 Цена и сроки"]
  };
}

function productKeyboard(scenario) {
  return [{
    type: "inline_keyboard",
    payload: {
      buttons: [
        [{ type: "callback", text: scenario.buttons[0], payload: String(scenario.buttons[0]) }],
        [{ type: "callback", text: scenario.buttons[1], payload: String(scenario.buttons[1]) }],
        [{ type: "callback", text: scenario.buttons[2], payload: String(scenario.buttons[2]) }, { type: "callback", text: "👨‍💼 Менеджер", payload: String("👨‍💼 Менеджер") }]
      ]
    }
  }];
}

const productNextKeyboard = [{
  type: "inline_keyboard",
  payload: {
    buttons: [
      [{ type: "callback", text: "📩 Оставить заявку", payload: String("📩 Оставить заявку") }, { type: "callback", text: "💰 Цена и сроки", payload: String("💰 Цена и сроки") }],
      [{ type: "callback", text: "👨‍💼 Менеджер", payload: String("👨‍💼 Менеджер") }]
    ]
  }
}];

async function sendSalesProductCard(chatId, p) {
  await sendMessage(chatId, "🧩 " + p.name + "\n\nДля кого: " + p.audience + "\n\nКакую задачу решает: " + p.problem + "\n\nОсновные функции:\n• " + p.features.join("\n• ") + "\n\nПример работы: " + p.demo + "\n\nЧто потребуется: " + p.requirements + "\n\nОграничения: " + p.limitations + "\n\nОриентировочная цена: " + p.price + "\nОплата и автоматическая выдача пока не подключены: до начала работ подтверждаем состав и итоговую стоимость.", [{ type: "inline_keyboard", payload: { buttons: [
    [{ type: "callback", text: "▶️ Посмотреть демо", payload: String("▶️ Посмотреть демо") }, { type: "callback", text: "💳 Узнать стоимость", payload: String("💳 Узнать стоимость") }],
    [{ type: "callback", text: "⭐ Сохранить решение", payload: String("⭐ Сохранить решение") }, { type: "callback", text: "🛒 Оформить заявку", payload: String("🛒 Оформить заявку") }],
    [{ type: "callback", text: "💬 Консультация", payload: String("💬 Консультация") }, { type: "callback", text: "⚖️ Сравнить варианты", payload: String("⚖️ Сравнить варианты") }],
    [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
  ] } }]);
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
      await safeSaveLead({
        type: "bot_started",
        chat_id: String(chatId),
        user_id: update.user && update.user.user_id ? String(update.user.user_id) : null,
        user_name: cleanText(update.user && update.user.name, 120),
        username: cleanText(update.user && update.user.username, 120),
        product: product || null,
        payload: payload || null,
        created_at: new Date().toISOString()
      });
      await sales.recordEvent({ event: "bot_started", chat_id: String(chatId), product_id: product || null });
      const productMatch = sales.PRODUCTS.find((item) => product && (product.toLowerCase().includes(item.name.toLowerCase()) || product.toLowerCase() === item.id));
      if (productMatch) {
        await sales.saveSession(chatId, { stage: "sales_product", product_id: productMatch.id, last_product_id: productMatch.id, business: productMatch.category, consent_marketing: false, last_activity: new Date().toISOString() });
        await sales.recordEvent({ event: "product_viewed", chat_id: String(chatId), product_id: productMatch.id });
        await sendSalesProductCard(chatId, productMatch);
        return json(res, 200, { ok: true, product: productMatch.id });
      }
      await sales.recordEvent({ event: "bot_started", chat_id: String(chatId), product_id: product || null });
      const greeting = "Привет! 👋 Помогу подобрать готового бота для бизнеса в MAX.\n\nМожно посмотреть каталог, пройти короткий подбор или посмотреть пример работы. Цены в каталоге ориентировочные; оплату и запуск согласуем отдельно.";
      await sendMessage(chatId, greeting, welcomeKeyboard);
      return json(res, 200, { ok: true });
    }

    if (type === "message_created" || type === "message_callback") {
      const isCallback = type === "message_callback";
      const message = update.message || {};
      const sender = isCallback ? (update.callback && update.callback.user) || {} : message.sender || {};
      const body = isCallback ? { text: update.callback && update.callback.payload } : message.body || {};
      const text = cleanText(body.text);
      if ((!isCallback && sender.is_bot) || !chatId || !text) return json(res, 200, { ok: true, ignored: true });
      const messageId = isCallback ? null : (body.mid || message.mid || message.message_id || update.message_id);
      if (messageId) {
        try {
          const accepted = await sales.redis(["SET", "maxbiz:processed:" + String(messageId), "1", "NX", "EX", "86400"]);
          if (accepted !== "OK") return json(res, 200, { ok: true, duplicate: true });
        } catch (dedupeError) { console.error("Message deduplication unavailable"); }
      }

      try { await sales.recordEvent({ event: "message_received", chat_id: String(chatId), user_id: sender.user_id ? String(sender.user_id) : null }); } catch (eventError) { console.error("Event recording failed"); }

      const command = text.toLowerCase().trim().replace(/^\/+/, "").split(/\s+/)[0];
      if (command === "id" || command === "chatid" || command === "мойid") {
        await sendMessage(chatId, `ID этого чата: ${chatId}`);
        return json(res, 200, { ok: true, command: "id" });
      }
      if (command === "старт" || command === "start" || command === "menu") {
        await sendMessage(chatId, "Главное меню 👇 Выберите, что нужно сделать, или напишите вопрос обычным сообщением.", welcomeKeyboard);
        return json(res, 200, { ok: true, command: "start" });
      }

      const normalizedText = text.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const salesResult = await salesFlow.handleSalesMessage({ chatId, sender, text, normalizedText, sendMessage, welcomeKeyboard });
      if (salesResult && salesResult.handled) return json(res, 200, { ok: true, ...salesResult });

      if (normalizedText.includes("главное меню") || normalizedText === "меню" || normalizedText === "🏠 меню") {
        await clearChatSession(chatId);
        await sendMessage(chatId, "Главное меню 👇 Выберите действие или напишите задачу своими словами.", welcomeKeyboard);
        return json(res, 200, { ok: true, action: "menu" });
      }

      const session = await getChatSession(chatId);
      if (session && session.stage === "goal" && !normalizedText.includes("цена и сроки") && !normalizedText.includes("менеджер") && !["салон красоты", "кафе / ресторан", "магазин", "другое"].some((v) => normalizedText.includes(v))) {
        const goalOptions = [["запись клиентов", "Запись клиентов"], ["приём заявок", "Приём заявок"], ["каталог", "Каталог / заказы"], ["ответы на вопросы", "Ответы на вопросы"], ["несколько функций", "Несколько функций"], ["помогите определиться", "Помогите определиться"]];
        const selectedGoal = goalOptions.find(([key]) => normalizedText.includes(key));
        if (selectedGoal) {
          session.goal = selectedGoal[1];
          session.stage = "details";
          await setChatSession(chatId, session);
          await sendMessage(chatId, "Отлично, записал задачу: " + session.goal + ".\n\nТеперь опишите детали одним сообщением:\n1. Что именно должен делать бот?\n2. Какие данные собирать у клиента?\n3. Куда передавать заявку — вам в MAX, сотруднику или в таблицу/CRM?\n\nЕсли пока не знаете, напишите «Помогите определиться» — подскажем подходящий вариант.", detailKeyboard);
          return json(res, 200, { ok: true, action: "goal_selected", goal: session.goal });
        }
        session.goal = cleanText(text, 1000);
        session.stage = "details";
        await setChatSession(chatId, session);
        await sendMessage(chatId, "Понял задачу: «" + session.goal + "».\n\nТеперь уточним детали. Напишите одним сообщением, что бот должен делать по шагам, какие данные собирать и куда передавать заявки. Можно написать своими словами — необязательно отвечать по пунктам.", detailKeyboard);
        return json(res, 200, { ok: true, action: "goal_text_received" });
      }

      if (session && session.stage === "details" && !normalizedText.includes("цена и сроки") && !normalizedText.includes("менеджер")) {
        if (normalizedText.includes("помогите определиться")) {
          await sendMessage(chatId, "Ничего страшного — поможем составить сценарий. Обычно бот: 1) приветствует клиента, 2) предлагает нужное действие, 3) задаёт 2–4 уточняющих вопроса, 4) сохраняет заявку и уведомляет вас. Напишите сферу бизнеса и какой результат важнее всего: больше заявок, запись, продажи или ответы на частые вопросы.", detailKeyboard);
          return json(res, 200, { ok: true, action: "scenario_help" });
        }
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        const details = cleanText(text, 1800);
        const request = { type: "bot_build_request", chat_id: String(chatId), user_id: sender.user_id ? String(sender.user_id) : null, user_name: senderName, business: session.business || "Не указано", goal: session.goal || "Не указано", details, created_at: new Date().toISOString() };
        await safeSaveLead(request);
        const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
        if (adminChatId) {
          try { await sendMessage(adminChatId, "🆕 Заявка на разработку бота\nОт: " + senderName + "\nЧат: " + chatId + "\nСфера: " + request.business + "\nЗадача: " + request.goal + "\nДетали: " + details + "\n\nЧтобы ответить, откройте чат с клиентом по ID: " + chatId); }
          catch (notificationError) { console.error("MAX admin notification failed:", notificationError && notificationError.message ? notificationError.message : "unknown error"); }
        }
        await clearChatSession(chatId);
        await sendMessage(chatId, "✅ Спасибо! Я собрал описание задачи и передал запрос менеджеру.\n\nСфера: " + request.business + "\nЗадача: " + request.goal + "\nДетали: " + details + "\n\nЕсли хотите добавить телефон или удобное время для связи — отправьте следующим сообщением. Также можно открыть каталог или вернуться в меню.", welcomeKeyboard);
        return json(res, 200, { ok: true, action: "request_submitted" });
      }
      const productActionLabels = [
        "настроить запись", "список услуг", "меню и заказы", "бронирование столика",
        "каталог товаров", "заявки на покупку", "запись в сервис", "заявка по авто",
        "подбор недвижимости", "заявка клиента", "запись в клинику", "услуги и вопросы",
        "заявка на обучение", "программа курса", "заявка на консультацию", "описание услуг",
        "настроить ответы", "сбор заявок", "уточнить функции", "приём заявок", "цена и сроки"
      ];
      if (productActionLabels.some((label) => normalizedText.includes(label))) {
        const action = text;
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        await safeSaveLead({ type: "product_scenario_action", chat_id: String(chatId), user_name: senderName, action, created_at: new Date().toISOString() });
        const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
        if (adminChatId) {
          try { await sendMessage(adminChatId, "Действие по выбранному решению\nОт: " + senderName + "\nЧат: " + chatId + "\nВыбор: " + action); }
          catch (notificationError) { console.error("MAX admin notification failed:", notificationError && notificationError.message ? notificationError.message : "unknown error"); }
        }
        const followup = normalizedText.includes("цена и сроки")
          ? "💰 Цена зависит от функций и интеграций. Напишите, какие функции обязательны и есть ли уже каталог, расписание или CRM. Я передам запрос на расчёт стоимости и сроков."
          : normalizedText.includes("меню и заказы")
          ? "🍽️ Для сценария кафе уточните: нужно показывать меню, принимать предзаказы или бронировать столики? Напишите, что из этого нужно — можно выбрать несколько вариантов текстом."
          : normalizedText.includes("бронирование столика")
          ? "🪑 Для бронирования укажите, нужно ли собирать дату, время, количество гостей и телефон для подтверждения. Напишите ваши пожелания одним сообщением."
          : normalizedText.includes("каталог товаров")
          ? "🛍️ Для каталога напишите, сколько примерно товаров, есть ли фото и цены, нужны ли корзина и онлайн-оплата. Подскажем, какой сценарий подойдёт."
          : normalizedText.includes("заявки на покупку")
          ? "📩 Для заявок на покупку клиент выбирает товар и отправляет запрос продавцу. Напишите, нужно ли собирать телефон, адрес доставки или комментарий к заказу."
          : normalizedText.includes("запись в сервис") || normalizedText.includes("запись в клинику") || normalizedText.includes("настроить запись")
          ? "📅 Для записи уточним список услуг, расписание и способ подтверждения. Напишите, сколько специалистов или мастеров и нужно ли показывать свободное время."
          : normalizedText.includes("заявка по авто")
          ? "🚘 Напишите, какие данные нужно собирать: марка и модель, год выпуска, описание проблемы, желаемое время визита. Укажите нужные пункты."
          : normalizedText.includes("подбор недвижимости")
          ? "🏠 Для подбора уточним тип объекта, бюджет, район и покупку или аренду. Напишите, какие критерии важно собирать у клиента."
          : normalizedText.includes("заявка на обучение") || normalizedText.includes("программа курса")
          ? "🎓 Напишите название курса, формат обучения и какие данные нужны от потенциального ученика. Можно также указать частые вопросы, на которые бот должен отвечать."
          : normalizedText.includes("заявка на консультацию")
          ? "💬 Напишите, какие услуги предлагаете и какую информацию нужно узнать у клиента перед консультацией."
          : normalizedText.includes("настроить ответы") || normalizedText.includes("услуги и вопросы") || normalizedText.includes("список услуг") || normalizedText.includes("описание услуг")
          ? "⚙️ Напишите список услуг или частых вопросов, на которые бот должен отвечать. Если список ещё не готов, просто опишите бизнес и основные вопросы клиентов."
          : "📋 Отлично. Напишите, что именно должен делать бот, какие данные собирать и куда передавать заявку. Можно описать задачу свободным текстом.";
        await sendMessage(chatId, followup, productNextKeyboard);
        return json(res, 200, { ok: true, action: "product_scenario", selection: action });
      }

      if (normalizedText.includes("оставить заявку")) {
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        await safeSaveLead({ type: "product_quote_request", chat_id: String(chatId), user_name: senderName, request: "Пользователь нажал «Оставить заявку» после выбора решения", created_at: new Date().toISOString() });
        const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
        if (adminChatId) {
          try { await sendMessage(adminChatId, "Заявка по выбранному решению\nОт: " + senderName + "\nЧат: " + chatId + "\nКлиент нажал «Оставить заявку». Ожидает уточнения деталей."); }
          catch (notificationError) { console.error("MAX admin notification failed:", notificationError && notificationError.message ? notificationError.message : "unknown error"); }
        }
        await sendMessage(chatId, "📩 Напишите одним сообщением название компании и какие функции нужны. Если уже выбрали решение в каталоге, повторно выбирать его не нужно — мы видим ваш запрос. После сообщения передадим детали менеджеру.", productNextKeyboard);
        return json(res, 200, { ok: true, action: "product_quote_request" });
      }

      if (normalizedText.includes("подобрать бота") || normalizedText.includes("подобрать решение")) {
        await sendMessage(chatId, "🏪 Напишите название или сферу бизнеса и что хотите автоматизировать. Если удобнее — выберите сферу ниже. Необязательно проходить все шаги: можно сразу описать задачу одним сообщением.", businessKeyboard);
        return json(res, 200, { ok: true, action: "choose_bot" });
      }
      if (["салон красоты", "кафе / ресторан", "магазин", "другое"].some((v) => normalizedText.includes(v))) {
        const business = normalizedText.includes("салон красоты") ? "Салон красоты" : normalizedText.includes("кафе / ресторан") ? "Кафе / ресторан" : normalizedText.includes("магазин") ? "Магазин" : "Другое";
        const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        await safeSaveLead({ type: "bot_selection", chat_id: String(chatId), user_name: senderName, business, created_at: new Date().toISOString() });
        if (adminChatId) {
          try { await sendMessage(adminChatId, "Запрос на подбор бота\nОт: " + senderName + "\nЧат: " + chatId + "\nСфера: " + business); }
          catch (notificationError) { console.error("MAX admin notification failed:", notificationError && notificationError.message ? notificationError.message : "unknown error"); }
        }
        await setChatSession(chatId, { stage: "goal", business, started_at: new Date().toISOString() });
        const prompt = business === "Другое"
          ? "Хорошо, подберём сценарий под ваш бизнес. Сначала выберите главную задачу бота ниже. Если нужно несколько функций — выберите этот вариант. Можно также написать задачу обычным сообщением."
          : "Принял: " + business + ". Что бот должен делать в первую очередь? Выберите подходящий вариант ниже. Если задач несколько, выберите «Несколько функций» или опишите всё сообщением.";
        await sendMessage(chatId, prompt, goalKeyboard);
        return json(res, 200, { ok: true, action: "choose_business", business });
      }
      if (normalizedText.includes("главное меню") || normalizedText === "меню" || normalizedText === "🏠 меню") {
        await sendMessage(chatId, "Главное меню 👇 Выберите действие или напишите задачу своими словами.", welcomeKeyboard);
        return json(res, 200, { ok: true, action: "menu" });
      }
      if (normalizedText.includes("узнать цены") || normalizedText === "цены") {
        await sendMessage(chatId, "💰 Ориентировочные цены: бот для салона красоты — от 7 900 ₽, для кафе — от 9 900 ₽, бот-каталог для магазина — от 12 900 ₽. Итоговая стоимость зависит от функций и интеграций. Нажмите «Открыть каталог», чтобы посмотреть решения подробнее.", welcomeKeyboard);
        return json(res, 200, { ok: true, action: "prices" });
      }
      if (normalizedText.includes("как это работает")) {
        await sendMessage(chatId, "⚙️ Как всё проходит: 1. Рассказываете о бизнесе и задаче. 2. Согласуем функции, сроки и стоимость. 3. Подготавливаем решение и помогаем запустить. Оплата — после согласования состава работ. Чтобы начать, нажмите «Подобрать бота» или напишите свою задачу.");
        return json(res, 200, { ok: true, action: "how_it_works" });
      }
      if (normalizedText.includes("связаться с менеджером") || normalizedText === "менеджер") {
        await sendMessage(chatId, "👨‍💼 Напишите, какой у вас бизнес и что нужно сделать. Я передам запрос менеджеру. Можно сразу написать всё одним сообщением — ждать вопросов и нажимать дополнительные кнопки не нужно.");
        return json(res, 200, { ok: true, action: "manager" });
      }

      const adminChatId = process.env.MAX_ADMIN_CHAT_ID;
      if (adminChatId) {
        const senderName = cleanText(sender.name, 120) || "Покупатель";
        const product = cleanText(body.text, 1200);
        try {
          await sendMessage(adminChatId, `Новая заявка с сайта Франшиза\nОт: ${senderName}\nЧат: ${chatId}\nСообщение: ${product}`);
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
