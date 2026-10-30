const { createHmac, timingSafeEqual } = require("crypto");

function json(res,status,data){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));}
function cfg(){const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL;const token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;return url&&token?{url:url.replace(/\/$/,""),token}:null;}
async function redis(parts){const c=cfg();if(!c)throw new Error("Redis is not configured");const r=await fetch(c.url,{method:"POST",headers:{Authorization:"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify(parts)});if(!r.ok)throw new Error("Redis HTTP "+r.status);const d=await r.json();if(d.error)throw new Error(d.error);return d.result;}
async function get(key){const v=await redis(["GET",key]);if(!v)return null;try{return JSON.parse(v);}catch{return v;}}
async function set(key,value){return redis(["SET",key,JSON.stringify(value)]);}
function clean(v,n=160){return typeof v==="string"?v.trim().slice(0,n):"";}
function verifyInitData(req){
 const raw=String(req.headers["x-norka-initdata"]||req.body?.initData||"");
 const token=process.env.MAX_BOT_TOKEN;
 if(!raw||!token||raw.length>12000)return null;
 try{
  const params=new URLSearchParams(raw),entries=[...params.entries()];
  if(entries.some(([k])=>params.getAll(k).length!==1))return null;
  const hash=params.get("hash"),authDate=Number(params.get("auth_date"));
  if(!hash||!/^[a-f0-9]{64}$/i.test(hash)||!Number.isFinite(authDate))return null;
  const age=Math.floor(Date.now()/1000)-authDate;
  if(age>86400||age< -60)return null;
  const check=entries.filter(([k])=>k!=="hash").sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([k,v])=>k+"="+v).join("\n");
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const expected=createHmac("sha256",secret).update(check).digest();
  const supplied=Buffer.from(hash,"hex");
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return null;
  const user=JSON.parse(params.get("user")||"null");
  if(!user||!user.id)return null;
  return {id:String(user.id),profile:{name:[user.first_name,user.last_name].filter(Boolean).join(" ")||user.name||user.username||"Участник Норки",avatar:user.photo_url||""}};
 }catch{return null;}
}
function userKey(id){return "norka:user:"+id;}
async function ensureUser(id,profile={}){let u=await get(userKey(id));if(!u){u={id, name:clean(profile.name,100)||"Участник Норки", avatar:clean(profile.avatar,500), berries:0,coins:0,createdAt:new Date().toISOString(),lastDaily:null};await set(userKey(id),u);}return u;}
async function ledger(id,item){await redis(["LPUSH","norka:ledger:"+id,JSON.stringify({...item,at:new Date().toISOString()})]);await redis(["LTRIM","norka:ledger:"+id,"0","99"]);}
async function updateBalances(id,berryDelta,coinDelta){const script="local b=tonumber(redis.call('HGET',KEYS[1],'berries') or '0'); local c=tonumber(redis.call('HGET',KEYS[1],'coins') or '0'); local db=tonumber(ARGV[1]); local dc=tonumber(ARGV[2]); if b+db<0 or c+dc<0 then return {err='INSUFFICIENT'} end; redis.call('HSET',KEYS[1],'berries',b+db,'coins',c+dc); return {b+db,c+dc}";const raw=await redis(["EVAL",script,"1","norka:wallet:"+id,String(berryDelta),String(coinDelta)]);if(!raw||raw.error)throw new Error("Wallet update failed");return {berries:Number(raw[0]),coins:Number(raw[1])};}
async function readWallet(id){let w=await redis(["HGETALL","norka:wallet:"+id]);if(!Array.isArray(w)||!w.length)return {berries:0,coins:0};const o={};for(let i=0;i<w.length;i+=2)o[w[i]]=Number(w[i+1]);return {berries:o.berries||0,coins:o.coins||0};}
async function list(key){const ids=await redis(["LRANGE",key,"0","99"]);return Array.isArray(ids)?ids.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean):[];}
async function admin(req){const expected=process.env.NORKA_ADMIN_PASSWORD;if(!expected)return false;const supplied=clean(req.headers["x-norka-admin"]||req.body?.adminPassword,300);return supplied===expected;}
const DEFAULT_TASKS=[{id:"daily",title:"Ежедневный визит",description:"Заглядывай в Норку каждый день",reward:10,type:"daily",active:true},{id:"channel",title:"Подписка на канал",description:"Подпишись на канал Норки и отправь заявку на проверку",reward:30,type:"subscription",url:process.env.NORKA_CHANNEL_URL||"",active:true}];
async function tasks(){return (await get("norka:tasks"))||DEFAULT_TASKS;}
async function giveaways(){return await list("norka:giveaways");}
module.exports=async function handler(req,res){
 if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-InitData,X-Norka-Admin");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");return res.status(204).end();}
 res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-User,X-Norka-Admin");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
 if(!["GET","POST"].includes(req.method))return json(res,405,{ok:false,error:"Method not allowed"});
 try{
  const body=req.body&&typeof req.body==="object"?req.body:{};const action=clean(req.method==="GET"?req.query?.action:body.action,60);
  if(action.startsWith("admin_")){
   if(!(await admin(req)))return json(res,401,{ok:false,error:"Неверный пароль администратора"});
   if(action==="admin_overview"){const ids=await redis(["KEYS","norka:user:*"]);const users=Array.isArray(ids)?ids.length:0;const pending=await list("norka:pending");const rate=Number(await redis(["GET","norka:exchange-rate"]))||100;return json(res,200,{ok:true,users,pending,giveaways:await giveaways(),tasks:await tasks(),rate});}
   if(action==="admin_set_rate"){const rate=Math.floor(Number(body.rate));if(!Number.isFinite(rate)||rate<1||rate>100000)return json(res,400,{ok:false,error:"Курс должен быть от 1 до 100000 ягод"});await redis(["SET","norka:exchange-rate",String(rate)]);return json(res,200,{ok:true,rate});}
   if(action==="admin_create_giveaway"){const item={id:"g"+Date.now(),title:clean(body.title,100),description:clean(body.description,500),prize:clean(body.prize,120),cost:Math.max(1,Math.min(100000,Number(body.cost)||1)),endsAt:clean(body.endsAt,40),status:"active",createdAt:new Date().toISOString(),entries:0};if(!item.title||!item.prize)return json(res,400,{ok:false,error:"Заполните название и приз"});await redis(["LPUSH","norka:giveaways",JSON.stringify(item)]);return json(res,200,{ok:true,item});}
   if(action==="admin_save_tasks"){if(!Array.isArray(body.tasks))return json(res,400,{ok:false,error:"Некорректные задания"});const safe=body.tasks.slice(0,30).map(t=>({id:clean(t.id,40),title:clean(t.title,100),description:clean(t.description,250),reward:Math.max(0,Math.min(10000,Number(t.reward)||0)),type:["daily","subscription","activity"].includes(t.type)?t.type:"activity",url:clean(t.url,500),active:Boolean(t.active)}));await set("norka:tasks",safe);return json(res,200,{ok:true,tasks:safe});}
   if(action==="admin_approve_task"){const id=clean(body.userId,80),taskId=clean(body.taskId,50);if(!id||!taskId)return json(res,400,{ok:false,error:"Нет пользователя или задания"});const pending=await list("norka:pending");const p=pending.find(x=>x.userId===id&&x.taskId===taskId);if(!p)return json(res,404,{ok:false,error:"Заявка не найдена"});const approved=await redis(["SET","norka:taskapproved:"+id+":"+taskId,"1","NX","EX","31536000"]);if(approved!=="OK")return json(res,409,{ok:false,error:"Задание уже подтверждено"});const ts=await tasks();const t=ts.find(x=>x.id===taskId);if(!t)return json(res,404,{ok:false,error:"Задание не найдено"});await ensureUser(id);const w=await updateBalances(id,Number(t.reward),0);await ledger(id,{type:"task_reward",title:"Награда: "+t.title,berries:Number(t.reward)});const claims=await get("norka:claims:"+id)||{};claims[taskId]="done";await set("norka:claims:"+id,claims);await redis(["LREM","norka:pending","1",JSON.stringify(p)]);return json(res,200,{ok:true,wallet:w});}
   return json(res,400,{ok:false,error:"Неизвестное действие"});
  }
  const verified=verifyInitData(req);if(!verified)return json(res,401,{ok:false,error:"Не удалось проверить данные MAX. Перезапусти мини-приложение."});
  const id=verified.id;const profile=verified.profile;await ensureUser(id,profile);
  if(action==="bootstrap"){const u=await get(userKey(id));const w=await readWallet(id);const history=await list("norka:ledger:"+id);const ts=(await tasks()).filter(t=>t.active);const gs=(await giveaways()).filter(g=>g.status==="active");const claims=await get("norka:claims:"+id)||{};const rate=Number(await redis(["GET","norka:exchange-rate"]))||100;return json(res,200,{ok:true,user:u,wallet:w,tasks:ts,giveaways:gs,history,claims,rate});}
  if(action==="daily_claim"){const u=await get(userKey(id));const day=new Date().toISOString().slice(0,10);if(u.lastDaily===day)return json(res,409,{ok:false,error:"Награда за сегодня уже получена"});const dailyLock=await redis(["SET","norka:daily:"+id+":"+day,"1","NX","EX","172800"]);if(dailyLock!=="OK")return json(res,409,{ok:false,error:"Награда за сегодня уже получена"});const t=(await tasks()).find(x=>x.type==="daily"&&x.active);const reward=t?Number(t.reward):10;const w=await updateBalances(id,reward,0);u.lastDaily=day;await set(userKey(id),u);await ledger(id,{type:"daily",title:"Ежедневная награда",berries:reward});return json(res,200,{ok:true,wallet:w,reward});}
  if(action==="request_task"){const taskId=clean(body.taskId,50);const ts=await tasks();const t=ts.find(x=>x.id===taskId&&x.active&&x.type!=="daily");if(!t)return json(res,404,{ok:false,error:"Задание не найдено"});const claims=await get("norka:claims:"+id)||{};if(claims[taskId])return json(res,409,{ok:false,error:"Задание уже отправлено или выполнено"});const taskLock=await redis(["SET","norka:taskclaim:"+id+":"+taskId,"1","NX","EX","31536000"]);if(taskLock!=="OK")return json(res,409,{ok:false,error:"Задание уже отправлено или выполнено"});const p={userId:id,taskId,title:t.title,name:clean(profile.name,100),at:new Date().toISOString()};await redis(["LPUSH","norka:pending",JSON.stringify(p)]);claims[taskId]="pending";await set("norka:claims:"+id,claims);return json(res,200,{ok:true,message:"Заявка отправлена на проверку"});}
  if(action==="exchange"){const rate=Number(await redis(["GET","norka:exchange-rate"]))||100;const amount=Math.max(1,Math.min(100000,Math.floor(Number(body.berries)||0)));if(amount<rate)return json(res,400,{ok:false,error:"Минимум для обмена — "+rate+" ягод"});const coins=Math.floor(amount/rate);const spent=coins*rate;const w=await updateBalances(id,-spent,coins);await ledger(id,{type:"exchange",title:"Обмен ягод на монеты",berries:-spent,coins});return json(res,200,{ok:true,wallet:w,coins});}
  if(action==="enter_giveaway"){const giveawayId=clean(body.giveawayId,60);const gs=await giveaways();const g=gs.find(x=>x.id===giveawayId&&x.status==="active");if(!g)return json(res,404,{ok:false,error:"Розыгрыш не найден"});if(g.endsAt&&Date.now()>new Date(g.endsAt).getTime())return json(res,409,{ok:false,error:"Срок участия завершён"});const script="if redis.call('SISMEMBER',KEYS[1],ARGV[1])==1 then return redis.error_reply('ALREADY') end; local c=tonumber(redis.call('HGET',KEYS[2],'coins') or '0'); local cost=tonumber(ARGV[2]); if c<cost then return redis.error_reply('INSUFFICIENT') end; redis.call('HSET',KEYS[2],'coins',c-cost); redis.call('SADD',KEYS[1],ARGV[1]); redis.call('HINCRBY',KEYS[3],ARGV[3],1); return {c-cost}";await redis(["EVAL",script,"3","norka:entries:"+giveawayId,"norka:wallet:"+id,"norka:giveaway-counts",id,String(g.cost),giveawayId]);const w=await readWallet(id);await ledger(id,{type:"giveaway_entry",title:"Участие: "+g.title,coins:-Number(g.cost)});return json(res,200,{ok:true,wallet:w});}
  return json(res,400,{ok:false,error:"Неизвестное действие"});
 }catch(e){const msg=String(e&&e.message||"Ошибка сервера");if(msg.includes("INSUFFICIENT"))return json(res,409,{ok:false,error:"Недостаточно средств на балансе"});if(msg.includes("ALREADY"))return json(res,409,{ok:false,error:"Ты уже участвуешь в этом розыгрыше"});console.error("NORKA API:",msg);return json(res,500,{ok:false,error:"Внутренняя ошибка. Проверьте настройки Redis в Vercel."});}
};