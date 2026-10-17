const sales = require("../lib/sales");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}
function page(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Продажи — администрирование</title>
<style>body{font:15px system-ui,sans-serif;background:#111510;color:#f4f6f1;margin:0;padding:24px}main{max-width:1050px;margin:auto}h1{font-size:28px}p{color:#a1aaa1;line-height:1.6}input,button,select{font:inherit;padding:11px;border-radius:9px;border:1px solid #384036;background:#1b2119;color:#f4f6f1}button{cursor:pointer;background:#c8ff5f;color:#111510;font-weight:700}.bar{display:flex;gap:8px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:22px 0}.metric,.lead{border:1px solid #384036;border-radius:13px;padding:15px;background:#191e18}.metric strong{font-size:25px;display:block}.metric small{color:#a1aaa1}.lead{margin:10px 0}.lead h3{margin:0 0 8px}.muted{color:#a1aaa1;white-space:pre-wrap;overflow-wrap:anywhere}.hidden{display:none}#status{white-space:pre-wrap;color:#c8ff5f;margin-top:10px}</style>
<main><h1>Продажи — панель администратора</h1><p>Доступ только по ADMIN_API_TOKEN из Vercel. Вводимый токен используется только для запросов к этому endpoint и не сохраняется в браузере.</p>
<div class="bar"><input id="token" type="password" placeholder="ADMIN_API_TOKEN" autocomplete="off"><button id="load">Загрузить данные</button></div><div id="status" role="status"></div><section id="dashboard" class="hidden"><div id="metrics" class="grid"></div><h2>Заявки</h2><div id="leads"></div><h2>Последние события</h2><div id="events"></div></section></main>
<script>
const token=document.getElementById('token'),status=document.getElementById('status'),dashboard=document.getElementById('dashboard');
async function api(method,body){const r=await fetch(location.pathname,{method,headers:{'Authorization':'Bearer '+token.value,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d;}
document.getElementById('load').addEventListener('click',async()=>{status.textContent='Загружаю…';try{const d=await api('POST',{action:'dashboard'});dashboard.classList.remove('hidden');document.getElementById('metrics').replaceChildren(...Object.entries(d.metrics).map(([k,v])=>{const el=document.createElement('div');el.className='metric';const strong=document.createElement('strong');strong.textContent=v;const small=document.createElement('small');small.textContent=k;el.append(strong,small);return el;}));const list=document.getElementById('leads');list.replaceChildren();d.leads.forEach(l=>{const el=document.createElement('div');el.className='lead';const h=document.createElement('h3');h.textContent=l.id+' · '+(l.type||'заявка');const details=document.createElement('p');details.className='muted';details.textContent='Статус: '+l.status+'\nЧат: '+l.chat_id+'\nКлиент: '+(l.user_name||'не указан')+'\nРешение: '+(l.product_id||'не выбрано')+'\nОписание: '+(l.details||'');const controls=document.createElement('div');controls.className='bar';const select=document.createElement('select');['new','in_progress','waiting_customer','completed','cancelled'].forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;o.selected=v===l.status;select.append(o)});const save=document.createElement('button');save.textContent='Сохранить статус';save.addEventListener('click',async()=>{try{await api('POST',{action:'update_lead',id:l.id,status:select.value});status.textContent='Статус обновлён для '+l.id;}catch(e){status.textContent=e.message;}});controls.append(select,save);el.append(h,details,controls);list.append(el)});const ev=document.getElementById('events');ev.replaceChildren();d.events.forEach(e=>{const p=document.createElement('p');p.className='muted';p.textContent=(e.occurred_at||'')+' · '+(e.event||'event')+' · чат '+(e.chat_id||'—')+' · продукт '+(e.product_id||'—');ev.append(p)});status.textContent='Обновлено. Показаны фактические записи, доступные в Redis.';}catch(e){status.textContent=e.message;}});</script></html>`);
}
module.exports = async function handler(req, res) {
  if (req.method === "GET" && !req.headers.authorization) return page(res);
  if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return json(res, 405, { ok: false, error: "Method not allowed" }); }
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return json(res, 503, { ok: false, error: "ADMIN_API_TOKEN is not configured in Vercel" });
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: "Unauthorized" });
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (req.method === "POST" && body.action === "update_lead") {
      const allowed = ["new", "in_progress", "waiting_customer", "completed", "cancelled"];
      if (!allowed.includes(body.status) || typeof body.id !== "string") return json(res, 400, { ok: false, error: "Invalid lead update" });
      const lead = await sales.updateLead(body.id, { status: body.status });
      if (!lead) return json(res, 404, { ok: false, error: "Lead not found" });
      return json(res, 200, { ok: true, lead });
    }
    if (req.method === "POST" && body.action !== "dashboard") return json(res, 400, { ok: false, error: "Unknown action" });
    const leads = await sales.listLeads(200);
    const ids = await sales.listEventIds(250);
    const events = [];
    for (const id of ids || []) { const item = await sales.getJson(`maxbiz:event:${id}`); if (item) events.push(item); }
    const count = (name) => events.filter(e => e.event === name).length;
    const rate = (numerator, denominator) => denominator ? Math.round(numerator * 100 / denominator) + "%" : "—";
    const metrics = {
      "Заявки": leads.length,
      "Новые заявки": leads.filter(l => l.status === "new").length,
      "Запуски бота (последние события)": count("bot_started"),
      "Просмотры продуктов": count("product_viewed"),
      "Показы рекомендаций": count("recommendation_shown"),
      "Конверсия запуска в просмотр": rate(count("product_viewed"), count("bot_started")),
      "Открытия демо": count("demo_opened"),
      "Просмотры цены": count("price_viewed"),
      "Начало оформления": count("checkout_started"),
      "Отправлено напоминаний": count("reminder_sent"),
      "Переходы из напоминаний": count("reminder_clicked"),
      "Отписки": count("notification_opted_out")
    };
    return json(res, 200, { ok: true, metrics, leads, events: events.slice(0, 100) });
  } catch (error) {
    console.error("Admin API failed:", error && error.message ? error.message : "unknown error");
    return json(res, 503, { ok: false, error: "Data unavailable. Check Redis configuration." });
  }
};
