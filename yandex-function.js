const routes = {
  norka: require("./api/norka"),
  payment: require("./api/norka-payment"),
  "track-user": require("./api/track-user"),
  webhook: require("./api/webhook"),
  "setup-webhook": require("./api/setup-webhook"),
  "yoomoney-notify": require("./api/yoomoney/notify"),
  "cron-norka": require("./api/cron/norka")
};

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers,
    isBase64Encoded: false,
    body: body == null ? "" : String(body)
  };
}

function getRoute(event, query) {
  const explicit = String(query.route || "").trim().toLowerCase();
  if (explicit) return explicit.replace(/^\/+|\/+$/g, "").replace(/\.js$/, "");
  if (Array.isArray(event.messages) && event.messages.length) return "norka";
  const requestPath = String(event.path || event.rawPath || event.url || "").split("?")[0];
  const last = requestPath.split("/").filter(Boolean).pop() || "health";
  const normalized = last.toLowerCase().replace(/\.js$/, "");
  const aliases = {
    "norka-payment": "payment",
    "track_user": "track-user",
    "setup_webhook": "setup-webhook",
    "yoomoney": "yoomoney-notify",
    notify: "yoomoney-notify",
    "cron": "cron-norka"
  };
  return aliases[normalized] || normalized;
}

async function health() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const pair = kvUrl && kvToken ? { url: kvUrl, token: kvToken } :
    upstashUrl && upstashToken ? { url: upstashUrl, token: upstashToken } : null;
  if (!pair) {
    return response(503, JSON.stringify({ ok: false, error: "REDIS_NOT_CONFIGURED" }), {
      "Content-Type": "application/json; charset=utf-8"
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let r;
  try {
    r = await fetch(pair.url.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + pair.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["PING"]),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await r.json();
  if (!r.ok || data.error) {
    return response(502, JSON.stringify({ ok: false, error: "REDIS_UNAVAILABLE" }), {
      "Content-Type": "application/json; charset=utf-8"
    });
  }
  return response(200, JSON.stringify({ ok: true, app: "norka", redis: data.result }), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}

exports.handler = async function (event) {
  const query = event.queryStringParameters || {};
  const route = getRoute(event, query);

  if (route === "health") {
    try {
      return await health();
    } catch (error) {
      console.error("NORKA health check failed:", error && error.message);
      return response(502, JSON.stringify({ ok: false, error: "REDIS_UNAVAILABLE" }), {
        "Content-Type": "application/json; charset=utf-8"
      });
    }
  }

  const handler = routes[route];
  if (!handler) {
    return response(404, JSON.stringify({ ok: false, error: "UNKNOWN_ROUTE", route }), {
      "Content-Type": "application/json; charset=utf-8"
    });
  }

  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    headers[String(key).toLowerCase()] = value;
  }

  const timerMessage = Array.isArray(event.messages) ? event.messages[0] : null;
  let rawBody = event.body;
  if ((rawBody == null || rawBody === "") && timerMessage?.details?.payload) rawBody = timerMessage.details.payload;
  if (event.isBase64Encoded && typeof rawBody === "string") {
    rawBody = Buffer.from(rawBody, "base64").toString("utf8");
  }

  let body = {};
  if (rawBody != null && rawBody !== "") {
    try {
      body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    } catch {
      body = rawBody;
    }
  }

  const req = {
    method: String(event.httpMethod || event.requestContext?.httpMethod || (timerMessage ? "POST" : "GET")).toUpperCase(),
    headers,
    query,
    body
  };

  let statusCode = 200;
  let responseBody = "";
  const responseHeaders = {};
  let ended = false;

  const res = {
    status(code) {
      statusCode = Number(code) || 200;
      return this;
    },
    setHeader(name, value) {
      responseHeaders[name] = value;
      return this;
    },
    end(value = "") {
      responseBody = value == null ? "" : String(value);
      ended = true;
      return this;
    }
  };

  const routeStarted = Date.now();
  try {
    await handler(req, res);
    console.info("NORKA route completed", JSON.stringify({ route, statusCode, durationMs: Date.now() - routeStarted }));
    if (!ended) {
      return response(500, JSON.stringify({ ok: false, error: "HANDLER_DID_NOT_FINISH" }), {
        "Content-Type": "application/json; charset=utf-8"
      });
    }
    return response(statusCode, responseBody, responseHeaders);
  } catch (error) {
    console.error("NORKA API route failed:", JSON.stringify({ route, durationMs: Date.now() - routeStarted, error: error && error.message }));
    return response(500, JSON.stringify({ ok: false, error: "INTERNAL_SERVER_ERROR" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
  }
};
