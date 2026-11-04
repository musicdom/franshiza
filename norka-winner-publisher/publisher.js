"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const tls = require("node:tls");
const path = require("node:path");
const { renderWinnerCard } = require("./winner-card");

const MAX_API_HOST = "platform-api2.max.ru";
const OPEN_NORKA_URL = "https://max.ru/se14711525_bot";
const PUBLISH_GAP_MS = 600;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function certificateBundle() {
  const certDir = path.join(process.cwd(), "certs");
  const files = [
    path.join(certDir, "russian_trusted_root_ca.pem"),
    path.join(certDir, "russian_trusted_root_ca_gost_2025.pem")
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error("MAX_RUSSIAN_CA_CERTIFICATE_MISSING: " + path.basename(file));
  }
  return [...files.map(file => fs.readFileSync(file)), ...tls.rootCertificates];
}

function request({ url, method = "GET", headers = {}, body = null, ca = certificateBundle(), timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") return reject(new Error("HTTPS_REQUIRED"));
    const bodyBuffer = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const req = https.request(target, {
      method,
      headers: { Accept: "application/json", ...(bodyBuffer ? { "Content-Length": bodyBuffer.length } : {}), ...headers },
      ca, rejectUnauthorized: true, timeout
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(new Error("MAX_RESPONSE_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, data, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("MAX_REQUEST_TIMEOUT")));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function maxJson(token, apiPath, body) {
  const response = await request({
    url: "https://" + MAX_API_HOST + apiPath,
    method: body == null ? "GET" : "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: body == null ? null : JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = response.data?.message || response.data?.description || response.raw.slice(0, 500);
    throw new Error("MAX_API_" + response.status + ": " + detail);
  }
  return response.data;
}

function multipartImage(buffer, filename = "norka-winners.png") {
  const boundary = "----NorkaWinner" + crypto.randomBytes(12).toString("hex");
  const head = Buffer.from("--" + boundary + "\r\n" +
    'Content-Disposition: form-data; name="data"; filename="' + filename + '"\r\n' +
    "Content-Type: image/png\r\n\r\n");
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
  return { boundary, body: Buffer.concat([head, buffer, tail]) };
}

async function uploadImage(token, imageBuffer) {
  const slot = await maxJson(token, "/uploads?type=image");
  if (!slot?.url) throw new Error("MAX_UPLOAD_URL_MISSING");
  const multipart = multipartImage(imageBuffer);
  const uploaded = await request({
    url: slot.url, method: "POST", ca: certificateBundle(),
    headers: { "Content-Type": "multipart/form-data; boundary=" + multipart.boundary, "Content-Length": multipart.body.length },
    body: multipart.body, timeout: 30000
  });
  if (!uploaded.ok) throw new Error("MAX_IMAGE_UPLOAD_" + uploaded.status + ": " + uploaded.raw.slice(0, 400));
  let tokenValue = slot.token || uploaded.data?.token || uploaded.data?.retval;
  if (!tokenValue) {
    try {
      const params = new URL(slot.url).searchParams;
      tokenValue = params.get("token") || params.get("photoToken") || params.get("photo_token");
    } catch {}
  }
  if (!tokenValue) throw new Error("MAX_IMAGE_TOKEN_MISSING");
  return String(tokenValue);
}

async function sendWinnerCard({ token, channelId, item, imageBuffer }) {
  const imageToken = await uploadImage(token, imageBuffer);
  await sleep(1500);
  const title = String(item.title || "Розыгрыш").trim().slice(0, 100);
  return maxJson(token, "/messages?chat_id=" + encodeURIComponent(channelId), {
    text: "🏆 Итоги розыгрыша «" + title + "»! Поздравляем всех победителей! 🌿",
    attachments: [
      { type: "image", payload: { token: imageToken } },
      { type: "inline_keyboard", payload: { buttons: [[{
        type: "open_app", text: "🌿 Открыть Норку", web_app: OPEN_NORKA_URL
      }]] } }
    ]
  });
}

async function readProfile(redisCommand, userId) {
  const raw = await redisCommand(["GET", "norka:user:" + String(userId)]);
  if (!raw) return { name: "Участник Норки", avatar: "" };
  try {
    const user = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { name: String(user?.name || "Участник Норки").slice(0, 100), avatar: String(user?.avatar || "").slice(0, 500) };
  } catch {
    return { name: "Участник Норки", avatar: "" };
  }
}

async function reserveChannelSlot(redisCommand) {
  const script = "local now=tonumber(ARGV[1]); local nextAt=tonumber(redis.call('GET',KEYS[1]) or '0'); local scheduled=math.max(now,nextAt); redis.call('SET',KEYS[1],scheduled+tonumber(ARGV[2]),'PX',60000); return scheduled-now";
  const wait = Number(await redisCommand(["EVAL", script, "1", "norka:channel:publish:next_ms", String(Date.now()), String(PUBLISH_GAP_MS)])) || 0;
  if (wait > 0) await sleep(wait);
}

async function publishNumberedGiveawayWinners({ item, redisCommand, token = process.env.MAX_BOT_TOKEN, templatePath }) {
  if (!item || item.type !== "numbers" || item.status !== "completed" || !Array.isArray(item.winners)) {
    return { published: false, skipped: true, reason: "NOT_A_COMPLETED_NUMBERED_GIVEAWAY" };
  }
  if (!item.winners.length || item.winners.length > 25) throw new Error("WINNERS_COUNT_MUST_BE_1_TO_25");
  if (typeof redisCommand !== "function") throw new Error("REDIS_COMMAND_REQUIRED");
  if (!token) throw new Error("MAX_BOT_TOKEN_MISSING");

  const giveawayId = String(item.id);
  const publishedKey = "norka:winner-post:published:" + giveawayId;
  const lockKey = "norka:winner-post:lock:" + giveawayId;
  const existing = await redisCommand(["GET", publishedKey]);
  if (existing) return { published: true, duplicate: true, message: existing };

  const lockToken = crypto.randomUUID();
  const lock = await redisCommand(["SET", lockKey, lockToken, "NX", "EX", "300"]);
  if (lock !== "OK") {
    const afterLock = await redisCommand(["GET", publishedKey]);
    return afterLock ? { published: true, duplicate: true, message: afterLock } : { published: false, busy: true };
  }

  try {
    const channelId = await redisCommand(["GET", "norka:channel:chat_id"]);
    if (!channelId) throw new Error("NORKA_CHANNEL_CHAT_ID_MISSING");
    const winners = await Promise.all(item.winners.map(async winner => ({
      ...winner, ...(await readProfile(redisCommand, winner.userId))
    })));
    const imageBuffer = await renderWinnerCard({ item, winners, templatePath });
    await reserveChannelSlot(redisCommand);
    const sent = await sendWinnerCard({ token, channelId: String(channelId), item, imageBuffer });
    const result = JSON.stringify({
      messageId: sent?.message?.body?.mid || sent?.mid || sent?.message_id || null,
      sentAt: new Date().toISOString(), winnerCount: winners.length
    });
    await redisCommand(["SET", publishedKey, result]);
    return { published: true, result: JSON.parse(result) };
  } catch (error) {
    console.error("NORKA_WINNER_PUBLICATION_FAILED", JSON.stringify({
      giveawayId, error: error && error.message ? error.message : String(error)
    }));
    throw error;
  } finally {
    const release = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0";
    await redisCommand(["EVAL", release, "1", lockKey, lockToken]).catch(() => {});
  }
}

module.exports = { publishNumberedGiveawayWinners };
