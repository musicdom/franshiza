const { requestMax } = require("../lib/max-api");
const sales = require("../lib/sales");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
function normalizeButtonAttachments(attachments = []) {
  return attachments.map((attachment) => {
    if (!attachment || attachment.type !== "inline_keyboard" || !attachment.payload || !Array.isArray(attachment.payload.buttons)) return attachment;
    return {
      ...attachment,
      payload: {
        ...attachment.payload,
        buttons: attachment.payload.buttons.map((row) => Array.isArray(row) ? row.map((button) => {
          if (!button || button.type !== "callback") return button;
          // MAX message buttons send their visible text as message_created events.
          // This keeps the menu functional even if callback delivery is delayed or misconfigured.
          return { type: "message", text: String(button.text || button.payload || "") };
        }) : row)
      }
    };
  });
}

async function sendMessage(chatId, text, attachments = []) {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) throw new Error("MAX_BOT_TOKEN is not configured");
  const response = await requestMax({ token, method: "POST", apiPath: `/messages?chat_id=${encodeURIComponent(String(chatId))}`, body: { text, ...(attachments.length ? { attachments: normalizeButtonAttachments(attachments) } : {}) } });
  if (!response.ok) throw new Error("MAX send failed: " + response.status);
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(res, 503, { ok: false, error: "CRON_SECRET is not configured" });
  if (req.headers.authorization !== `Bearer ${secret}`) return json(res, 401, { ok: false, error: "Unauthorized" });
  const now = Date.now();
  let sent = 0, skipped = 0, retried = 0;
  try {
    const ids = await sales.redis(["ZRANGEBYSCORE", "maxbiz:reminders:pending", "-inf", String(now), "LIMIT", "0", "50"]);
    for (const id of ids || []) {
      const lock = await sales.redis(["SET", `maxbiz:reminder-lock:${id}`, "1", "NX", "EX", "120"]);
      if (!lock) continue;
      try {
        const reminder = await sales.getJson(`maxbiz:reminder:${id}`);
        await sales.redis(["ZREM", "maxbiz:reminders:pending", id]);
        if (!reminder) { skipped++; continue; }
        const session = await sales.getSession(reminder.chat_id);
        const sameSession = session && reminder.session_updated_at && session.updated_at === reminder.session_updated_at;
        if (!sameSession || !session.consent_marketing || session.purchased || ["main_menu", "sales_support"].includes(session.stage) || session.last_reminder_at) {
          skipped++;
          continue;
        }
        const configuredOffset = session.timezone_offset_minutes == null ? Number(process.env.REMINDER_DEFAULT_UTC_OFFSET_MINUTES || 0) : Number(session.timezone_offset_minutes);
        const offsetMinutes = Number.isFinite(configuredOffset) && configuredOffset >= -720 && configuredOffset <= 840 ? configuredOffset : 0;
        const localClock = new Date(now + offsetMinutes * 60000);
        const localHour = localClock.getUTCHours();
        if (localHour < 9 || localHour >= 20) {
          const nextSend = new Date(localClock);
          if (localHour >= 20) nextSend.setUTCDate(nextSend.getUTCDate() + 1);
          nextSend.setUTCHours(9, 0, 0, 0);
          await sales.redis(["ZADD", "maxbiz:reminders:pending", String(nextSend.getTime() - offsetMinutes * 60000), id]);
          skipped++;
          continue;
        }
        const context = session.stage === "sales_lead_details"
          ? "Оформление заявки осталось незавершённым."
          : session.stage === "sales_product"
          ? "Вы смотрели карточку решения."
          : "Вы начали подбор решения для бизнеса.";
        await sendMessage(reminder.chat_id, context + " Если актуально, можно продолжить с сохранённого шага. Это напоминание можно отключить в настройках.", [{ type: "inline_keyboard", payload: { buttons: [
          [{ type: "callback", text: "🎯 Продолжить подбор", payload: String("🎯 Продолжить подбор") }, { type: "callback", text: "🛍 Каталог решений", payload: String("🛍 Каталог решений") }],
          [{ type: "callback", text: "🔕 Отключить уведомления", payload: String("🔕 Отключить уведомления") }]
        ] } }]);
        await sales.saveSession(reminder.chat_id, { ...session, last_reminder_at: new Date().toISOString() });
        await sales.recordEvent({ event: "reminder_sent", chat_id: String(reminder.chat_id), reminder_type: reminder.type });
        sent++;
      } catch (error) {
        console.error("Reminder processing failed:", error && error.message ? error.message : "unknown error");
        try { await sales.redis(["ZADD", "maxbiz:reminders:pending", String(now + 5 * 60 * 1000), id]); retried++; } catch {}
      } finally {
        try { await sales.redis(["DEL", `maxbiz:reminder-lock:${id}`]); } catch {}
      }
    }
    return json(res, 200, { ok: true, checked: (ids || []).length, sent, skipped, retried, note: "Invoke this endpoint periodically from a scheduler. CRON_SECRET must be configured." });
  } catch (error) {
    console.error("Reminder queue failed:", error && error.message ? error.message : "unknown error");
    return json(res, 503, { ok: false, error: "Reminder queue unavailable. Check Redis configuration." });
  }
};
