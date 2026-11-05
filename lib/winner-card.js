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

function renderRows(winners) {
  const count = winners.length;
  const textStyle = 'fill="#000000" font-family="Arial, DejaVu Sans, sans-serif" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke fill"';
  
  if (count === 1) {
    const winner = winners[0];
    const name = shorten(winner.name || "Участник Норки", 30);
    const number = String(winner.number).padStart(2, "0");
    const prize = shorten(winner.prize || "Приз розыгрыша", 48);
    return [
      '<text x="432" y="575" text-anchor="middle" ' + textStyle + ' font-size="32" font-weight="800">' + esc(name) + '</text>',
      '<text x="570" y="640" text-anchor="middle" ' + textStyle + ' font-size="46" font-weight="800">' + esc(number) + '</text>',
      '<text x="432" y="945" text-anchor="middle" ' + textStyle + ' font-size="30" font-weight="700">Приз: ' + esc(prize) + '</text>'
    ].join("");
  }

  const columns = count > 8 ? 2 : 1;
  const perColumn = Math.ceil(count / columns);
  const top = 420;
  const bottom = 1060;
  const rowGap = 12;
  const rowHeight = Math.min(100, Math.floor((bottom - top - (perColumn - 1) * rowGap) / perColumn));
  const colWidth = columns === 1 ? 780 : 380;

  return winners.map((winner, index) => {
    const col = columns === 1 ? 0 : Math.floor(index / perColumn);
    const row = columns === 1 ? index : index % perColumn;
    const x = columns === 1 ? 432 : (col === 0 ? 240 : 624);
    const y = top + row * (rowHeight + rowGap);
    const name = shorten(winner.name || "Участник Норки", columns === 1 ? 28 : 15);
    const number = String(winner.number).padStart(2, "0");
    const prize = shorten(winner.prize || "Приз розыгрыша", columns === 1 ? 44 : 20);
    const fs = rowHeight < 72 ? 21 : 25;
    return [
      '<text x="' + x + '" y="' + (y + 25) + '" text-anchor="middle" ' + textStyle + ' font-size="' + (fs + 3) + '" font-weight="800">' + esc(name) + '</text>',
      '<text x="' + (x + 90) + '" y="' + (y + 60) + '" text-anchor="middle" ' + textStyle + ' font-size="' + (fs + 12) + '" font-weight="800">' + esc(number) + '</text>',
      '<text x="' + x + '" y="' + (y + 94) + '" text-anchor="middle" ' + textStyle + ' font-size="' + fs + '" font-weight="700">Приз: ' + esc(prize) + '</text>'
    ].join("");
  }).join("");
}

async function createWinnerCard(item, winners) {
  const sharp = require("sharp");
  if (!Array.isArray(winners) || winners.length === 0) throw new Error("Winner card requires at least one winner");
  const template = loadTemplate();
  const title = shorten(item && item.title || "Розыгрыш Норки", 42);
  const date = new Date(item && item.drawnAt || Date.now()).toLocaleDateString("ru-RU");
  const headingSvg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <text x="432" y="158" text-anchor="middle" fill="#000000" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial, DejaVu Sans, sans-serif" font-size="22" font-weight="700">${esc(title)}</text>
    <text x="432" y="198" text-anchor="middle" fill="#000000" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial, DejaVu Sans, sans-serif" font-size="22" font-weight="700">${esc(date)} · Норка</text>
    ${renderRows(winners)}
  </svg>`;
  return sharp(template).resize(WIDTH, HEIGHT, {fit:"cover"}).composite([{input:Buffer.from(headingSvg),left:0,top:0}]).png().toBuffer();
}

module.exports = { createWinnerCard };
