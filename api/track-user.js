const { requestMax } = require("../lib/max-api");
const { createHmac, timingSafeEqual } = require("crypto");

function cors(req,res){const o=String(req.headers.origin||"");if(["https://musicdom.github.io","https://franshiza.vercel.app"].includes(o)||/^https:\/\/franshiza-[a-z0-9-]+\.vercel\.app$/.test(o))res.setHeader("Access-Control-Allow-Origin",o);res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-InitData");}
function json(res,status,body){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(body));}
function clean(value,max=180){return typeof value==="string"?value.replace(/[\r\n\t]/g," ").trim().slice(0,max):"";}
function verifyInitData(raw,token){
 if(!raw||!token||raw.length>12000)return null;
 try{
  const params=new URLSearchParams(raw),entries=[...params.entries()];
  if(entries.some(([key])=>params.getAll(key).length!==1))return null;
  const hash=params.get("hash"),authDate=Number(params.get("auth_date"));
  if(!hash||!/^[a-f0-9]{64}$/i.test(hash)||!Number.isFinite(authDate))return null;
  const age=Math.floor(Date.now()/1000)-authDate;if(age>3600||age< -60)return null;
  const check=entries.filter(([key])=>key!=="hash").sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([key,value])=>key+"="+value).join("\n");
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const expected=createHmac("sha256",secret).update(check).digest();
  const supplied=Buffer.from(hash,"hex");if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return null;
  const user=JSON.parse(params.get("user")||"null");if(!user||!user.id)return null;
  return {user,params};
 }catch{return null;}
}
function getRedisConfig(){const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL;const token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;return url&&token?{url:url.replace(/\/$/,""),token}:null;}
async function redis(parts){const config=getRedisConfig();if(!config)return null;const response=await fetch(config.url,{method:"POST",headers:{Authorization:"Bearer "+config.token,"Content-Type":"application/json"},body:JSON.stringify(parts)});if(!response.ok)throw new Error("Redis HTTP "+response.status);const data=await response.json();if(data.error)throw new Error("Redis command failed");return data.result;}
function escapeText(value){return String(value||"").replace(/[&<>]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[ch]));}
module.exports=async function handler(req,res){
 cors(req,res);if(req.method==="OPTIONS")return res.status(204).end();
 if(req.method!=="POST"){res.setHeader("Allow","POST");return json(res,405,{ok:false,error:"Method not allowed"});}
 const payload=req.body&&typeof req.body==="object"?req.body:{};
 const token=clean(process.env.MAX_BOT_TOKEN||"",500);
 if(!token)return json(res,503,{ok:false,error:"На сервере не настроен MAX_BOT_TOKEN"});
 const verified=verifyInitData(clean(payload.initData,12000),token);
 if(!verified)return json(res,401,{ok:false,error:"Подпись данных MAX не прошла проверку. Перезапусти приложение."});
 const user=verified.user,params=verified.params;
 const id=clean(String(user.id||""),80),identified=Boolean(id);
 const name=clean([user.first_name,user.last_name].filter(Boolean).join(" ")||user.name||user.username||"Пользователь MAX",120);
 const username=clean(user.username||"",80),language=clean(user.language_code||"",40);
 const photoUrl=clean(user.photo_url||"",500),chatRaw=params.get("chat")||"";
 let chat={};try{chat=chatRaw?JSON.parse(chatRaw):{};}catch{}
 const chatId=clean(String(chat.id||""),80),chatType=clean(String(chat.type||""),40);
 const queryId=clean(params.get("query_id")||"",180),authDate=clean(params.get("auth_date")||"",40);
 const startParam=clean(String(payload.start_param||""),512);
 const platform=clean(String(payload.platform||""),80),version=clean(String(payload.version||""),80);
 const deviceName=clean(String(payload.device_name||""),120),ip=clean(params.get("ip")||"",80);
 const webappFields=[...params.keys()].slice(0,40);
 let adminId="",recipientParam="";
 const configuredUserId=clean(process.env.MAX_ADMIN_USER_ID||process.env.MAX_OWNER_USER_ID||"163701646",80);
 const configuredChatId=clean(process.env.MAX_ADMIN_CHAT_ID||"",80);
 if(configuredUserId){adminId=configuredUserId;recipientParam="user_id";}
 else if(configuredChatId){adminId=configuredChatId;recipientParam="chat_id";}
 if(!adminId){try{const saved=await redis(["GET","maxbiz:admin:recipient"]);if(saved){const recipient=typeof saved==="string"?JSON.parse(saved):saved;if(recipient.chat_id){adminId=clean(String(recipient.chat_id),80);recipientParam="chat_id";}else if(recipient.user_id){adminId=clean(String(recipient.user_id),80);recipientParam="user_id";}}}catch(error){console.error("TRACK USER admin lookup failed:",error.message);}}
 if(!adminId)return json(res,503,{ok:false,error:"Администратор не привязан к боту."});
 try{
  let returning=false;
  try{if(identified&&getRedisConfig()){const key="norka:user:tracked:"+id;returning=Boolean(await redis(["GET",key]));await redis(["SET",key,JSON.stringify({id,name,username:username||null,last_opened_at:new Date().toISOString()}),"EX","31536000"]);}}catch(error){console.error("TRACK USER storage warning:",error.message);}
  const profile="[Открыть профиль](max://user/"+encodeURIComponent(id)+")";
  const text=[
   returning?"🔄 Повторное открытие мини-приложения «Норка»":"🌿 Пользователь открыл мини-приложение «Норка»",
   "","👤 Имя: "+escapeText(name),"🆔 ID: "+escapeText(id),"🔗 Профиль: "+profile,
   "📛 "+(username?"@"+escapeText(username.replace(/^@/,"")):"username отсутствует"),
   "🌐 Язык: "+escapeText(language||"не передан"),
   "🖼 Фото профиля: "+(photoUrl?escapeText(photoUrl):"не передано"),
   "💬 Чат: "+escapeText(chatId||"не передан")+(chatType?" ("+escapeText(chatType)+")":""),
   "🔎 Query ID: "+escapeText(queryId||"не передан"),"🚀 Стартовый параметр: "+escapeText(startParam||"не передан"),
   "🕒 Auth date: "+escapeText(authDate||"не передан"),"📱 Платформа: "+escapeText(platform||"не передана"),
   "🧩 Версия MAX: "+escapeText(version||"не передана"),"📟 Устройство: "+escapeText(deviceName||"не передано"),
   "🌍 IP из WebApp: "+escapeText(ip||"не передан"),"🗂 Поля initData: "+escapeText(webappFields.join(", ")),
   "🕐 Время события: "+new Date().toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})
  ].join("\n");
  const sent=await requestMax({token,method:"POST",apiPath:"/messages?"+recipientParam+"="+encodeURIComponent(adminId),body:{text}});
  if(!sent.ok){console.error("TRACK USER MAX send failed:",sent.status);return json(res,502,{ok:false,error:"MAX не принял уведомление.",status:sent.status});}
  return json(res,200,{ok:true,returning});
 }catch(error){console.error("TRACK USER failed:",error&&error.message?error.message:"unknown error");return json(res,500,{ok:false,error:"Не удалось отправить уведомление."});}
};