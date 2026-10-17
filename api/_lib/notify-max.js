async function notifyMax(config, item) {
  if (!config.maxBotToken || !config.maxAdminChatId) return { sent: false, reason: "MAX_NOT_CONFIGURED" };
  const message = [
    "Новая заявка на franshiza",
    "",
    "ID: " + item.id,
    "Имя: " + item.name,
    "Контакт: " + item.contact,
    "Бизнес: " + (item.business || "не указан"),
    "Решение: " + (item.productId || "индивидуальный запрос"),
    "Комментарий: " + (item.comment || "не указан"),
    "Дата: " + item.createdAt
  ].join("\n").slice(0, 3900);
  const response = await fetch(
    "https://platform-api2.max.ru/messages?chat_id=" + encodeURIComponent(config.maxAdminChatId),
    {
      method: "POST",
      headers: {
        Authorization: config.maxBotToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: message, disable_link_preview: true }),
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!response.ok) {
    // Do not log or expose the bot token or raw API response.
    return { sent: false, reason: "MAX_API_ERROR", status: response.status };
  }
  return { sent: true };
}

module.exports = { notifyMax };
