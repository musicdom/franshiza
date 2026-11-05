"use strict";

const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const TEMPLATE = path.join(__dirname, "..", "Image", "winner-template.png..png");
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
  const top = 310;
  const bottom = 1035;
  const rowGap = 12;
  const rowHeight = Math.min(72, Math.floor((bottom - top - (perColumn - 1) * rowGap) / Math.max(1, perColumn)));
  const colWidth = columns === 1 ? 744 : 360;
  return winners.map((winner, index) => {
    const col = columns === 1 ? 0 : Math.floor(index / perColumn);
    const row = columns === 1 ? index : index % perColumn;
    const x = columns === 1 ? 60 : (col === 0 ? 48 : 456);
    const y = top + row * (rowHeight + rowGap);
    const center = y + rowHeight / 2;
    const number = String(winner.number).padStart(2, "0");
    const name = shorten(winner.name || "Участник Норки", columns === 1 ? 26 : 15);
    const prize = shorten(winner.prize || "Приз розыгрыша", columns === 1 ? 46 : 22);
    const numberSize = rowHeight < 52 ? 22 : 26;
    const nameSize = rowHeight < 52 ? 18 : 21;
    const prizeSize = rowHeight < 52 ? 15 : 17;
    return [
      '<rect x="' + x + '" y="' + y + '" width="' + colWidth + '" height="' + rowHeight + '" rx="17" fill="#24152c" fill-opacity=".84" stroke="#f2b7df" stroke-opacity=".62" stroke-width="2"/>',
      '<text x="' + (x + 22) + '" y="' + (center + 8) + '" fill="#ffd9ef" font-family="Arial, DejaVu Sans, sans-serif" font-size="' + numberSize + '" font-weight="700">№ ' + esc(number) + '</text>',
      '<text x="' + (x + 138) + '" y="' + (center - 2) + '" fill="#ffffff" font-family="Arial, DejaVu Sans, sans-serif" font-size="' + nameSize + '" font-weight="700">' + esc(name) + '</text>',
      '<text x="' + (x + 138) + '" y="' + (center + 21) + '" fill="#ffd3e9" font-family="Arial, DejaVu Sans, sans-serif" font-size="' + prizeSize + '">' + esc(prize) + '</text>'
    ].join("");
  }).join("");
}
async function createWinnerCard(item, winners) {
  if (!Array.isArray(winners) || winners.length === 0) throw new Error("Winner card requires at least one winner");
  if (!fs.existsSync(TEMPLATE)) throw new Error("Norka winner template is missing: " + TEMPLATE);
  const title = shorten(item && item.title || "Розыгрыш Норки", 42);
  const date = new Date(item && item.drawnAt || Date.now()).toLocaleDateString("ru-RU");
  const heading = winners.length === 1 ? "ПОБЕДИТЕЛЬ РОЗЫГРЫША" : "ПОБЕДИТЕЛИ РОЗЫГРЫША";
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#190d25" stop-opacity=".88"/>
      <stop offset="1" stop-color="#35132d" stop-opacity=".94"/>
    </linearGradient></defs>
    <rect x="28" y="42" width="808" height="1068" rx="34" fill="url(#panel)" stroke="#f4b9df" stroke-width="3" stroke-opacity=".9"/>
    <text x="432" y="112" text-anchor="middle" fill="#fff4fb" font-family="Arial, DejaVu Sans, sans-serif" font-size="42" font-weight="800">${heading}</text>
    <text x="432" y="158" text-anchor="middle" fill="#ffd4e9" font-family="Arial, DejaVu Sans, sans-serif" font-size="22">${esc(title)}</text>
    <text x="432" y="198" text-anchor="middle" fill="#e9c4dd" font-family="Arial, DejaVu Sans, sans-serif" font-size="18">${esc(date)} · Норка</text>
    ${renderRows(winners)}
    <text x="432" y="1080" text-anchor="middle" fill="#ffe5f4" font-family="Arial, DejaVu Sans, sans-serif" font-size="20" font-weight="700">Поздравляем с победой!</text>
  </svg>`;
  return sharp(TEMPLATE).resize(WIDTH, HEIGHT, {fit:"cover"}).composite([{input:Buffer.from(svg),left:0,top:0}]).png().toBuffer();
}
module.exports = { createWinnerCard };
