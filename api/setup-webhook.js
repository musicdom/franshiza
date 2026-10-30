const { requestMax } = require("../lib/max-api");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function setupPage(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.end(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Настройка MAX webhook</title>
<style>
body{font:16px system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 18px;color:#172033;background:#f5f7fb}
main{background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 28px #17203312}
h1{font-size:23px}p{line-height:1.5;color:#475569}
input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:10px;border-radius:10px;font:inherit}
input{border:1px solid #cbd5e1}button{border:0;background:#145be7;color:white;font-weight:650}
#result{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:16px}
.small{font-size:13px}
</style></head>
<body><main>
<h1>Настройка webhook MAX</h1>
<p>Вставь сюда значение <b>MAX_WEBHOOK_SECRET</b> из Vercel. Оно отправится только на этот же сайт в заголовке запроса и не будет отображаться в адресной строке.</p>
<form id="setup"><label for="secret">MAX_WEBHOOK_SECRET</label><input id="secret" type="password" autocomplete="off" required><button id="submit" type="submit">Подключить webhook</button></form>
<div id="result" role="status"></div>
<p class="small">Не отправляй секрет в чат и не делай скриншот с ним.</p>
</main>
<script>
const form=document.getElementById('setup');
const secretInput=document.getElementById('secret');
const result=document.getElementById('result');
const submit=document.getElementById('submit');
form.addEventListener('submit',async event=>{
 event.preventDefault();
 const secret=secretInput.value;
 if(!secret)return;
 submit.disabled=true; submit.textContent='Подключаю…'; result.textContent='';
 try{
  const response=await fetch(location.pathname,{method:'POST',headers:{'Authorization':'Bearer '+secret,'Content-Type':'application/json'},body:'{}',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  secretInput.value='';
  if(response.ok&&data.ok){result.textContent='Готово: webhook зарегистрирован.\\nАдрес: '+data.webhook_url;}
  else{result.textContent='Не получилось (код '+response.status+'): '+(data.error||'неизвестная ошибка')+(data.status?'\\nОтвет MAX: '+data.status:'')+(data.diagnostic?'\\nДиагностика: '+data.diagnostic:'');}
 }catch(e){secretInput.value='';result.textContent='Не удалось связаться с Vercel. Проверь интернет и попробуй ещё раз.';}
 finally{submit.disabled=false;submit.textContent='Подключить webhook';}
});
</script></body></html>`);
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return setupPage(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const token = process.env.MAX_BOT_TOKEN;
  const secret = process.env.MAX_WEBHOOK_SECRET;
  if (!token || !secret) {
    return json(res, 503, { ok: false, error: "Set MAX_BOT_TOKEN and MAX_WEBHOOK_SECRET in Vercel" });
  }

  if (req.headers.authorization !== `Bearer ${secret}`) {
    return json(res, 401, { ok: false, error: "Unauthorized" });
  }

  const configuredHost = process.env.WEBHOOK_BASE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL;
  if (!configuredHost) {
    return json(res, 503, { ok: false, error: "Set WEBHOOK_BASE_URL to the stable HTTPS Vercel domain" });
  }

  let host = configuredHost.trim();
  if (host.startsWith("https://")) host = host.slice(8);
  if (host.startsWith("http://")) host = host.slice(7);
  if (host.endsWith("/")) host = host.slice(0, -1);
  const webhookUrl = `https://${host}/api/webhook`;

  try {
    const response = await requestMax({
      token,
      method: "POST",
      apiPath: "/subscriptions",
      body: {
        url: webhookUrl,
        update_types: ["bot_added", "bot_removed", "bot_started", "message_created", "message_callback"],
        secret
      }
    });
    if (!response.ok || response.data.success === false) {
      console.error("MAX webhook subscription failed:", response.status);
      return json(res, 502, { ok: false, error: "MAX rejected webhook subscription", status: response.status });
    }
    return json(res, 200, { ok: true, webhook_url: webhookUrl, result: response.data });
  } catch (error) {
    const causeCode = error && error.cause && error.cause.code ? error.cause.code : "";
    const errorName = error && error.name ? error.name : "UnknownError";
    console.error("MAX webhook setup failed:", errorName, causeCode);
    return json(res, 502, {
      ok: false,
      error: "Could not reach MAX API",
      diagnostic: causeCode || errorName
    });
  }
};
