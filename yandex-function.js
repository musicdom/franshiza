const routes = {
  norka: require("./api/norka"),
  payment: require("./api/norka-payment"),
  "track-user": require("./api/track-user")
};

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers,
    isBase64Encoded: false,
    body: body == null ? "" : String(body)
  };
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

  const r = await fetch(pair.url.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(["PING"])
  });
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
  const route = String(query.route || "health").toLowerCase();

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
    return response(404, JSON.stringify({ ok: false, error: "UNKNOWN_ROUTE" }), {
      "Content-Type": "application/json; charset=utf-8"
    });
  }

  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    headers[String(key).toLowerCase()] = value;
  }

  let body = {};
  if (event.body) {
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch {
      return response(400, JSON.stringify({ ok: false, error: "INVALID_JSON" }), {
        "Content-Type": "application/json; charset=utf-8"
      });
    }
  }

  const req = {
    method: String(event.httpMethod || "GET").toUpperCase(),
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

  try {
    await handler(req, res);
    if (!ended) {
      return response(500, JSON.stringify({ ok: false, error: "HANDLER_DID_NOT_FINISH" }), {
        "Content-Type": "application/json; charset=utf-8"
      });
    }
    return response(statusCode, responseBody, responseHeaders);
  } catch (error) {
    console.error("NORKA API route failed:", route, error && error.message);
    return response(500, JSON.stringify({ ok: false, error: "INTERNAL_SERVER_ERROR" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
  }
};
