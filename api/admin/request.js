const { getConfig } = require("../../lib/server/config");
const { json, method, requireSameOrigin, requireAdmin } = require("../../lib/server/http");
const { getRequest, updateRequest } = require("../../lib/server/store");

const ALLOWED = new Set(["new", "in_progress", "done", "archived"]);

module.exports = async function handler(req, res) {
  if (!method(req, res, ["PATCH"])) return;
  if (!requireSameOrigin(req)) return json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
  let config;
  try { config = getConfig(); } catch { return json(res, 503, { error: "SERVICE_NOT_CONFIGURED" }); }
  if (!requireAdmin(req, res, config)) return;
  const id = req.body && typeof req.body.id === "string" ? req.body.id : "";
  const status = req.body && typeof req.body.status === "string" ? req.body.status : "";
  if (!/^[a-f0-9-]{36}$/i.test(id) || !ALLOWED.has(status)) return json(res, 400, { error: "INVALID_INPUT" });
  try {
    const current = await getRequest(config, id);
    if (!current) return json(res, 404, { error: "NOT_FOUND" });
    const updated = await updateRequest(config, id, { status, updatedAt: new Date().toISOString() });
    return json(res, 200, { ok: true, request: updated });
  } catch {
    return json(res, 503, { error: "STORAGE_UNAVAILABLE", message: "Не удалось обновить заявку." });
  }
};
