"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const WIDTH = 928;
const HEIGHT = 1152;
const MAX_WINNERS = 25;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function initials(name) {
  const parts = String(name || "Н").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function normalizeWinners(winners) {
  if (!Array.isArray(winners) || winners.length < 1 || winners.length > MAX_WINNERS) {
    throw new Error("WINNERS_COUNT_MUST_BE_1_TO_25");
  }
  return winners.map((winner, index) => ({
    place: Number(winner.place) || index + 1,
    number: Number(winner.number),
    name: String(winner.name || "Участник Норки").trim().slice(0, 100),
    avatar: String(winner.avatar || "").trim(),
    prize: String(winner.prize?.title || winner.prizeTitle || "Приз").trim().slice(0, 120)
  }));
}

async function fetchAvatar(url) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(parsed.href, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" }
    });
    if (!response.ok || !String(response.headers.get("content-type") || "").toLowerCase().startsWith("image/")) return null;
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_AVATAR_BYTES) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_AVATAR_BYTES) return null;
    const meta = await sharp(data, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height || meta.width > 4096 || meta.height > 4096) return null;
    const size = 30;
    const circle = Buffer.from('<svg width="30" height="30" xmlns="http://www.w3.org/2000/svg"><circle cx="15" cy="15" r="15" fill="#321d43"/></svg>');
    return await sharp(data).rotate().resize(size, size, { fit: "cover", position: "centre" })
      .composite([{ input: circle, blend: "dest-in" }]).png().toBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeOverlay(item, winners, avatarBuffers) {
  const panelX = 38, panelY = 164, panelW = 660, panelH = 936;
  const rowTop = 344, rowBottom = 1060, rowArea = rowBottom - rowTop;
  const rowHeight = Math.min(42, rowArea / winners.length);
  const avatarSize = Math.max(19, Math.min(28, Math.floor(rowHeight - 4)));
  const nameSize = winners.length > 18 ? 13 : winners.length > 12 ? 14 : 16;
  const metaSize = winners.length > 18 ? 12 : 14;
  const parts = [];

  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '">');
  parts.push('<defs><linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#21162f" stop-opacity=".97"/><stop offset="1" stop-color="#401d3d" stop-opacity=".96"/></linearGradient><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter></defs>');
  parts.push('<rect x="26" y="26" width="876" height="104" rx="24" fill="#21162f" fill-opacity=".94" stroke="#e9c68e" stroke-width="3"/>');
  parts.push('<text x="464" y="91" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="42" font-weight="700" fill="#fff7ed" letter-spacing="1">ПОБЕДИТЕЛИ РОЗЫГРЫША</text>');
  parts.push('<rect x="' + panelX + '" y="' + panelY + '" width="' + panelW + '" height="' + panelH + '" rx="30" fill="#000" opacity=".35" filter="url(#shadow)"/>');
  parts.push('<rect x="' + panelX + '" y="' + panelY + '" width="' + panelW + '" height="' + panelH + '" rx="30" fill="url(#panel)" stroke="#e8c18a" stroke-width="3"/>');
  parts.push('<text x="' + (panelX + 28) + '" y="218" font-family="DejaVu Sans, Arial, sans-serif" font-size="25" font-weight="700" fill="#ffe6bd">' + escapeXml(String(item.title || "Розыгрыш").slice(0, 48)) + '</text>');
  parts.push('<text x="' + (panelX + 28) + '" y="253" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" fill="#e7d4e8">Итоги розыгрыша • ' + winners.length + ' ' + (winners.length === 1 ? "победитель" : winners.length < 5 ? "победителя" : "победителей") + '</text>');
  parts.push('<path d="M58 278 H678" stroke="#d9ad79" stroke-opacity=".7" stroke-width="2"/>');
  parts.push('<text x="120" y="318" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" font-weight="700" fill="#d9c1dc">ПОБЕДИТЕЛЬ</text>');
  parts.push('<text x="386" y="318" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" font-weight="700" fill="#d9c1dc">БИЛЕТ</text>');
  parts.push('<text x="482" y="318" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" font-weight="700" fill="#d9c1dc">ПРИЗ</text>');

  const usedHeight = winners.length * rowHeight;
  const firstY = rowTop + Math.max(0, (rowArea - usedHeight) / 2);
  winners.forEach((winner, index) => {
    const y = firstY + index * rowHeight;
    const avatarY = y + (rowHeight - avatarSize) / 2;
    const centerY = y + rowHeight / 2 + Math.max(4, nameSize * .34);
    if (index % 2 === 0) parts.push('<rect x="54" y="' + (y + 1) + '" width="628" height="' + Math.max(1, rowHeight - 2) + '" rx="8" fill="#fff" fill-opacity=".055"/>');
    parts.push('<circle cx="91" cy="' + (avatarY + avatarSize / 2) + '" r="' + (avatarSize / 2 + 1) + '" fill="#e7c28d"/>');
    if (!avatarBuffers[index]) {
      parts.push('<circle cx="91" cy="' + (avatarY + avatarSize / 2) + '" r="' + (avatarSize / 2) + '" fill="#6c4a82"/>');
      parts.push('<text x="91" y="' + (avatarY + avatarSize * .68) + '" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + Math.max(10, avatarSize * .42) + '" font-weight="700" fill="#fff">' + escapeXml(initials(winner.name)) + '</text>');
    }
    parts.push('<text x="120" y="' + centerY + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + nameSize + '" font-weight="600" fill="#fff" textLength="246" lengthAdjust="spacingAndGlyphs">' + escapeXml(winner.name) + '</text>');
    parts.push('<text x="386" y="' + centerY + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + metaSize + '" fill="#ffe2b7">№ ' + escapeXml(String(winner.number).padStart(2, "0")) + '</text>');
    parts.push('<text x="482" y="' + centerY + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + metaSize + '" font-weight="600" fill="#fff4e8" textLength="188" lengthAdjust="spacingAndGlyphs">' + escapeXml(winner.prize) + '</text>');
    if (index < winners.length - 1) parts.push('<path d="M120 ' + (y + rowHeight) + ' H680" stroke="#d9ad79" stroke-opacity=".2" stroke-width="1"/>');
  });
  parts.push('<text x="464" y="1130" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" font-weight="700" fill="#fff7ed" stroke="#25172f" stroke-width="1" paint-order="stroke">Поздравляем победителей!</text>');
  parts.push('</svg>');
  return Buffer.from(parts.join(""));
}

async function renderWinnerCard({ item, winners, templatePath }) {
  const normalized = normalizeWinners(winners);
  const resolvedTemplate = templatePath || path.join(__dirname, "winner-template.png..png");
  if (!fs.existsSync(resolvedTemplate)) throw new Error("WINNER_TEMPLATE_NOT_FOUND");
  const avatarBuffers = await Promise.all(normalized.map(w => fetchAvatar(w.avatar)));
  const overlay = makeOverlay(item || {}, normalized, avatarBuffers);
  const composites = [{ input: overlay, top: 0, left: 0 }];
  avatarBuffers.forEach((buffer, index) => {
    if (!buffer) return;
    const rowArea = 716;
    const rowHeight = Math.min(42, rowArea / normalized.length);
    const avatarSize = Math.max(19, Math.min(28, Math.floor(rowHeight - 4)));
    const firstY = 344 + Math.max(0, (rowArea - normalized.length * rowHeight) / 2);
    const top = Math.round(firstY + index * rowHeight + (rowHeight - avatarSize) / 2);
    composites.push({ input: buffer, left: 91 - Math.floor(avatarSize / 2), top });
  });
  return sharp(resolvedTemplate).resize(WIDTH, HEIGHT, { fit: "cover" })
    .composite(composites).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

module.exports = { renderWinnerCard, normalizeWinners };
