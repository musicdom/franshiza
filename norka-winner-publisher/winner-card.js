"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const WIDTH = 928;
const HEIGHT = 1152;
const MAX_WINNERS = 25;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

// Карточка использует исходный PNG как фон. Поверх него добавляется только
// компактная полупрозрачная таблица слева; правая часть с маскотом не закрывается.
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
    const size = 36;
    const circle = Buffer.from('<svg width="36" height="36" xmlns="http://www.w3.org/2000/svg"><circle cx="18" cy="18" r="18" fill="#321d43"/></svg>');
    return await sharp(data).rotate().resize(size, size, { fit: "cover", position: "centre" })
      .composite([{ input: circle, blend: "dest-in" }]).png().toBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeOverlay(item, winners, avatarBuffers) {
  const panelX = 34;
  const panelW = 548; // оставляем правую часть изображения свободной для Норки
  const top = 390;
  const headerH = 76;
  const bottomMargin = 26;
  const availableRowsH = HEIGHT - top - headerH - bottomMargin;
  const rowH = Math.min(43, availableRowsH / winners.length);
  const panelH = headerH + rowH * winners.length + 18;
  const avatarSize = Math.max(17, Math.min(34, Math.floor(rowH - 5)));
  const compact = winners.length > 15;
  const nameSize = compact ? 10.5 : winners.length > 8 ? 12 : 14;
  const metaSize = compact ? 10 : winners.length > 8 ? 11 : 13;
  const prizeSize = compact ? 9.5 : winners.length > 8 ? 10.5 : 12;
  const rowTop = top + headerH;
  const title = String(item?.title || "Розыгрыш").trim().slice(0, 48);
  const parts = [];

  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '">');
  parts.push('<defs><linearGradient id="softPanel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#21162f" stop-opacity=".78"/><stop offset="1" stop-color="#401d3d" stop-opacity=".72"/></linearGradient><filter id="softShadow" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="4"/></filter></defs>');
  parts.push('<rect x="' + (panelX + 3) + '" y="' + (top + 4) + '" width="' + panelW + '" height="' + panelH + '" rx="22" fill="#130d1b" opacity=".22" filter="url(#softShadow)"/>');
  parts.push('<rect x="' + panelX + '" y="' + top + '" width="' + panelW + '" height="' + panelH + '" rx="22" fill="url(#softPanel)" stroke="#e8c18a" stroke-opacity=".82" stroke-width="1.6"/>');
  parts.push('<text x="' + (panelX + 20) + '" y="' + (top + 29) + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="17" font-weight="700" fill="#fff2d9">' + escapeXml(title) + '</text>');
  parts.push('<text x="' + (panelX + 20) + '" y="' + (top + 53) + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="12" fill="#f0d9c5">Победителей: ' + winners.length + '</text>');
  parts.push('<text x="' + (panelX + 82) + '" y="' + (rowTop - 8) + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="9.5" font-weight="700" fill="#e8d3bd">ИМЯ</text>');
  parts.push('<text x="' + (panelX + 325) + '" y="' + (rowTop - 8) + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="9.5" font-weight="700" fill="#e8d3bd">БИЛЕТ</text>');
  parts.push('<text x="' + (panelX + 398) + '" y="' + (rowTop - 8) + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="9.5" font-weight="700" fill="#e8d3bd">ПРИЗ</text>');

  winners.forEach((winner, index) => {
    const y = rowTop + index * rowH;
    const avatarY = y + (rowH - avatarSize) / 2;
    const cy = y + rowH / 2 + Math.max(3.5, nameSize * 0.34);
    const avatarX = panelX + 43;
    if (index % 2 === 0) {
      parts.push('<rect x="' + (panelX + 12) + '" y="' + (y + 1) + '" width="' + (panelW - 24) + '" height="' + Math.max(1, rowH - 2) + '" rx="7" fill="#fff" fill-opacity=".07"/>');
    }
    parts.push('<circle cx="' + avatarX + '" cy="' + (avatarY + avatarSize / 2) + '" r="' + (avatarSize / 2 + 1) + '" fill="#e7c28d" fill-opacity=".95"/>');
    if (!avatarBuffers[index]) {
      parts.push('<circle cx="' + avatarX + '" cy="' + (avatarY + avatarSize / 2) + '" r="' + (avatarSize / 2) + '" fill="#765487"/>');
      parts.push('<text x="' + avatarX + '" y="' + (avatarY + avatarSize * .68) + '" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + Math.max(8, avatarSize * .42) + '" font-weight="700" fill="#fff">' + escapeXml(initials(winner.name)) + '</text>');
    }
    parts.push('<text x="' + (panelX + 82) + '" y="' + cy + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + nameSize + '" font-weight="600" fill="#fffaf2" textLength="225" lengthAdjust="spacingAndGlyphs">' + escapeXml(winner.name) + '</text>');
    parts.push('<text x="' + (panelX + 325) + '" y="' + cy + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + metaSize + '" fill="#ffe2b7">№ ' + escapeXml(String(winner.number).padStart(2, "0")) + '</text>');
    parts.push('<text x="' + (panelX + 398) + '" y="' + cy + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + prizeSize + '" font-weight="600" fill="#fff4e8" textLength="130" lengthAdjust="spacingAndGlyphs">' + escapeXml(winner.prize) + '</text>');
    if (index < winners.length - 1) {
      parts.push('<path d="M' + (panelX + 80) + ' ' + (y + rowH) + ' H' + (panelX + panelW - 12) + '" stroke="#e8c18a" stroke-opacity=".22" stroke-width="1"/>');
    }
  });
  parts.push('</svg>');
  return { svg: Buffer.from(parts.join("")), panelX, rowTop, rowH, avatarSize, avatarCenterX: panelX + 43 };
}

function loadBundledTemplate() {
  const partNames = [
    "winner-template.part01.b64",
    "winner-template.part02.b64",
    "winner-template.part03.b64",
    "winner-template.part04.b64"
  ];
  const encoded = partNames.map(name => {
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) throw new Error("WINNER_TEMPLATE_PART_MISSING: " + name);
    return fs.readFileSync(file, "utf8").replace(/\s/g, "");
  }).join("");
  return Buffer.from(encoded, "base64");
}

async function renderWinnerCard({ item, winners, templatePath }) {
  const normalized = normalizeWinners(winners);
  const defaultTemplate = path.join(__dirname, "winner-template.png..png");
  const templateInput = templatePath || (fs.existsSync(defaultTemplate) ? defaultTemplate : loadBundledTemplate());
  const avatarBuffers = await Promise.all(normalized.map(w => fetchAvatar(w.avatar)));
  const layout = makeOverlay(item || {}, normalized, avatarBuffers);
  const composites = [{ input: layout.svg, top: 0, left: 0 }];
  avatarBuffers.forEach((buffer, index) => {
    if (!buffer) return;
    const top = Math.round(layout.rowTop + index * layout.rowH + (layout.rowH - layout.avatarSize) / 2);
    composites.push({
      input: buffer,
      left: Math.round(layout.avatarCenterX - layout.avatarSize / 2),
      top
    });
  });
  return sharp(templateInput)
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

module.exports = { renderWinnerCard, normalizeWinners };
