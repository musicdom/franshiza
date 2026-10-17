const crypto = require("node:crypto");

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(payload));
}

function method(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader("Allow", allowed.join(", "));
  json(res, 405, { error: "METHOD_NOT_ALLOWED" });
  return false;
}

function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const item = part.trim();
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator) === name) {
      return decodeURIComponent(item.slice(separator + 1));
    }
  }
  return "";
}

function signSession(exp, secret) {
  const payload = Buffer.from(JSON.stringify({ exp, role: "admin" })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + signature;
}

function verifySession(token, secret) {
  if (!token || token.length > 2048) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest("base64url");
  if (!safeEqual(parts[1], expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.role === "admin" && Number.isFinite(payload.exp) && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(res, value, maxAge) {
  res.setHeader("Set-Cookie", "franshiza_admin=" + encodeURIComponent(value) + "; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "franshiza_admin=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
}

function requireAdmin(req, res, config) {
  if (!verifySession(readCookie(req, "franshiza_admin"), config.sessionSecret)) {
    json(res, 401, { error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

function clientIp(req) {
  // Vercel sets x-forwarded-for; use only the first forwarded address.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length < 500) return forwarded.split(",")[0].trim().slice(0, 64);
  return "unknown";
}

module.exports = {
  json, method, safeEqual, requireSameOrigin, signSession, verifySession, setSessionCookie,
  clearSessionCookie, requireAdmin, clientIp
};
