const { requestMax } = require("../lib/max-api");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/*
 * Incoming bot conversations are intentionally disabled.
 * The «Волна» mini-app sends entry notifications through /api/volna-entry.
 * This webhook only acknowledges authenticated platform updates.
 */
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

  // Deliberately do not run sales-flow or reply to incoming messages/callbacks.
  return json(res, 200, { ok: true, ignored: true });
};
