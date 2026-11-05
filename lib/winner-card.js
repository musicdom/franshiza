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
  const columns = count > 10 ? 2 : 1;
  const perColumn = Math.ceil(count / columns);
  const topLimit = 285;
  const bottomLimit = 1045;
  const rowGap = 12;
  const rowHeight = Math.min(72, Math.floor((bottomLimit - topLimit - (perColumn - 1) * rowGap) / Math.max(1, perColumn)));
  const totalRowsHeight = perColumn * rowHeight + (perColumn - 1) * rowGap;
  const top = topLimit + Math.floor((bottomLimit - topLimit - totalRowsHeight) / 2);
  const colWidth = columns === 1 ? 744 : 360;
  return winners.map((winner, index) => {
    const col = columns === 1 ? 0 : Math.floor(index / perColumn);
    const row = columns === 1 ? index : index % perColumn;
    const x = columns === 1 ? 60 : (col === 0 ? 48 : 456);
    const y = top + row * (rowHeight + rowGap);
    const number = String(winner.number).padStart(2, "0");
    const name = shorten(winner.name || "Участник Норки", columns === 1 ? 26 : 15);
    const prize = shorten(winner.prize || "Приз розыгрыша", columns === 1 ? 46 : 22);
    const font = rowHeight < 52 ? 17 : 20;
    const lineGap = rowHeight < 52 ? 18 : 21;
    const center = y + rowHeight / 2;
    const labelStyle = 'fill="#000000" font-family="Arial, DejaVu Sans, sans-serif" font-size="' + font + '" font-weight="700" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"';
    const valueStyle = 'fill="#000000" font-family="Arial, DejaVu Sans, sans-serif" font-size="' + font + '" font-weight="400" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"';
    const left = x + 12;
    return [
      '<text x="' + left + '" y="' + (center - lineGap) + '" ' + labelStyle + '>Имя победителя: <tspan font-weight="400">' + esc(name) + '</tspan></text>',
      '<text x="' + left + '" y="' + center + '" ' + labelStyle + '>Номер выигрыша: <tspan font-weight="400">№ ' + esc(number) + '</tspan></text>',
      '<text x="' + left + '" y="' + (center + lineGap) + '" ' + labelStyle + '>Приз: <tspan font-weight="400">' + esc(prize) + '</tspan></text>'
    ].join("");
  }).join("");
}
async function createWinnerCard(item, winners) {
  const sharp = require("sharp");
  if (!Array.isArray(winners) || winners.length === 0) throw new Error("Winner card requires at least one winner");
  const template = loadTemplate();
  const title = shorten(item && item.title || "Розыгрыш Норки", 42);
  const date = new Date(item && item.drawnAt || Date.now()).toLocaleDateString("ru-RU");
  const heading = winners.length === 1 ? "ПОБЕДИТЕЛЬ РОЗЫГРЫША" : "ПОБЕДИТЕЛИ РОЗЫГРЫША";
  const headingSvg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <text x="432" y="112" text-anchor="middle" fill="#000000" stroke="#ffffff" stroke-width="4" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial, DejaVu Sans, sans-serif" font-size="38" font-weight="800">${heading}</text>
    <text x="432" y="158" text-anchor="middle" fill="#000000" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial, DejaVu Sans, sans-serif" font-size="22" font-weight="700">${esc(title)}</text>
    <text x="432" y="198" text-anchor="middle" fill="#000000" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial, DejaVu Sans, sans-serif" font-size="18">${esc(date)} · Норка</text>
    ${renderRows(winners)}
  </svg>`;
  return sharp(template).resize(WIDTH, HEIGHT, {fit:"cover"}).composite([{input:Buffer.from(headingSvg),left:0,top:0}]).png().toBuffer();
}
module.exports = { createWinnerCard };
