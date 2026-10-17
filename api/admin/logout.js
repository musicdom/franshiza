const { getConfig } = require("../../lib/server/config");
const { json, method, requireSameOrigin, clearSessionCookie, requireAdmin } = require("../../lib/server/http");

module.exports = async function handler(req, res) {
  if (!method(req, res, ["POST"])) return;
  if (!requireSameOrigin(req)) return json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
  let config;
  try { config = getConfig(); } catch { return json(res, 503, { error: "SERVICE_NOT_CONFIGURED" }); }
  if (!requireAdmin(req, res, config)) return;
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
};
