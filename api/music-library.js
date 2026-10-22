const crypto = require("crypto");

const KEY = "harmonika:music-library:v1";
const ALLOWED_ORIGINS = [
  "https://musicdom.github.io",
  "https://franshiza.vercel.app"
];

function cors(req, res) {
  const origin = String(req.headers.origin || "");
  if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/franshiza-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function json(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify(data));
}

function clean(value, max = 180) {
  return typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").trim().slice(0, max) : "";
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(command) {
  const config = redisConfig();
  if (!config) throw new Error("На Vercel не настроено хранилище Redis/KV");
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error("Хранилище временно недоступно");
  const data = await response.json();
  if (data.error) throw new Error("Не удалось обратиться к хранилищу");
  return data.result;
}

async function readTracks() {
  const raw = await redis(["GET", KEY]);
  if (!raw) return [];
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(value) ? value : [];
}

async function writeTracks(tracks) {
  await redis(["SET", KEY, JSON.stringify(tracks)]);
}

function checkPassword(req) {
  const expected = String(process.env.MUSIC_ADMIN_PASSWORD || "");
  const supplied = clean(req.body && req.body.password, 300);
  if (!expected) return { ok: false, status: 503, error: "На Vercel не задан MUSIC_ADMIN_PASSWORD. Добавь переменную окружения и сделай redeploy." };
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return valid ? { ok: true } : { ok: false, status: 401, error: "Неверный пароль администратора" };
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizeTrack(body, existing) {
  const title = clean(body.title, 160);
  const artist = clean(body.artist, 160);
  const audioUrl = clean(body.audioUrl, 1200);
  const cover = clean(body.cover, 1200);
  if (!title || !artist || !audioUrl) throw new Error("Заполни название, исполнителя и ссылку на аудио");
  if (!validHttpsUrl(audioUrl)) throw new Error("Ссылка на аудио должна начинаться с https://");
  const audio = new URL(audioUrl);
  const isYandexPublic = /(^|\.)disk\.yandex\.(ru|com|kz|by)$/i.test(audio.hostname) && /^\/d\/[A-Za-z0-9_-]+/.test(audio.pathname);
  const isDirectAudio = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?.*)?$/i.test(audio.pathname + audio.search);
  if (!isYandexPublic && !isDirectAudio) {
    throw new Error("Нужна публичная ссылка Яндекс Диска вида https://disk.yandex.ru/d/КОД или прямая ссылка на аудиофайл");
  }
  if (cover && !validHttpsUrl(cover)) throw new Error("Ссылка на обложку должна начинаться с https://");
  return {
    id: existing && existing.id || clean(body.id, 100) || crypto.randomUUID(),
    title,
    artist,
    audioUrl,
    cover,
    genre: "Моя музыка",
    icon: "♫",
    createdAt: existing && existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function resolveYandex(url) {
  const parsed = new URL(url);
  const publicKey = parsed.searchParams.get("public_key") ||
    ((/^\/d\//.test(parsed.pathname)) ? parsed.pathname.split("/")[2] : "");
  if (!publicKey) throw new Error("Не удалось распознать публичную ссылку Яндекс Диска");
  const endpoint = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" + encodeURIComponent(url);
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.href) {
    throw new Error(response.status === 403 ? "Яндекс Диск запретил скачивание этого файла" : "Яндекс Диск не выдал прямую ссылку. Проверь доступ по публичной ссылке и возможность скачивания");
  }
  return data.href;
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET" && req.query && req.query.resolve) {
      const tracks = await readTracks();
      const track = tracks.find(item => item.id === clean(String(req.query.resolve), 100));
      if (!track) return json(res, 404, { ok: false, error: "Песня не найдена в библиотеке" });
      const parsed = new URL(track.audioUrl);
      const yandex = /(^|\.)disk\.yandex\.(ru|com|kz|by)$/i.test(parsed.hostname) && /^\/d\//.test(parsed.pathname);
      if (yandex) {
        const url = await resolveYandex(track.audioUrl);
        return json(res, 200, { ok: true, url, expiresSoon: true });
      }
      return json(res, 200, { ok: true, url: track.audioUrl });
    }

    if (req.method === "GET") {
      const tracks = await readTracks();
      return json(res, 200, { ok: true, tracks: tracks.map(({ id, title, artist, audioUrl, cover, genre, icon, createdAt, updatedAt }) => ({ id, title, artist, audioUrl, cover, genre, icon, createdAt, updatedAt })) });
    }

    const auth = checkPassword(req);
    if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
    if (req.method === "POST" && clean(req.body && req.body.action, 30) === "auth") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST") {
      const tracks = await readTracks();
      const track = normalizeTrack(req.body || {});
      tracks.unshift(track);
      await writeTracks(tracks);
      return json(res, 201, { ok: true, track });
    }

    if (req.method === "PATCH") {
      const id = clean(req.body && req.body.id, 100);
      const tracks = await readTracks();
      const index = tracks.findIndex(item => item.id === id);
      if (index < 0) return json(res, 404, { ok: false, error: "Песня не найдена" });
      tracks[index] = normalizeTrack(req.body || {}, tracks[index]);
      await writeTracks(tracks);
      return json(res, 200, { ok: true, track: tracks[index] });
    }

    if (req.method === "DELETE") {
      const id = clean(req.body && req.body.id, 100);
      const tracks = await readTracks();
      const next = tracks.filter(item => item.id !== id);
      if (next.length === tracks.length) return json(res, 404, { ok: false, error: "Песня не найдена" });
      await writeTracks(next);
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    const message = clean(error && error.message || "", 280) || "Внутренняя ошибка сервера";
    const status = message.includes("Не настроено хранилище") ? 503 : 400;
    console.error("[MUSIC LIBRARY]", message);
    return json(res, status, { ok: false, error: message });
  }
};
