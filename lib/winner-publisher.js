"use strict";

const WINNER_PUBLISHER_BUILD = "norka-winner-publisher-lazy-card-load-2026-11-06-v2";
const { sendMaxMessage, uploadMaxImage } = require("./max-api");

async function publishNumberedGiveaway(item, winners, getUser, redis) {
  if (!item || item.type !== "numbers" || item.status !== "completed" || !Array.isArray(winners) || !winners.length) return false;
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) throw new Error("MAX_BOT_TOKEN is not configured");
  const chatId = await redis(["GET", "norka:channel:chat_id"]);
  if (!chatId) throw new Error("Norka channel ID is not configured in Redis");
  const id = String(item.id);
  const marker = "norka:giveaway:channel-published:" + id;
  const imageErrorKey = "norka:giveaway:channel-image-error:" + id;
  const lock = await redis(["SET", marker, "sending", "NX", "EX", "900"]);
  if (!lock) return false;

  const miniApp = process.env.NORKA_MINI_APP_URL || "https://max.ru/se14711525_bot";
  const safe = value => String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
  const winnerDetails = await Promise.all(winners.map(async (winner, index) => {
    let user = null;
    try { user = await getUser(String(winner.userId)); } catch (_) {}
    const prizeTitle = winner.prize && typeof winner.prize === "object"
      ? (winner.prize.title || winner.prize.name || "Приз розыгрыша")
      : (winner.prize || "Приз розыгрыша");
    const name = safe(user && (user.name || user.firstName || user.username)) || "Участник Норки";
    return {
      place: winner.place || index + 1,
      number: winner.number,
      userId: winner.userId,
      name,
      prize: safe(prizeTitle)
    };
  }));
  const text = [
    "🏆 ИТОГИ РОЗЫГРЫША В НОРКЕ",
    "",
    "🎁 Розыгрыш: «" + safe(item.title || "Без названия") + "»",
    "🎉 Поздравляем победителей!",
    "",
    ...winnerDetails.flatMap(w => [
      (w.place === 1 ? "🥇" : w.place === 2 ? "🥈" : w.place === 3 ? "🥉" : "🏅") +
        " " + w.place + "-е место",
      "🎟 Номер: " + safe(w.number),
      "👤 Победитель: " + w.name,
      "🎁 Приз: " + w.prize,
      ""
    ]),
    "Спасибо всем за участие! Следите за новыми розыгрышами в Норке."
  ].join("\n");
  const keyboard = {
    type: "inline_keyboard",
    payload: { buttons: [[{ type: "open_app", text: "Открыть Норку", web_app: miniApp }]] }
  };
  const post = async attachments => sendMaxMessage({ token, chatId, text, attachments });

  try {
    let imageToken = null;
    let imageError = null;

    // The image is optional: a missing sharp binary must never block the results post.
    try {
      const enriched = winnerDetails.map(w => ({ number: w.number, name: w.name, prize: w.prize }));
      const { createWinnerCard } = require("./winner-card");
      const image = await createWinnerCard(item, enriched);
      imageToken = await uploadMaxImage({ token, image });
      await new Promise(resolve => setTimeout(resolve, 1800));
    } catch (error) {
      imageError = String(error && error.message || error || "Unknown image error").slice(0, 1000);
    }

    let sent = null;
    if (imageToken) {
      sent = await post([{ type: "image", payload: { token: imageToken } }, keyboard]);
      if (!sent.ok && String(sent.raw || "").includes("attachment.not.ready")) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        sent = await post([{ type: "image", payload: { token: imageToken } }, keyboard]);
      }
      if (!sent.ok) {
        imageError = "MAX rejected image post: " + String(sent.raw || sent.status).slice(0, 800);
      }
    }

    // Always make a plain text post if image creation/upload/post failed.
    if (!sent || !sent.ok) sent = await post([keyboard]);
    if (!sent.ok) {
      throw new Error("MAX channel text/button post failed: " + String(sent.raw || sent.status).slice(0, 1000));
    }

    if (imageError) {
      await redis(["SET", imageErrorKey, imageError, "EX", "2592000"]);
      console.error("NORKA channel image failed; full text results posted:", imageError);
    } else {
      await redis(["DEL", imageErrorKey]);
    }
    await redis(["SET", marker, "sent"]);
    return true;
  } catch (error) {
    await redis(["DEL", marker]);
    throw error;
  }
}

module.exports = { publishNumberedGiveaway, WINNER_PUBLISHER_BUILD };
