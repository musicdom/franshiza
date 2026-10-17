const { getConfig } = require("../_lib/config");
const { json, method, requireSameOrigin, safeEqual, signSession, setSessionCookie, clientIp } = require("../_lib/http");
const { rateLimit } = require("../_lib/store");
const crypto = require("node:crypto");

module.exports = async function handler(req, res) {
  if (!method(req, res, ["POST"])) return;
  if (!requireSameOrigin(req)) return json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
  let config;
  try { config = getConfig(); } catch { return json(res, 503, { error: "SERVICE_NOT_CONFIGURED", message: "Админ-панель пока не настроена." }); }
  try {
    const ipKey = crypto.createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 32);
    if (!(await rateLimit(config, "login:" + ipKey, 8, 900))) {
      res.setHeader("Retry-After", "900");
      return json(res, 429, { error: "RATE_LIMITED", message: "Слишком много попыток входа. Попробуйте позже." });
    }
    const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
    if (!safeEqual(password, config.adminPassword)) return json(res, 401, { error: "INVALID_CREDENTIALS", message: "Неверный пароль." });
    const maxAge = 8 * 60 * 60;
    setSessionCookie(res, signSession(Date.now() + maxAge * 1000, config.sessionSecret), maxAge);
    return json(res, 200, { ok: true });
  } catch {
    return json(res, 503, { error: "TEMPORARY_FAILURE", message: "Не удалось выполнить вход. Попробуйте позже." });
  }
};
