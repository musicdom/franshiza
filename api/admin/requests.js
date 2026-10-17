const { getConfig } = require("../../lib/server/config");
const { json, method, requireAdmin } = require("../../lib/server/http");
const { listRequests } = require("../../lib/server/store");

module.exports = async function handler(req, res) {
  if (!method(req, res, ["GET"])) return;
  let config;
  try { config = getConfig(); } catch { return json(res, 503, { error: "SERVICE_NOT_CONFIGURED", message: "Админ-панель пока не настроена." }); }
  if (!requireAdmin(req, res, config)) return;
  const requested = Number.parseInt(req.query && req.query.limit, 10);
  const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 50;
  try {
    const requests = await listRequests(config, limit, 0);
    return json(res, 200, { ok: true, requests });
  } catch {
    return json(res, 503, { error: "STORAGE_UNAVAILABLE", message: "Не удалось загрузить заявки." });
  }
};
