"use strict";

const path = require("path");
const fs = require("fs");

const IMAGE_DIR = path.join(__dirname, "..", "Image");
const TEMPLATE_PARTS = [
  "winner-template.part01.b64",
  "winner-template.part02.b64",
  "winner-template.part03.b64",
  "winner-template.part04.b64"
];

function loadTemplate() {
  const encoded = TEMPLATE_PARTS.map(name => {
    const file = path.join(IMAGE_DIR, name);
    if (!fs.existsSync(file)) throw new Error("Norka winner template part is missing: " + file);
    return fs.readFileSync(file, "utf8").trim();
  }).join("");
  return Buffer.from(encoded, "base64");
}

const WIDTH = 864;
const HEIGHT = 1154;

// Все координаты и размеры карточки настраиваются здесь.
// left / x: меньше — левее, больше — правее.
// top / y: меньше — выше, больше — ниже.
const LAYOUT = {
  avatar: { size: 232, left: 316, top: 258, centerX: 432, centerY: 374, borderRadius: 119, borderWidth: 7 },
  date: { x: 432, y: 158, fontSize: 27 },
  name: { x: 402, y: 590, fontSize: 39 },
  number: { x: 520, y: 755, fontSize: 50 },
  prize: { x: 432, y: 980, fontSize: 36 }
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[ch]);
}

function shorten(value, max) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function loadAvatar(url, sharp) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const response = await fetch(parsed.href, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > 5 * 1024 * 1024) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 5 * 1024 * 1024) return null;
    const size = LAYOUT.avatar.size;
    const mask = Buffer.from('<svg width="' + size + '" height="' + size + '" xmlns="http://www.w3.org/2000/svg"><circle cx="' + size/2 + '" cy="' + size/2 + '" r="' + (size/2) + '" fill="#fff"/></svg>');
    return await sharp(data).rotate().resize(size, size, {fit:"cover"}).composite([{input:mask,blend:"dest-in"}]).png().toBuffer();
  } catch (error) {
    console.error("NORKA winner avatar could not be loaded:", String(error && error.message || error).slice(0, 300));
    return null;
  }
}

function renderWinner(winner) {
  const textStyle = 'fill="#171717" font-family="Georgia, DejaVu Serif, serif" stroke="#ffffff" stroke-width="3.2" stroke-linejoin="round" paint-order="stroke fill"';
  const name = shorten(winner.name || "Участник Норки", 28);
  const number = String(winner.number == null ? "" : winner.number);
  const prize = shorten(winner.prize || "Главный приз", 48);
  return [
    '<text x="' + LAYOUT.name.x + '" y="' + LAYOUT.name.y + '" text-anchor="middle" ' + textStyle + ' font-size="' + LAYOUT.name.fontSize + '" font-weight="bold">' + esc(name) + '</text>',
    '<text x="' + LAYOUT.number.x + '" y="' + LAYOUT.number.y + '" text-anchor="middle" ' + textStyle + ' font-size="' + LAYOUT.number.fontSize + '" font-weight="bold">' + esc(number) + '</text>',
    '<text x="' + LAYOUT.prize.x + '" y="' + LAYOUT.prize.y + '" text-anchor="middle" ' + textStyle + ' font-size="' + LAYOUT.prize.fontSize + '" font-weight="bold">' + esc(prize) + '</text>'
  ].join("");
}

async function createWinnerCard(item, winners) {
  const sharp = require("sharp");
  if (!Array.isArray(winners) || winners.length === 0) throw new Error("Winner card requires at least one winner");
  const template = loadTemplate();
  const winner = winners.find(w => Number(w.place || 1) === 1) || winners[0];
  const date = new Date(item && item.drawnAt || Date.now()).toLocaleDateString("ru-RU");
  const headingSvg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <text x="${LAYOUT.date.x}" y="${LAYOUT.date.y}" text-anchor="middle" fill="#171717" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill" font-family="Georgia, DejaVu Serif, serif" font-size="${LAYOUT.date.fontSize}" font-weight="bold">${esc(date)}</text>
    ${renderWinner(winner)}
    <circle cx="${LAYOUT.avatar.centerX}" cy="${LAYOUT.avatar.centerY}" r="${LAYOUT.avatar.borderRadius}" fill="none" stroke="#ffffff" stroke-width="${LAYOUT.avatar.borderWidth}"/>
  </svg>`;
  const layers = [];
  const avatar = await loadAvatar(winner.avatar, sharp);
  if (avatar) layers.push({input:avatar,left:LAYOUT.avatar.left,top:LAYOUT.avatar.top});
  layers.push({input:Buffer.from(headingSvg),left:0,top:0});
  return sharp(template).resize(WIDTH, HEIGHT, {fit:"cover"}).composite(layers).png().toBuffer();
}

module.exports = { createWinnerCard };
