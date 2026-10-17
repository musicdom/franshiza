const sales = require("./sales");

async function handleSalesMessage({ chatId, sender, text, normalizedText, sendMessage, welcomeKeyboard }) {
  let session = await sales.getSession(chatId);
  const reply = async (message, keyboard) => sendMessage(chatId, message, keyboard || welcomeKeyboard);
  const saveSession = async (patch, stage) => {
    session = await sales.saveSession(chatId, { ...(session || {}), ...patch, ...(stage ? { stage } : {}), last_activity: new Date().toISOString(), last_reminder_at: null });
    try {
      await sales.cancelReminders(chatId);
      if (session.consent_marketing && !session.purchased && stage !== "main_menu") await sales.queueReminder(chatId, session, 45 * 60 * 1000, "resume");
    } catch (error) { console.error("Reminder scheduling failed"); }
    return session;
  };
  const productButtons = (items) => items.slice(0, 4).map(p => [{ type: "callback", text: "🔍 " + p.name, payload: String("🔍 " + p.name) }]);
  const sendList = async (items, heading) => {
    const ids = items.map(p => p.id);
    const existingIds = session?.catalog_items || [];
    if (ids.join(",") !== existingIds.join(",")) {
      session = await saveSession({ catalog_items: ids, catalog_page: 0 }, session?.stage || "sales_catalog");
    }
    const page = Math.max(0, Number(session?.catalog_page || 0));
    const selected = items.slice(page * 4, page * 4 + 4);
    const summary = selected.map((p, i) => (page * 4 + i + 1) + ". " + p.name + " — " + p.price + "\n" + p.problem + "\nДля кого: " + p.audience + "\nОграничение: " + p.limitations).join("\n\n");
    const buttons = productButtons(selected);
    if (page > 0) buttons.push([{ type: "callback", text: "⬅️ Предыдущие решения", payload: String("⬅️ Предыдущие решения") }]);
    if (items.length > (page + 1) * 4) buttons.push([{ type: "callback", text: "➡️ Ещё решения", payload: String("➡️ Ещё решения") }]);
    buttons.push([{ type: "callback", text: "⚖️ Сравнить варианты", payload: String("⚖️ Сравнить варианты") }, { type: "callback", text: "↩️ Изменить ответы", payload: String("↩️ Изменить ответы") }]);
    buttons.push([{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]);
    await reply(heading + "\n\n" + summary + "\n\nСтоимость ориентировочная. Точный состав, сроки и условия подтверждаются до начала работ.", [{ type: "inline_keyboard", payload: { buttons } }]);
    await sales.recordEvent({ event: "recommendation_shown", chat_id: String(chatId), product_ids: selected.map(p => p.id) });
  };
  const sendCard = async (p) => {
    await saveSession({ product_id: p.id, last_product_id: p.id, stage: "sales_product" }, "sales_product");
    await sales.recordEvent({ event: "product_viewed", chat_id: String(chatId), product_id: p.id });
    await reply("🧩 " + p.name + "\n\nДля кого: " + p.audience + "\n\nЗадача: " + p.problem + "\n\nФункции:\n• " + p.features.join("\n• ") + "\n\nПример работы: " + p.demo + "\n\nЧто потребуется: " + p.requirements + "\n\nОграничения: " + p.limitations + "\n\nОриентировочная цена: " + p.price + "\n\nОплата и автоматическая выдача пока не подключены. До начала работ подтверждаем состав и итоговую стоимость.", [{ type: "inline_keyboard", payload: { buttons: [
      [{ type: "callback", text: "▶️ Посмотреть демо", payload: String("▶️ Посмотреть демо") }, { type: "callback", text: "💳 Узнать стоимость", payload: String("💳 Узнать стоимость") }],
      [{ type: "callback", text: "⭐ Сохранить решение", payload: String("⭐ Сохранить решение") }, { type: "callback", text: "🛒 Оформить заявку", payload: String("🛒 Оформить заявку") }],
      [{ type: "callback", text: "💬 Консультация", payload: String("💬 Консультация") }, { type: "callback", text: "⚖️ Сравнить варианты", payload: String("⚖️ Сравнить варианты") }],
      [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
    ] } }]);
  };
  const normalized = normalizedText;
  if (normalized.includes("главное меню") || normalized === "меню" || normalized === "start" || normalized === "/start") {
    await saveSession({ stage: "main_menu" }, "main_menu");
    await reply("Главное меню. Выберите каталог, подбор, демонстрации или свои заявки. Можно также написать задачу своими словами.");
    return { handled: true, action: "main_menu" };
  }
  if (normalized.includes("продолжить подбор")) {
    await sales.recordEvent({ event: "reminder_clicked", chat_id: String(chatId), product_id: session?.product_id || session?.last_product_id || null });
    await reply("Продолжаем с сохранённого шага. Выберите подбор или откройте последнее решение из каталога.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🎯 Подобрать бота", payload: String("🎯 Подобрать бота") }, { type: "callback", text: "🛍 Каталог решений", payload: String("🛍 Каталог решений") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "reminder_clicked" };
  }
  if (normalized.includes("отключить уведомления") || normalized.includes("отписаться") || normalized.includes("не присылать")) {
    await saveSession({ consent_marketing: false, reminders_disabled_at: new Date().toISOString() }, session?.stage || "main_menu");
    await sales.recordEvent({ event: "notification_opted_out", chat_id: String(chatId) });
    await reply("🔕 Маркетинговые напоминания отключены. Сервисные сообщения по заявкам могут приходить по необходимости. Включить напоминания можно в разделе «Уведомления».");
    return { handled: true, action: "opted_out" };
  }
  if (normalized.includes("включить напоминания")) {
    await saveSession({ consent_marketing: true, consent_at: new Date().toISOString() }, session?.stage || "main_menu");
    await sales.recordEvent({ event: "notification_opted_in", chat_id: String(chatId) });
    await reply("🔔 Согласие на маркетинговые напоминания сохранено. Они будут касаться незавершённого подбора или оформления. Отключить можно в любой момент.");
    return { handled: true, action: "opted_in" };
  }
  if (normalized.includes("уведомления")) {
    const enabled = Boolean(session?.consent_marketing);
    await reply("Настройки уведомлений\n\nМаркетинговые напоминания сейчас " + (enabled ? "включены" : "выключены") + ".", [{ type: "inline_keyboard", payload: { buttons: [
      [{ type: "callback", text: enabled ? "🔕 Отключить уведомления" : "🔔 Включить напоминания", payload: String(enabled ? "🔕 Отключить уведомления" : "🔔 Включить напоминания") }],
      [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
    ] } }]);
    return { handled: true, action: "notification_settings" };
  }
  if (normalized.includes("каталог решений") || normalized === "каталог" || normalized.includes("открыть каталог")) {
    await saveSession({ stage: "sales_catalog" }, "sales_catalog");
    const categories = [...new Set(sales.PRODUCTS.map(p => p.category))];
    await reply("🛍 Каталог готовых сценариев. Выберите сферу бизнеса или посмотрите все решения.", [{ type: "inline_keyboard", payload: { buttons: categories.map(c => [{ type: "callback", text: c, payload: String(c) }]).concat([[{ type: "callback", text: "📋 Все решения", payload: String("📋 Все решения") }, { type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]]) } }]);
    return { handled: true, action: "catalog" };
  }
  if (normalized.includes("подобрать бота") || normalized.includes("подобрать решение") || normalized.includes("изменить ответы")) {
    await saveSession({ stage: "sales_business", business: null, goal: null, priority: null }, "sales_business");
    await reply("🎯 Для какого бизнеса ищете решение? Выберите сферу или напишите её своими словами.", [{ type: "inline_keyboard", payload: { buttons: [
      [{ type: "callback", text: "Салоны и барбершопы", payload: String("Салоны и барбершопы") }, { type: "callback", text: "Кафе и рестораны", payload: String("Кафе и рестораны") }],
      [{ type: "callback", text: "Магазины", payload: String("Магазины") }, { type: "callback", text: "Обучение", payload: String("Обучение") }],
      [{ type: "callback", text: "Недвижимость", payload: String("Недвижимость") }, { type: "callback", text: "Автосервисы", payload: String("Автосервисы") }],
      [{ type: "callback", text: "Клиники и сервис", payload: String("Клиники и сервис") }, { type: "callback", text: "Эксперты и услуги", payload: String("Эксперты и услуги") }],
      [{ type: "callback", text: "Другое", payload: String("Другое") }, { type: "callback", text: "Пропустить сферу", payload: String("Пропустить сферу") }],
      [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
    ] } }]);
    return { handled: true, action: "recommendation_started" };
  }
  if (session?.stage === "sales_business") {
    const map = [["салон", "Красота и услуги"], ["барбершоп", "Красота и услуги"], ["кафе", "Еда и доставка"], ["ресторан", "Еда и доставка"], ["магазин", "Магазины"], ["обучение", "Обучение"], ["школ", "Обучение"], ["недвиж", "Недвижимость"], ["автосервис", "Авто"], ["клиник", "Здоровье и сервис"], ["сервис", "Здоровье и сервис"], ["эксперт", "Эксперты и услуги"], ["услуг", "Эксперты и услуги"]];
    const match = map.find(([key]) => normalized.includes(key));
    await sales.recordEvent({ event: "category_selected", chat_id: String(chatId), category: match ? match[1] : text.slice(0, 100) });
    await saveSession({ business: match ? match[1] : (normalized.includes("пропустить") ? null : text.slice(0, 100)), stage: "sales_goal" }, "sales_goal");
    await reply("Что хотите улучшить в первую очередь?", [{ type: "inline_keyboard", payload: { buttons: [
      [{ type: "callback", text: "📩 Принимать заявки", payload: String("📩 Принимать заявки") }, { type: "callback", text: "📅 Записывать клиентов", payload: String("📅 Записывать клиентов") }],
      [{ type: "callback", text: "🛒 Продавать товары или услуги", payload: String("🛒 Продавать товары или услуги") }, { type: "callback", text: "🛍️ Каталог и цены", payload: String("🛍️ Каталог и цены") }],
      [{ type: "callback", text: "💬 Ответы на вопросы", payload: String("💬 Ответы на вопросы") }, { type: "callback", text: "⚙️ Индивидуальный бот", payload: String("⚙️ Индивидуальный бот") }],
      [{ type: "callback", text: "Пропустить вопрос", payload: String("Пропустить вопрос") }, { type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
    ] } }]);
    return { handled: true, action: "business_selected" };
  }
  if (session?.stage === "sales_goal") {
    const map = [["принимать заявки", "leads"], ["записывать клиентов", "booking"], ["продавать", "sales"], ["каталог", "catalog"], ["ответы на вопросы", "faq"], ["индивидуальный", "custom"]];
    const match = map.find(([key]) => normalized.includes(key));
    await saveSession({ goal: match ? match[1] : "custom", stage: "sales_priority" }, "sales_priority");
    await reply("Что для вас сейчас важнее?", [{ type: "inline_keyboard", payload: { buttons: [
      [{ type: "callback", text: "⚡ Запуститься быстрее", payload: String("⚡ Запуститься быстрее") }],
      [{ type: "callback", text: "⏱️ Сэкономить время сотрудников", payload: String("⏱️ Сэкономить время сотрудников") }],
      [{ type: "callback", text: "📈 Больше заявок и продаж", payload: String("📈 Больше заявок и продаж") }],
      [{ type: "callback", text: "🧩 Решение под мои задачи", payload: String("🧩 Решение под мои задачи") }],
      [{ type: "callback", text: "Пропустить вопрос", payload: String("Пропустить вопрос") }, { type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]
    ] } }]);
    return { handled: true, action: "goal_selected" };
  }
  if (session?.stage === "sales_priority") {
    const priority = normalized.includes("быстрее") ? "speed" : normalized.includes("время") ? "time" : normalized.includes("заявок") ? "leads" : null;
    const matches = sales.PRODUCTS.filter(p => (!session.business || p.category === session.business) && (!session.goal || session.goal === "custom" || p.goal.includes(session.goal)));
    const recommendations = (matches.length ? matches : sales.PRODUCTS.filter(p => !session.goal || session.goal === "custom" || p.goal.includes(session.goal))).slice(0, 3);
    await saveSession({ priority, recommendations: recommendations.map(p => p.id), stage: "sales_recommendations" }, "sales_recommendations");
    await sendList(recommendations, "🎯 Подборка под ваш запрос");
    return { handled: true, action: "recommendations" };
  }
  if (normalized.includes("ещё решения") || normalized.includes("предыдущие решения")) {
    const ids = session?.catalog_items || sales.PRODUCTS.map(p => p.id);
    const items = ids.map(id => sales.PRODUCTS.find(p => p.id === id)).filter(Boolean);
    const maxPage = Math.max(0, Math.ceil(items.length / 4) - 1);
    const page = normalized.includes("ещё") ? Math.min(maxPage, Number(session?.catalog_page || 0) + 1) : Math.max(0, Number(session?.catalog_page || 0) - 1);
    await saveSession({ catalog_items: ids, catalog_page: page }, session?.stage || "sales_catalog");
    await sendList(items, "Продолжение каталога");
    return { handled: true, action: "catalog_page", page };
  }
  if (normalized.includes("все решения") || normalized.includes("все продукты")) {
    await sendList(sales.PRODUCTS, "🛍 Каталог решений");
    return { handled: true, action: "all_products" };
  }
  if (session?.stage === "sales_catalog") {
    const category = sales.PRODUCTS.find(p => normalized.includes(p.category.toLowerCase()))?.category;
    const items = category ? sales.PRODUCTS.filter(p => p.category === category) : sales.PRODUCTS.filter(p => p.name.toLowerCase().includes(normalized) || p.category.toLowerCase().includes(normalized));
    if (items.length) { await saveSession({ stage: "sales_recommendations", recommendations: items.map(p => p.id) }, "sales_recommendations"); await sendList(items, "Решения по выбранному направлению"); }
    else await reply("Не нашёл точного совпадения. Покажу весь каталог или подберу решение по задаче.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "📋 Все решения", payload: String("📋 Все решения") }, { type: "callback", text: "🎯 Подобрать бота", payload: String("🎯 Подобрать бота") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "catalog_category" };
  }
  const product = productByMessage(normalized);
  if (product) { await sendCard(product); return { handled: true, action: "product_viewed" }; }
  if (normalized.includes("демонстрации") || normalized.includes("посмотреть демо")) {
    const p = sales.PRODUCTS.find(item => item.id === session?.product_id || item.id === session?.last_product_id);
    if (!p) { await reply("Выберите решение, для которого показать пример.", [{ type: "inline_keyboard", payload: { buttons: productButtons(sales.PRODUCTS).concat([[{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]]) } }]); }
    else {
      await sales.recordEvent({ event: "demo_opened", chat_id: String(chatId), product_id: p.id });
      await reply("▶️ Пример работы: " + p.name + "\n\n" + p.demo + "\n\nЭто демонстрация сценария, а не подключённая система записи, оплаты или учёта.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🛒 Оформить заявку", payload: String("🛒 Оформить заявку") }, { type: "callback", text: "💳 Узнать стоимость", payload: String("💳 Узнать стоимость") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    }
    return { handled: true, action: "demo" };
  }
  if (normalized.includes("узнать стоимость") || normalized.includes("цена и сроки") || normalized === "цены" || normalized.includes("узнать цену")) {
    const p = sales.PRODUCTS.find(item => item.id === session?.product_id || item.id === session?.last_product_id);
    if (p) {
      await sales.recordEvent({ event: "price_viewed", chat_id: String(chatId), product_id: p.id });
      await reply("💳 " + p.name + "\nОриентировочная цена: " + p.price + "\n\nСостав, интеграции и сроки согласуются до начала работ. Онлайн-оплата в боте сейчас не подключена.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🛒 Оформить заявку", payload: String("🛒 Оформить заявку") }, { type: "callback", text: "💬 Консультация", payload: String("💬 Консультация") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    } else await sendList(sales.PRODUCTS, "💰 Ориентировочные цены");
    return { handled: true, action: "price_viewed" };
  }
  if (normalized.includes("сравнить варианты")) {
    const items = (session?.recommendations || sales.PRODUCTS.slice(0, 3).map(p => p.id)).map(id => sales.PRODUCTS.find(p => p.id === id)).filter(Boolean).slice(0, 3);
    await reply("⚖️ Сравнение\n\n" + items.map(p => "• " + p.name + " — " + p.price + "\nДля кого: " + p.audience + "\nФункция: " + p.features[0] + "\nОграничение: " + p.limitations).join("\n\n"), [{ type: "inline_keyboard", payload: { buttons: productButtons(items).concat([[{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]]) } }]);
    return { handled: true, action: "compare" };
  }
  if (normalized.includes("сохранить решение")) {
    const id = session?.product_id || session?.last_product_id;
    if (!id) await reply("Сначала откройте карточку решения.", welcomeKeyboard);
    else { await saveSession({ saved_products: [...new Set([...(session.saved_products || []), id])] }, session.stage); await sales.recordEvent({ event: "product_saved", chat_id: String(chatId), product_id: id }); await reply("⭐ Решение сохранено. Найти его можно в разделе «Мои заявки»."); }
    return { handled: true, action: "product_saved" };
  }
  if (normalized.includes("мои заявки") || normalized.includes("мои покупки") || normalized.includes("заказы")) {
    const saved = (session?.saved_products || []).map(id => sales.PRODUCTS.find(p => p.id === id)).filter(Boolean);
    const leads = await sales.listLeads(100);
    const mine = leads.filter(item => String(item.chat_id) === String(chatId)).slice(0, 5);
    await reply("📦 Ваш раздел\n\nСохранённые решения:\n" + (saved.length ? saved.map(p => "• " + p.name + " — " + p.price).join("\n") : "Пока нет.") + "\n\nПоследние заявки:\n" + (mine.length ? mine.map(l => "• " + l.id + " — " + l.status).join("\n") : "Пока нет заявок.") + "\n\nПодтверждённых онлайн-покупок нет: платёжная интеграция не подключена.");
    return { handled: true, action: "my_requests" };
  }
  if (session?.stage === "sales_lead_details" && !normalized.includes("главное меню")) {
    const p = sales.PRODUCTS.find(item => item.id === session.last_product_id || item.id === session.product_id);
    const lead = await sales.saveLead({ type: "sales_inquiry", chat_id: String(chatId), user_id: sender.user_id ? String(sender.user_id) : null, user_name: sender.name || "Покупатель", business: session.business || null, goal: session.goal || null, product_id: p?.id || null, purchase_intent: Boolean(session.purchase_intent), details: text.slice(0, 1800) });
    if (process.env.MAX_ADMIN_CHAT_ID) { try { await sendMessage(process.env.MAX_ADMIN_CHAT_ID, "🆕 Заявка " + lead.id + "\nОт: " + lead.user_name + "\nЧат: " + chatId + "\nРешение: " + (p?.name || "не выбрано") + "\nОписание: " + lead.details); } catch (e) { console.error("Admin notification failed"); } }
    await saveSession({ stage: "main_menu", last_lead_id: lead.id, purchase_intent: false }, "main_menu");
    await reply("✅ Заявка принята. Номер: " + lead.id + "\nСтатус: новая заявка, не оплата. Срок ответа не обещаю, чтобы не вводить в заблуждение.");
    return { handled: true, action: "lead_created", lead_id: lead.id };
  }
  if (normalized.includes("оформить заявку") || normalized.includes("купить") || normalized.includes("консультация")) {
    await sales.recordEvent({ event: ["checkout", "started"].join("_"), chat_id: String(chatId), product_id: session?.product_id || session?.last_product_id || null });
    await saveSession({ stage: "sales_lead_details", purchase_intent: true, last_product_id: session?.product_id || session?.last_product_id }, "sales_lead_details");
    await reply("💬 Напишите одним сообщением сферу бизнеса, что хотите автоматизировать и какие функции важны.\n\nВажно: онлайн-оплата и автоматическая выдача не подключены. Сейчас это заявка, а не оплаченный заказ.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "lead_details" };
  }

  if (normalized.includes("задать вопрос") || normalized.includes("помощь")) {
    await saveSession({ stage: "sales_support" }, "sales_support");
    await reply("Напишите вопрос обычным сообщением. Я сохраню его и передам администратору, если уведомления настроены.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "support_start" };
  }
  if (session?.stage === "sales_support") {
    const lead = await sales.saveLead({ type: "support_question", chat_id: String(chatId), user_name: sender.name || "Покупатель", details: text.slice(0, 1800) });
    if (process.env.MAX_ADMIN_CHAT_ID) { try { await sendMessage(process.env.MAX_ADMIN_CHAT_ID, "💬 Вопрос " + lead.id + "\nЧат: " + chatId + "\n" + lead.details); } catch (e) { console.error("Admin notification failed"); } }
    await saveSession({ stage: "main_menu", last_lead_id: lead.id }, "main_menu");
    await reply("Вопрос сохранён под номером " + lead.id + ".");
    return { handled: true, action: "support_question" };
  }
  if (normalized.includes("дорого") || normalized.includes("дороговато")) {
    const cheaper = sales.PRODUCTS.find(p => p.id === "assistant");
    await reply("Понимаю. Стоимость зависит от состава работ и интеграций. Можно начать с простого сценария и расширять его позже. Например, " + cheaper.name + " — " + cheaper.price + ". Это ориентир; точный состав подтвердим до начала работ.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🔍 " + cheaper.name, payload: String("🔍 " + cheaper.name) }], [{ type: "callback", text: "⚖️ Сравнить варианты", payload: String("⚖️ Сравнить варианты") }, { type: "callback", text: "💬 Консультация", payload: String("💬 Консультация") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "objection_price" };
  }
  if (normalized.includes("подумать") || normalized.includes("позже")) {
    const id = session?.product_id || session?.last_product_id;
    if (id) await saveSession({ saved_products: [...new Set([...(session.saved_products || []), id])] }, session.stage);
    await reply("Конечно. Сохранил выбранное решение, если оно уже было открыто. Можно посмотреть демо, сравнить варианты или вернуться в каталог позже.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "▶️ Посмотреть демо", payload: String("▶️ Посмотреть демо") }, { type: "callback", text: "⚖️ Сравнить варианты", payload: String("⚖️ Сравнить варианты") }], [{ type: "callback", text: "🛍 Каталог решений", payload: String("🛍 Каталог решений") }, { type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "objection_think" };
  }
  if (normalized.includes("не разбираюсь") || normalized.includes("не понимаю")) {
    await reply("Это нормально. Бот — это меню в MAX, которое задаёт клиенту понятные вопросы, показывает информацию и передаёт запрос сотруднику. Автоматическая запись, оплата и CRM работают только при наличии соответствующих интеграций. Могу подобрать самый простой сценарий.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🎯 Подобрать бота", payload: String("🎯 Подобрать бота") }, { type: "callback", text: "💬 Консультация", payload: String("💬 Консультация") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "objection_simple" };
  }
  if (normalized.includes("не подойдёт") || normalized.includes("не подойдет") || normalized.includes("а вдруг")) {
    const p = sales.PRODUCTS.find(item => item.id === session?.product_id || item.id === session?.last_product_id);
    await reply((p ? "У " + p.name + " есть ограничения: " + p.limitations : "У каждого решения есть ограничения и требования к данным.") + " До заказа можно согласовать состав работ или обсудить задачу с менеджером.", [{ type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "▶️ Посмотреть демо", payload: String("▶️ Посмотреть демо") }, { type: "callback", text: "💬 Консультация", payload: String("💬 Консультация") }], [{ type: "callback", text: "🏠 Главное меню", payload: String("🏠 Главное меню") }]] } }]);
    return { handled: true, action: "objection_fit" };
  }
  const lead = await sales.saveLead({ type: "sales_inquiry", chat_id: String(chatId), user_id: sender.user_id ? String(sender.user_id) : null, user_name: sender.name || "Покупатель", business: session?.business || null, goal: session?.goal || null, product_id: session?.product_id || session?.last_product_id || null, details: text.slice(0, 1800), consent_marketing: Boolean(session?.consent_marketing) });
  if (process.env.MAX_ADMIN_CHAT_ID) { try { await sendMessage(process.env.MAX_ADMIN_CHAT_ID, "🆕 Запрос " + lead.id + "\nОт: " + lead.user_name + "\nЧат: " + chatId + "\nТекст: " + lead.details); } catch (e) { console.error("Admin notification failed"); } }
  await saveSession({ stage: "main_menu", last_lead_id: lead.id }, "main_menu");
  await reply("Понял ваш запрос и сохранил его под номером " + lead.id + ". Он передан администратору, если уведомления настроены. Если хотите, можно продолжить через каталог или подбор.", welcomeKeyboard);
  return { handled: true, action: "free_text_lead", lead_id: lead.id };
}
module.exports = { handleSalesMessage };
