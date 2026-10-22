const KEY = "harmonika:music-library:v1";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(command) {
  const config = redisConfig();
  if (!config) throw new Error("На сервере не настроено хранилище музыкальной библиотеки");
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error("Хранилище музыкальной библиотеки временно недоступно");
  const data = await response.json();
  if (data.error) throw new Error("Не удалось прочитать музыкальную библиотеку");
  return data.result;
}

async function findTrack(id) {
  const raw = await redis(["GET", KEY]);
  if (!raw) return null;
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? value.find(track => track.id === id) || null : null;
}

function googleDriveId(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)drive\.google\.com$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
    const id = url.searchParams.get("id");
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
  } catch { return ""; }
}

async function yandexDownloadUrl(value) {
  const parsed = new URL(value);
  const publicKey = parsed.searchParams.get("public_key") ||
    (/^\/d\//.test(parsed.pathname) ? parsed.pathname.split("/")[2] : "");
  if (!publicKey) throw new Error("Ссылка Яндекс Диска не распознана");
  const endpoint = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" + encodeURIComponent(value);
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.href) {
    throw new Error(response.status === 403
      ? "Яндекс Диск запретил скачивание. Проверь доступ по публичной ссылке."
      : "Яндекс Диск не выдал аудиофайл. Проверь, что ссылка публичная и скачивание разрешено.");
  }
  return data.href;
}

function googleConfirmUrl(html, baseUrl) {
  const patterns = [
    /href="([^"]*(?:export=download|\/uc\?)[^"]*confirm=[^"]*)"/i,
    /action="([^"]*(?:\/uc|\/download)[^"]*)"/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const raw = match[1].replace(/&amp;/g, "&").replace(/&#38;/g, "&");
      try { return new URL(raw, baseUrl).toString(); } catch {}
    }
  }
  const token = html.match(/[?&]confirm=([0-9A-Za-z_-]+)/);
  if (token) {
    const u = new URL(baseUrl);
    u.searchParams.set("confirm", token[1]);
    return u.toString();
  }
  return "";
}

async function fetchGoogleDrive(id, range) {
  const initialUrl = "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(id) + "&confirm=t";
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; HarmonikaAudio/1.0)", Accept: "*/*" };
  if (range) headers.Range = range;
  let response = await fetch(initialUrl, { headers, redirect: "follow" });
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/html")) {
    const html = await response.text();
    const confirmed = googleConfirmUrl(html, response.url || initialUrl);
    if (confirmed) {
      const cookie = response.headers.get("set-cookie");
      const retryHeaders = { ...headers };
      if (cookie) retryHeaders.Cookie = cookie.split(";")[0];
      response = await fetch(confirmed, { headers: retryHeaders, redirect: "follow" });
    } else {
      throw new Error("Google Диск вернул страницу вместо MP3. Включи доступ «Все, у кого есть ссылка» и проверь, что файл — аудио.");
    }
  }
  return response;
}

function copyHeader(upstream, res, from, to = from) {
  const value = upstream.headers.get(from);
  if (value) res.setHeader(to, value);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Accept-Ranges", "bytes");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const id = String((req.query && req.query.id) || "").trim().slice(0, 100);
    if (!id) return json(res, 400, { ok: false, error: "Не указан ID песни" });
    const track = await findTrack(id);
    if (!track) return json(res, 404, { ok: false, error: "Песня не найдена в библиотеке" });

    const parsed = new URL(track.audioUrl);
    let upstream;
    const yandex = /(^|\.)disk\.yandex\.(ru|com|kz|by)$/i.test(parsed.hostname) && /^\/d\//.test(parsed.pathname);
    const google = /(^|\.)drive\.google\.com$/i.test(parsed.hostname);
    const directAudio = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(parsed.pathname);
    const range = req.headers.range;

    if (yandex) {
      const url = await yandexDownloadUrl(track.audioUrl);
      const headers = { "User-Agent": "Mozilla/5.0", Accept: "*/*" };
      if (range) headers.Range = range;
      upstream = await fetch(url, { headers, redirect: "follow" });
    } else if (google) {
      const fileId = googleDriveId(track.audioUrl);
      if (!fileId) return json(res, 400, { ok: false, error: "Не удалось распознать ID файла Google Диска" });
      upstream = await fetchGoogleDrive(fileId, range);
    } else if (directAudio) {
      const headers = { Accept: "*/*" };
      if (range) headers.Range = range;
      upstream = await fetch(track.audioUrl, { headers, redirect: "follow" });
    } else {
      return json(res, 400, { ok: false, error: "Формат ссылки не поддерживается. Нужна публичная ссылка Яндекс Диска, Google Диска или прямая ссылка на MP3." });
    }

    if (!upstream.ok && upstream.status !== 206) {
      const status = upstream.status;
      await upstream.body?.cancel().catch(() => {});
      return json(res, status >= 400 && status < 600 ? status : 502, {
        ok: false,
        error: "Источник не отдал аудиофайл (HTTP " + status + "). Проверь публичный доступ и возможность скачивания."
      });
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      await upstream.body?.cancel().catch(() => {});
      return json(res, 502, { ok: false, error: "Вместо аудио источник вернул HTML-страницу. Проверь доступ к файлу." });
    }

    res.statusCode = upstream.status;
    copyHeader(upstream, res, "content-type", "Content-Type");
    copyHeader(upstream, res, "content-length", "Content-Length");
    copyHeader(upstream, res, "content-range", "Content-Range");
    copyHeader(upstream, res, "accept-ranges", "Accept-Ranges");
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "audio/mpeg");
    if (req.method === "HEAD") {
      await upstream.body?.cancel().catch(() => {});
      return res.end();
    }
    if (!upstream.body) return res.end();
    const { Readable } = require("stream");
    return Readable.fromWeb(upstream.body).on("error", error => {
      console.error("[MUSIC STREAM] upstream stream error:", error.message);
      if (!res.headersSent) res.statusCode = 502;
      res.end();
    }).pipe(res);
  } catch (error) {
    const message = String(error && error.message || "Не удалось загрузить аудио").slice(0, 260);
    console.error("[MUSIC STREAM]", message);
    if (!res.headersSent) return json(res, 502, { ok: false, error: message });
    return res.end();
  }
};
