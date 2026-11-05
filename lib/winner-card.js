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
    const size = 196;
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
    '<text x="402" y="590" text-anchor="middle" ' + textStyle + ' font-size="39" font-weight="bold">' + esc(name) + '</text>',
    '<text x="520" y="755" text-anchor="middle" ' + textStyle + ' font-size="50" font-weight="bold">' + esc(number) + '</text>',
    '<text x="432" y="980" text-anchor="middle" ' + textStyle + ' font-size="36" font-weight="bold">' + esc(prize) + '</text>'
  ].join("");
}

async function createWinnerCard(item, winners) {
  const sharp = require("sharp");
  if (!Array.isArray(winners) || winners.length === 0) throw new Error("Winner card requires at least one winner");
  const template = loadTemplate();
  const winner = winners.find(w => Number(w.place || 1) === 1) || winners[0];
  const date = new Date(item && item.drawnAt || Date.now()).toLocaleDateString("ru-RU");
  const headingSvg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <text x="432" y="158" text-anchor="middle" fill="#171717" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill" font-family="Georgia, DejaVu Serif, serif" font-size="27" font-weight="bold">${esc(date)}</text>
    ${renderWinner(winner)}
    <circle cx="432" cy="388" r="101" fill="none" stroke="#ffffff" stroke-width="7"/>
  </svg>`;
  const layers = [];
  const avatar = await loadAvatar(winner.avatar, sharp);
  if (avatar) layers.push({input:avatar,left:334,top:290});
  layers.push({input:Buffer.from(headingSvg),left:0,top:0});
  return sharp(template).resize(WIDTH, HEIGHT, {fit:"cover"}).composite(layers).png().toBuffer();
}

module.exports = { createWinnerCard };
