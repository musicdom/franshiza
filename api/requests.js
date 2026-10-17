const { getConfig } = require("../lib/server/config");
const { json, method, requireSameOrigin, clientIp } = require("../lib/server/http");
const { rateLimit, saveRequest, updateRequest } = require("../lib/server/store");
const { notifyMax } = require("../lib/server/notify-max");
const crypto = require("node:crypto");

function textField(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (!method(req, res, ["POST"])) return;
  if (!requireSameOrigin(req)) return json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
  let config;
  try { config = getConfig(); } catch { return json(res, 503, { error: "SERVICE_NOT_CONFIGURED", message: "Приём заявок временно не настроен." }); }

  const ipKey = crypto.createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 32);
  try {
    if (!(await rateLimit(config, ipKey, 5, 900))) {
      res.setHeader("Retry-After", "900");
      return json(res, 429, { error: "RATE_LIMITED", message: "Слишком много попыток. Попробуйте позже." });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const name = textField(body.name, 100);
    const contact = textField(body.contact, 200);
    const business = textField(body.business, 160);
    const comment = textField(body.comment, 1500);
    const productId = textField(body.productId, 100);
    if (name.length < 2 || contact.length < 3 || body.consent !== true) {
      return json(res, 400, { error: "INVALID_INPUT", message: "Укажите имя и контакт и подтвердите согласие на обработку данных." });
    }
    if (/[<>]/.test(name) || /[<>]/.test(contact)) {
      return json(res, 400, { error: "INVALID_INPUT", message: "Проверьте поля формы." });
    }

    const item = await saveRequest(config, { name, contact, business, comment, productId });
    let notification = { sent: false, reason: "MAX_NOT_CONFIGURED" };
    try { notification = await notifyMax(config, item); } catch { notification = { sent: false, reason: "MAX_API_ERROR" }; }
    await updateRequest(config, item.id, {
      notificationStatus: notification.sent ? "sent" : notification.reason,
      notificationAttemptedAt: new Date().toISOString()
    });
    return json(res, 201, { ok: true, id: item.id, message: "Заявка сохранена.", notification: notification.sent ? "sent" : "pending" });
  } catch {
    return json(res, 503, { error: "TEMPORARY_FAILURE", message: "Не удалось сохранить заявку. Попробуйте позже." });
  }
};
