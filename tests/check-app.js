const fs = require("fs");
const vm = require("vm");
const html = fs.readFileSync("index.html", "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("Inline application script was not found");
new vm.Script(match[1], { filename: "index.html" });

const staticHtml = html.slice(0, html.indexOf("<script>"));
const ids = [...staticHtml.matchAll(new RegExp('\\bid="([^"]+)"', "g"))].map(match => match[1]);
const declaredIds = [...html.matchAll(new RegExp('\\bid="([^"]+)"', "g"))].map(match => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error("Duplicate DOM ids: " + [...new Set(duplicateIds)].join(", "));
const references = [...match[1].matchAll(new RegExp('\\$\\("([^"]+)"\\)', "g"))].map(match => match[1]);
const missing = [...new Set(references.filter(id => !declaredIds.includes(id)))];
if (missing.length) throw new Error("Missing DOM ids: " + missing.join(", "));
const buttons = [...html.matchAll(new RegExp('<button\\b[^>]*\\bid="([^"]+)"', "g"))].map(match => match[1]);
const unbound = buttons.filter(id => !match[1].includes('$("' + id + '").onclick') && !match[1].includes('$("' + id + '").oninput'));
if (unbound.length) throw new Error("Buttons without handlers: " + unbound.join(", "));

const api = fs.readFileSync("api/norka.js", "utf8");
for (const action of ["admin_save_progress_config", "admin_delete_giveaway", "admin_draw_winner", "admin_create_giveaway", "bootstrap", "daily_claim", "admin_approve_task", "exchange", "enter_giveaway"]) if (!api.includes("action===\"" + action + "\"")) throw new Error("Missing Norka action: " + action);
for (const marker of ["completeGiveaway", "ensureGiveawayReward", "processGiveawayLifecycle", "NORKA_BACKEND_VERSION", "norka:rewards:", "norka:giveaway:reward:"]) if (!api.includes(marker)) throw new Error("Missing giveaway lifecycle component: " + marker);
if (!api.includes("no_participants") || !api.includes("status=\'cancelled\'")) throw new Error("Orphaned giveaway draw recovery is missing");
if (!api.includes("const [walletResult,historyResult,tasksResult,giveawaysResult,claimsResult,rateResult,progressResult,rewardsResult,communityResult]=await Promise.all([")) throw new Error("Bootstrap sections must load concurrently");
if (!api.includes("const topProfiles=await Promise.all(topEntries.map(entry=>get(userKey(entry.userId))))")) throw new Error("Ranking profiles must load concurrently");
if (!match[1].includes("async function fetchAdminOverview()") || !match[1].includes("for(let attempt=0;attempt<2;attempt++)")) throw new Error("Admin overview must retry transient failures");
if (!match[1].includes('action:"admin_overview"') || match[1].includes('await fetch(YANDEX_FUNCTION+"?route=norka&action=auth_check"')) throw new Error("App startup must not block on the background auth check");

if (!html.includes("id=\"profileGifts\"") || !match[1].includes("function renderGifts")) throw new Error("Winner gifts UI is missing");
for (const task of ['id:"launch"', 'id:"channel"', 'id:"first_topup"']) if (!api.includes(task)) throw new Error("Missing permanent task: " + task);
if (!api.includes("claimLaunchTask") || !api.includes("norka:taskclaim:")) throw new Error("Permanent launch reward is missing");
if (!api.includes("Постоянное системное задание нельзя удалить")) throw new Error("Permanent tasks can be deleted");
const payment = fs.readFileSync("api/yoomoney/notify.js", "utf8");
for (const marker of ["firstTopupBonusCoins", "first_topup_task", "norka:taskclaim:", "taskBonusCoins"]) if (!payment.includes(marker)) throw new Error("First top-up reward component is missing: " + marker);
const webhook = fs.readFileSync("api/webhook.js", "utf8");
if (!webhook.includes('const { requestMax, sendMaxMessage } = require("../lib/max-api");')) throw new Error("Support direct messages must import requestMax");
if (!webhook.includes("(u.message&&u.message.recipient&&u.message.recipient.chat_id)")) throw new Error("MAX callback chat ID must be read from the root message recipient");
if (!webhook.includes("const callbackUserId=actorId||userIdFromUpdate(u)||clean(String(callback.message?.recipient?.user_id||\"\"),80);") || !webhook.includes("u.callback?.message?.recipient?.user_id") || !webhook.includes('await sendUser(userId,"✍️ Опишите') || !webhook.includes('await sendUser(callbackUserId,"Хорошо!')) throw new Error("MAX private-dialog callbacks must resolve the clicked user and reply in their DM");
if (!webhook.includes('callbackEventKey=type==="message_callback"') || webhook.includes("callback.timestamp,callback.user&&")) throw new Error("MAX button callbacks must not deduplicate by user ID when a unique callback ID is absent");
if (!webhook.includes("Array.isArray(root.updates)") || !webhook.includes("for(const update of updates)")) throw new Error("MAX webhook must process batched updates");
if (!webhook.includes('apiPath:"/answers?callback_id="+encodeURIComponent(String(callbackId))') || !webhook.includes('body:{notification:"Готово"}')) throw new Error("MAX callback acknowledgement is missing");
if (!webhook.includes("callback.payload||u.payload||") || !webhook.includes("m.body&&m.body.text||m.text||u.body&&u.body.text||u.text")) throw new Error("MAX callback/message payload fallbacks are missing");

if (!webhook.includes("grantLaunchReward") || !webhook.includes("bot_started")) throw new Error("Bot-start reward webhook is missing");
const setupWebhook = fs.readFileSync("api/setup-webhook.js", "utf8");
if (!setupWebhook.includes("https://functions.yandexcloud.net/") || setupWebhook.includes("VERCEL_PROJECT_PRODUCTION_URL")) throw new Error("MAX webhook setup must register the Yandex Cloud webhook URL, not a Vercel URL");
const tracker = fs.readFileSync("api/track-user.js", "utf8");
if (!tracker.includes('body:{text,format:"markdown"}') || !tracker.includes('max://user/')) throw new Error("Admin open-app alerts must contain clickable MAX user profile links");
for (const marker of ["norka_support_yes", "norka_support_no", "norka_support_reply:", "awaiting_issue", "support:ticket:", "support_reply_sent", "Ответить клиенту", "sendUser(adminId", "sendUser(ticket.userId"]) if (!webhook.includes(marker)) throw new Error("Support conversation flow is missing: " + marker);
if (!webhook.includes('format:"markdown"') || !webhook.includes("max://user/")) throw new Error("Support tickets must include a clickable MAX user profile link");

if (!match[1].includes("Пополнить кошелёк") || !match[1].includes("1% монетами + 250 🍓")) throw new Error("First top-up task UI is missing");
if (match[1].includes("confirm(")) throw new Error("Native browser confirmations must not block MAX admin actions");
if (!api.includes("participantsRemoved") || !api.includes("backendVersion:NORKA_BACKEND_VERSION")) throw new Error("Giveaway deletion diagnostics are missing");
for (const key of ["norka:progress:", "norka:progress:events:", "norka:achievements:", "norka:streak:rewards:", "norka:level:rewards:"]) if (!api.includes(key)) throw new Error("Missing progress storage key: " + key);
if (!html.includes('id="collection"') || !match[1].includes("function renderProgress")) throw new Error("Progress and collection UI are missing");
const cron = fs.readFileSync("api/cron/norka.js", "utf8");
if (!cron.includes('norka:daily:"+id+":"+day') || !cron.includes("Тебе доступны ежедневные 10 ягод") || !cron.includes("norka:reminder:")) throw new Error("Daily berry reminder must follow the daily claim marker and send the 10-berry notice");
if (!cron.includes("skippedClaimed") || !cron.includes("skippedReminder") || !cron.includes("failedReminders") || !cron.includes("authorization header mismatch")) throw new Error("Daily reminder cron must expose actionable delivery diagnostics");
if (!cron.includes("const result=await send(id,message);if(!result.ok)return false;")) throw new Error("Notification markers must only be written after successful MAX delivery");
if (!cron.includes('apiPath:"/messages?user_id="+encodeURIComponent(String(id))') || !cron.includes("NORKA bot DM sent") || !cron.includes("sender:message.sender") || !cron.includes("chat_type:message.recipient.chat_type")) throw new Error("Daily reminder must be sent by the Norka bot to the user dialog and log sender/recipient");
const yandex = fs.readFileSync("yandex-function.js", "utf8");
if (!yandex.includes('"cron-norka": require("./api/cron/norka")') || !yandex.includes('payload?.route')) throw new Error("Yandex Timer Trigger must route cron-norka events");
if (!yandex.includes('headers.authorization = "Bearer " + process.env.CRON_SECRET')) throw new Error("Yandex Timer Trigger must authorize internal cron events");
if (fs.existsSync("vercel.json")) throw new Error("Vercel Cron configuration must be removed");
if (!html.includes('fetch(YANDEX_FUNCTION+"?route=payment"') || html.includes("franshiza.vercel.app")) throw new Error("Mini-app payments must use Yandex Cloud, not Vercel");

process.stdout.write("Norka browser script, DOM references and button bindings: OK\n");
