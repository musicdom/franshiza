const fs = require("fs");
const vm = require("vm");
const html = fs.readFileSync("index.html", "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("Inline application script was not found");
new vm.Script(match[1], { filename: "index.html" });

const ids = [...html.matchAll(new RegExp('\\bid="([^"]+)"', "g"))].map(match => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error("Duplicate DOM ids: " + [...new Set(duplicateIds)].join(", "));
const references = [...match[1].matchAll(new RegExp('\\$\\("([^"]+)"\\)', "g"))].map(match => match[1]);
const missing = [...new Set(references.filter(id => !ids.includes(id)))];
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
if (!webhook.includes("grantLaunchReward") || !webhook.includes("bot_started")) throw new Error("Bot-start reward webhook is missing");
if (!match[1].includes("Пополнить кошелёк") || !match[1].includes("1% монетами + 250 🍓")) throw new Error("First top-up task UI is missing");
if (match[1].includes("confirm(")) throw new Error("Native browser confirmations must not block MAX admin actions");
if (!api.includes("participantsRemoved") || !api.includes("backendVersion:NORKA_BACKEND_VERSION")) throw new Error("Giveaway deletion diagnostics are missing");
for (const key of ["norka:progress:", "norka:progress:events:", "norka:achievements:", "norka:streak:rewards:", "norka:level:rewards:"]) if (!api.includes(key)) throw new Error("Missing progress storage key: " + key);
if (!html.includes('id="collection"') || !match[1].includes("function renderProgress")) throw new Error("Progress and collection UI are missing");
const cron = fs.readFileSync("api/cron/norka.js", "utf8");
if (!cron.includes('norka:daily:"+id+":"+day') || !cron.includes("Тебе доступны ежедневные 10 ягод") || !cron.includes("norka:reminder:")) throw new Error("Daily berry reminder must follow the daily claim marker and send the 10-berry notice");
if (!cron.includes("skippedClaimed") || !cron.includes("skippedReminder") || !cron.includes("failedReminders") || !cron.includes("authorization header mismatch")) throw new Error("Daily reminder cron must expose actionable delivery diagnostics");
const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
if (!vercel.crons?.some(job => job.path === "/api/cron/norka" && job.schedule === "0 0 * * *")) throw new Error("Daily reminder cron must run at 00:00 UTC");

process.stdout.write("Norka browser script, DOM references and button bindings: OK\n");
