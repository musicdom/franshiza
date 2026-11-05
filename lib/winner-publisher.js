"use strict";

const { requestMax, uploadMaxImage } = require("./max-api");
const { createWinnerCard } = require("./winner-card");

async function publishNumberedGiveaway(item, winners, getUser, redis) {
  if (!item || item.type !== "numbers" || item.status !== "completed" || !Array.isArray(winners) || !winners.length) return false;
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) throw new Error("MAX_BOT_TOKEN is not configured");
  const chatId = await redis(["GET", "norka:channel:chat_id"]);
  if (!chatId) throw new Error("Norka channel ID is not configured in Redis");
  const marker = "norka:giveaway:channel-published:" + String(item.id);
  const lock = await redis(["SET", marker, "sending", "NX", "EX", "900"]);
  if (!lock) return false;

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
    const imageToken = await uploadMaxImage({token, image});
    await new Promise(resolve => setTimeout(resolve, 1800));
    const miniApp = process.env.NORKA_MINI_APP_URL || "https://max.ru/se14711525_bot";
    const sent = await requestMax({
      token,
      method: "POST",
      apiPath: "/messages?chat_id=" + encodeURIComponent(String(chatId)),
      body: {
        text: "🏆 Итоги розыгрыша по номерам «" + String(item.title || "Норка").slice(0,100) + "». Поздравляем победителей!",
        attachments: [
          {type:"image",payload:{token:imageToken}},
          {type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"Открыть Норку",web_app:miniApp}]]}}
        ]
      }
    });
    if (!sent.ok) throw new Error("MAX channel post failed: " + (sent.raw || sent.status));
    await redis(["SET", marker, "sent"]);
    return true;
  } catch (error) {
    await redis(["DEL", marker]);
    throw error;
  }
}

module.exports = { publishNumberedGiveaway };
