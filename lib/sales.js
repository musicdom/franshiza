const { requestMax } = require("./max-api");

const PRODUCTS = [
  { id: "salon", name: "Бот для салона красоты", category: "Красота и услуги", price: "от 7 900 ₽", priceValue: 7900, goal: ["booking", "leads"], problem: "Клиентам нужно узнать об услугах и оставить запрос на запись, даже когда администратор занят.", audience: "Салоны красоты, барбершопы и частные мастера", features: ["Список услуг и ответы на частые вопросы", "Сбор желаемой даты и времени", "Передача заявки администратору"], demo: "Клиент выбирает услугу, указывает удобное время и отправляет запрос. Подтверждение записи требует участия администратора, если календарь не подключён.", requirements: "Нужны список услуг, цены, график и контакт администратора.", limitations: "Автоматическая проверка свободных слотов не включена без интеграции с календарём." },
  { id: "cafe", name: "Бот для кафе и ресторана", category: "Еда и доставка", price: "от 9 900 ₽", priceValue: 9900, goal: ["catalog", "leads", "booking"], problem: "Гостям удобно посмотреть меню и оставить запрос без ожидания ответа сотрудника.", audience: "Кафе, рестораны и небольшие службы доставки", features: ["Разделы меню и информация о заведении", "Запрос на заказ или бронирование", "Передача обращения сотруднику"], demo: "Гость выбирает интересующий раздел и описывает заказ или бронирование. Подтверждение выполняет сотрудник.", requirements: "Нужны меню, цены, режим работы и правила приёма заказов.", limitations: "Онлайн-оплата и интеграция с кассой не включены автоматически." },
  { id: "store", name: "Бот-каталог для магазина", category: "Магазины", price: "от 12 900 ₽", priceValue: 12900, goal: ["catalog", "sales", "leads"], problem: "Покупателю нужен быстрый доступ к ассортименту и способ спросить о товаре.", audience: "Магазины с каталогом товаров или услуг", features: ["Категории и карточки товаров", "Описание и цены из предоставленных данных", "Заявка продавцу по выбранной позиции"], demo: "Покупатель выбирает товар и отправляет вопрос или заявку продавцу.", requirements: "Нужны ассортимент, актуальные цены и изображения при наличии.", limitations: "Синхронизация остатков, корзина и онлайн-оплата требуют отдельных интеграций." },
  { id: "auto", name: "Бот для автосервиса", category: "Авто", price: "от 7 900 ₽", priceValue: 7900, goal: ["booking", "leads"], problem: "Перед консультацией важно собрать сведения об автомобиле и проблеме.", audience: "Автосервисы, шиномонтажи и автомастера", features: ["Марка и модель автомобиля", "Описание проблемы или услуги", "Предпочтительное время визита"], demo: "Клиент описывает автомобиль и услугу, после чего запрос передаётся сотруднику.", requirements: "Нужны список услуг, часы работы и контакт ответственного.", limitations: "Свободные слоты и подтверждение визита не синхронизируются без календаря." },
  { id: "realty", name: "Бот для недвижимости", category: "Недвижимость", price: "от 12 900 ₽", priceValue: 12900, goal: ["leads", "sales"], problem: "Агенту проще работать с заявкой, где уже указаны тип объекта, бюджет и предпочтения.", audience: "Агентства недвижимости и частные агенты", features: ["Тип объекта и цель обращения", "Бюджет и предпочтения", "Структурированная заявка агенту"], demo: "Клиент указывает параметры поиска и отправляет запрос специалисту.", requirements: "Нужны критерии подбора и актуальные контакты агента.", limitations: "Автоматическая синхронизация базы объектов не включена без источника данных." },
  { id: "clinic", name: "Бот для клиники", category: "Здоровье и сервис", price: "от 9 900 ₽", priceValue: 9900, goal: ["booking", "faq", "leads"], problem: "Пациенту важно быстро найти общую информацию и оставить запрос администратору.", audience: "Клиники и сервисные организации", features: ["Общая информация об услугах", "Запрос на запись или обратную связь", "Передача вопроса администратору"], demo: "Пользователь выбирает направление и оставляет запрос на связь.", requirements: "Нужны проверенные описания услуг, график и контакты.", limitations: "Бот не ставит диагнозы и не заменяет медицинскую консультацию; запись зависит от интеграций." },
  { id: "school", name: "Бот для онлайн-школы", category: "Обучение", price: "от 14 900 ₽", priceValue: 14900, goal: ["faq", "sales", "leads"], problem: "Потенциальному ученику нужны программа, ответы на вопросы и простой путь оставить заявку.", audience: "Онлайн-школы, курсы и образовательные проекты", features: ["Презентация программы", "Ответы на типовые вопросы", "Заявка на обучение"], demo: "Ученик знакомится с курсом и отправляет запрос менеджеру.", requirements: "Нужны программа, формат, условия обучения и FAQ.", limitations: "Приём платежей и выдача доступа к учебной платформе требуют интеграции." },
  { id: "expert", name: "Бот для эксперта и консультанта", category: "Эксперты и услуги", price: "от 6 900 ₽", priceValue: 6900, goal: ["leads", "booking", "faq"], problem: "Помогает объяснить услугу и собрать запрос до личного разговора.", audience: "Консультанты, эксперты и частные специалисты", features: ["Описание услуг", "Уточнение задачи клиента", "Заявка на консультацию"], demo: "Клиент выбирает тему и описывает задачу, эксперт получает структурированный запрос.", requirements: "Нужны описание услуг, частые вопросы и контакт для заявок.", limitations: "Запись в календарь не включена без интеграции." },
  { id: "assistant", name: "Бизнес-ассистент в MAX", category: "Автоматизация", price: "от 5 900 ₽", priceValue: 5900, goal: ["faq", "leads"], problem: "Снимает часть повторяющихся вопросов и собирает первичную информацию.", audience: "Малый бизнес и команды, которым нужен простой первый сценарий", features: ["Ответы на согласованный набор вопросов", "Сбор сведений по сценарию", "Передача сложного вопроса человеку"], demo: "Пользователь задаёт вопрос или оставляет запрос, который при необходимости получает менеджер.", requirements: "Нужны FAQ, контакты и правила передачи сложных вопросов.", limitations: "Ответы ограничены предоставленной базой знаний и настроенным сценарием." }
];

const GOALS = [
  { id: "leads", label: "📩 Принимать заявки круглосуточно" },
  { id: "booking", label: "📅 Записывать клиентов" },
  { id: "sales", label: "🛒 Продавать товары или услуги" },
  { id: "catalog", label: "🛍️ Показывать каталог и цены" },
  { id: "faq", label: "💬 Отвечать на частые вопросы" },
  { id: "custom", label: "⚙️ Индивидуальный бот" }
];

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function redis(parts) {
  const config = redisConfig();
  if (!config) throw new Error("Redis REST is not configured");
  const response = await fetch(config.url, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(parts) });
  if (!response.ok) throw new Error("Redis HTTP request failed");
  const result = await response.json();
  if (result.error) throw new Error("Redis command failed");
  return result.result;
}
async function getJson(key) {
  try { const value = await redis(["GET", key]); return value ? JSON.parse(value) : null; } catch { return null; }
}
async function setJson(key, value, ttl = 2592000) { return redis(["SET", key, JSON.stringify(value), "EX", String(ttl)]); }
async function recordEvent(event) {
  const now = new Date();
  const item = { ...event, occurred_at: event.occurred_at || now.toISOString() };
  const day = item.occurred_at.slice(0, 10);
  const stable = item.event_id || [item.event, item.chat_id || "anonymous", item.product_id || "", item.lead_id || "", item.message_id || "", day].join(":");
  const id = stable.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
  item.event_id = id;
  const result = await redis(["SET", `maxbiz:event:${id}`, JSON.stringify(item), "EX", "7776000", "NX"]);
  if (result === "OK") {
    await redis(["LPUSH", "maxbiz:events", id]);
    await redis(["LTRIM", "maxbiz:events", "0", "9999"]);
  }
  return item;
}
async function queueReminder(chatId, session, delayMs, type = "resume") {
  const now = Date.now();
  const id = `${chatId}-${type}-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const reminder = { id, chat_id: String(chatId), type, due_at: now + delayMs, session_updated_at: session.updated_at || session.last_activity || null, created_at: new Date(now).toISOString() };
  await setJson(`maxbiz:reminder:${id}`, reminder, 1209600);
  await redis(["ZADD", "maxbiz:reminders:pending", String(reminder.due_at), id]);
  return id;
}
async function cancelReminders(chatId) {
  const ids = await redis(["ZRANGE", "maxbiz:reminders:pending", "0", "499"]);
  for (const id of ids || []) {
    if (String(id).startsWith(String(chatId) + "-")) await redis(["ZREM", "maxbiz:reminders:pending", id]);
  }
}
async function saveSession(chatId, session, ttl = 2592000) {
  session.updated_at = new Date().toISOString();
  await setJson(`maxbiz:session:${chatId}`, session, ttl);
  return session;
}
async function getSession(chatId) { return getJson(`maxbiz:session:${chatId}`); }
async function saveLead(lead) {
  const id = `REQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const item = { ...lead, id, status: "new", created_at: new Date().toISOString() };
  await setJson(`maxbiz:lead:${id}`, item);
  await redis(["LPUSH", "maxbiz:leads", id]);
  await redis(["LTRIM", "maxbiz:leads", "0", "999"]);
  await recordEvent({ event: "lead_created", chat_id: item.chat_id, product_id: item.product_id || null, lead_id: id });
  return item;
}
async function listLeads(limit = 100) {
  const ids = await redis(["LRANGE", "maxbiz:leads", "0", String(Math.max(0, limit - 1))]);
  const rows = [];
  for (const id of ids || []) { const item = await getJson(`maxbiz:lead:${id}`); if (item) rows.push(item); }
  return rows;
}
async function updateLead(id, patch) {
  const item = await getJson(`maxbiz:lead:${id}`);
  if (!item) return null;
  const updated = { ...item, ...patch, updated_at: new Date().toISOString() };
  await setJson(`maxbiz:lead:${id}`, updated);
  return updated;
}
async function listEventIds(limit = 1000) {
  return redis(["LRANGE", "maxbiz:events", "0", String(Math.max(0, limit - 1))]);
}
module.exports = { PRODUCTS, GOALS, redisConfig, redis, getJson, setJson, recordEvent, queueReminder, cancelReminders, saveSession, getSession, saveLead, listLeads, updateLead, listEventIds };
