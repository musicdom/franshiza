const API = "https://platform-api2.max.ru";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const token = process.env.MAX_BOT_TOKEN;
  const secret = process.env.MAX_WEBHOOK_SECRET;
  if (!token || !secret) {
    return json(res, 503, { ok: false, error: "Set MAX_BOT_TOKEN and MAX_WEBHOOK_SECRET in Vercel" });
  }

  if (req.headers.authorization !== `Bearer ${secret}`) {
    return json(res, 401, { ok: false, error: "Unauthorized" });
  }

  const configuredHost = process.env.WEBHOOK_BASE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL;
  if (!configuredHost) {
    return json(res, 503, { ok: false, error: "Set WEBHOOK_BASE_URL to the stable HTTPS Vercel domain" });
  }

  let host = configuredHost.trim();
  if (host.startsWith("https://")) host = host.slice(8);
  if (host.startsWith("http://")) host = host.slice(7);
  if (host.endsWith("/")) host = host.slice(0, -1);
  const webhookUrl = `https://${host}/api/webhook`;

  try {
    const response = await fetch(`${API}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: webhookUrl,
        update_types: ["bot_started", "message_created"],
        secret
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      console.error("MAX webhook subscription failed:", response.status);
      return json(res, 502, { ok: false, error: "MAX rejected webhook subscription", status: response.status });
    }
    return json(res, 200, { ok: true, webhook_url: webhookUrl, result });
  } catch (error) {
    console.error("MAX webhook setup failed:", error && error.message ? error.message : "unknown error");
    return json(res, 502, { ok: false, error: "Could not reach MAX API" });
  }
};
