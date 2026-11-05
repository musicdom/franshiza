"use strict";

const { requestMax, uploadMaxImage } = require("./max-api");
const { createWinnerCard } = require("./winner-card");

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
  const text = "🏆 Итоги розыгрыша по номерам «" + String(item.title || "Норка").slice(0,100) + "». Поздравляем победителей!";
  const keyboard = {
    type: "inline_keyboard",
    payload: { buttons: [[{ type: "open_app", text: "Открыть Норку", web_app: miniApp }]] }
  };
  const post = async attachments => requestMax({
    token,
    method: "POST",
    apiPath: "/messages?chat_id=" + encodeURIComponent(String(chatId)),
    body: { text, attachments }
  });

  try {
    let imageToken = null;
    let imageError = null;

    try {
      const enriched = await Promise.all(winners.map(async winner => {
        const user = await getUser(String(winner.userId));
        return {
          number: winner.number,
          name: user && user.name || "Участник Норки",
          prize: winner.prize && winner.prize.title || "Приз розыгрыша"
        };
      }));
      const image = await createWinnerCard(item, enriched);
      imageToken = await uploadMaxImage({ token, image });
      await new Promise(resolve => setTimeout(resolve, 1800));
    } catch (error) {
      imageError = String(error && error.message || error || "Unknown image error").slice(0, 1000);
    }

    let sent;
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

    // Image processing/upload/post must never prevent the channel text and app button.
    if (!sent || !sent.ok) {
      sent = await post([keyboard]);
    }
    if (!sent.ok) {
      throw new Error("MAX channel text/button post failed: " + String(sent.raw || sent.status).slice(0, 1000));
    }

    if (imageError) {
      await redis(["SET", imageErrorKey, imageError, "EX", "2592000"]);
      console.error("NORKA channel image failed; text/button posted:", imageError);
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

module.exports = { publishNumberedGiveaway };
