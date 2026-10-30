const { createHmac, timingSafeEqual, randomInt } = require("crypto");
const { requestMax } = require("../lib/max-api");

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
  if(age>3600||age< -60)return null;
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
const DEFAULT_TASKS=[{id:"daily",title:"Ежедневный визит",description:"Заглядывай в Норку каждый день",reward:10,type:"daily",active:true},{id:"channel",title:"Подписка на канал",description:"Подпишись на канал Норки и отправь заявку на проверку",reward:30,type:"subscription",url:process.env.NORKA_CHANNEL_URL||"https://max.ru/join/L_PrwMy9zacHRuwZDM8NF49IhSs_p_XpLuXUfzjXEpk",active:true}];
async function tasks(){const saved=await get("norka:tasks");if(!Array.isArray(saved))return DEFAULT_TASKS;const out=saved.slice();const base=DEFAULT_TASKS.find(t=>t.id==="channel");const index=out.findIndex(t=>t.id==="channel");if(index<0)out.push(base);else if(!out[index].url)out[index]={...out[index],url:base.url};return out;}

const DEFAULT_PROGRESS_CONFIG={
 xp:{visit:2,daily:5,task:20,exchange:3,giveaway:5},
 thresholds:[0,100,250,450,700,1000,1400,1900,2500,3200,4000],
 streakRewards:{"3":10,"7":30,"14":70,"30":200},
 levelRewards:{"5":25,"10":75},
 achievementRewards:{}
};
async function progressConfig(){
 const saved=await get("norka:progress:config");
 if(!saved||typeof saved!=="object")return DEFAULT_PROGRESS_CONFIG;
 return {
  xp:{...DEFAULT_PROGRESS_CONFIG.xp,...(saved.xp||{})},
  thresholds:Array.isArray(saved.thresholds)&&saved.thresholds.length>=2?saved.thresholds:DEFAULT_PROGRESS_CONFIG.thresholds,
  streakRewards:{...DEFAULT_PROGRESS_CONFIG.streakRewards,...(saved.streakRewards||{})},
  levelRewards:{...DEFAULT_PROGRESS_CONFIG.levelRewards,...(saved.levelRewards||{})},
  achievementRewards:{...(saved.achievementRewards||{})}
 };
}
async function notifyUser(id,eventId,message){try{const key="norka:notify:sent:"+id+":"+eventId;if(await redis(["GET",key]))return;const token=process.env.MAX_BOT_TOKEN;if(!token)return;const sent=await requestMax({token,method:"POST",apiPath:"/messages?user_id="+encodeURIComponent(String(id)),body:{text:message}});if(sent.ok)await redis(["SET",key,"1","EX","2592000"]);else console.error("NORKA notification rejected:",sent.status);}catch(error){console.error("NORKA notification failed:",error&&error.message||"unknown");}}
async function grantProgress(id,eventId,kind,day){
 const config=await progressConfig(),xp=Math.max(0,Math.floor(Number(config.xp[kind])||0));
 const thresholds=config.thresholds.map(x=>Math.max(0,Math.floor(Number(x)||0)));
 if(thresholds[0]!==0||thresholds.some((x,i)=>i>0&&x<=thresholds[i-1]))throw new Error("Invalid progress thresholds");
 const script=[
  "local raw=redis.call('GET',KEYS[1]); local p=raw and cjson.decode(raw) or {xp=0,level=1,streak=0,bestStreak=0,lastVisit='',lastVisitAt=''};",
  "if redis.call('SISMEMBER',KEYS[4],ARGV[1])==1 then return {0,p.xp or 0,p.level or 1,p.streak or 0,0,0,p.level or 1} end;",
  "local today=ARGV[2]; local kind=ARGV[3]; local oldLevel=tonumber(p.level) or 1;",
  "if kind=='visit' then if p.lastVisit~=today then local y=ARGV[9]; if p.lastVisit==y then p.streak=(tonumber(p.streak) or 0)+1 else p.streak=1 end; p.lastVisit=today; p.lastVisitAt=ARGV[8]; if p.streak>(tonumber(p.bestStreak) or 0) then p.bestStreak=p.streak end end end;",
  "p.xp=(tonumber(p.xp) or 0)+tonumber(ARGV[4]);",
  "local thresholds=cjson.decode(ARGV[5]); local level=1; for i=1,#thresholds do if p.xp>=tonumber(thresholds[i]) then level=i end end; p.level=level;",
  "redis.call('SADD',KEYS[4],ARGV[1]);",
  "local unlocked={}; local function achievement(a) if redis.call('SADD',KEYS[5],a)==1 then table.insert(unlocked,a) end end;",
  "if kind=='visit' then achievement('first_visit') end; if kind=='daily' then achievement('first_daily') end; if kind=='task' then achievement('first_task') end; if kind=='exchange' then achievement('first_exchange') end; if kind=='giveaway' then achievement('first_giveaway') end;",
  "local berries=0; local ledger={}; local streakRewards=cjson.decode(ARGV[6]);",
  "if kind=='visit' then local milestones={3,7,14,30}; for _,m in ipairs(milestones) do if tonumber(p.streak)==m and redis.call('SADD',KEYS[6],tostring(m))==1 then local reward=tonumber(streakRewards[tostring(m)]) or 0; if reward>0 then berries=berries+reward; table.insert(ledger,cjson.encode({type='streak_reward',title='Награда за серию '..m..' дней',berries=reward,at=ARGV[8]})) end; achievement('streak_'..m) end end end;",
  "local levelRewards=cjson.decode(ARGV[7]); for l=oldLevel+1,level do local reward=tonumber(levelRewards[tostring(l)]) or 0; if reward>0 and redis.call('SADD',KEYS[7],tostring(l))==1 then berries=berries+reward; table.insert(ledger,cjson.encode({type='level_reward',title='Награда за уровень '..l,berries=reward,at=ARGV[8]})) end; if l==5 or l==10 then achievement('level_'..l) end end;",
  "if berries>0 then redis.call('HINCRBY',KEYS[2],'berries',berries); for _,item in ipairs(ledger) do redis.call('LPUSH',KEYS[3],item) end; redis.call('LTRIM',KEYS[3],'0','99') end;",
  "redis.call('SET',KEYS[1],cjson.encode(p)); return {1,p.xp,p.level,p.streak,berries,#unlocked,oldLevel}"
 ].join(" ");
 const result=await redis(["EVAL",script,"7","norka:progress:"+id,"norka:wallet:"+id,"norka:ledger:"+id,"norka:progress:events:"+id,"norka:achievements:"+id,"norka:streak:rewards:"+id,"norka:level:rewards:"+id,eventId,day,kind,String(xp),JSON.stringify(thresholds),JSON.stringify(config.streakRewards),JSON.stringify(config.levelRewards),new Date().toISOString(),new Date(Date.parse(day+"T00:00:00Z")-86400000).toISOString().slice(0,10)]);
 const progress={applied:Number(result[0])===1,xp:Number(result[1])||0,level:Number(result[2])||1,streak:Number(result[3])||0,berries:Number(result[4])||0};if(progress.applied&&(progress.berries>0||Number(result[5])>0||progress.level>Number(result[6])))await notifyUser(id,"progress:"+eventId,"🌿 Отличная работа в Норке!\nУровень: "+progress.level+" · Опыт: "+progress.xp+" XP\nСерия: "+progress.streak+" дней\n"+(progress.berries>0?"🍓 Начислено ягод: "+progress.berries:"Новое достижение открыто!"));return progress;
}
async function readProgress(id){
 const p=await get("norka:progress:"+id)||{xp:0,level:1,streak:0,bestStreak:0,lastVisit:""};
 const achievements=await redis(["SMEMBERS","norka:achievements:"+id]);
 const config=await progressConfig(),thresholds=config.thresholds;
 const level=Math.max(1,Number(p.level)||1),current=Number(thresholds[level-1])||0,next=Number(thresholds[level])||current;
 return {...p,level,currentLevelXp:current,nextLevelXp:next,levelProgress:next>current?Math.max(0,Math.min(100,Math.round((Number(p.xp)-current)/(next-current)*100))):100,achievements:Array.isArray(achievements)?achievements:[],thresholds};
}
async function giveaways(){const items=await list("norka:giveaways");await Promise.all(items.map(async item=>{item.entries=Number(await redis(["HGET","norka:giveaway-counts",item.id]))||0;}));return items;}
module.exports=async function handler(req,res){
 if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-InitData,X-Norka-Admin");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");return res.status(204).end();}
 res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-InitData,X-Norka-Admin");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
 if(!["GET","POST"].includes(req.method))return json(res,405,{ok:false,error:"Method not allowed"});
 try{
  const body=req.body&&typeof req.body==="object"?req.body:{};const action=clean(req.method==="GET"?req.query?.action:body.action,60);
  if(action.startsWith("admin_")){
   if(!(await admin(req)))return json(res,401,{ok:false,error:"Неверный пароль администратора"});
   if(action==="admin_setup_channel_tracking"){
    const token=process.env.MAX_BOT_TOKEN,secret=process.env.MAX_WEBHOOK_SECRET;
    if(!token||!secret)return json(res,503,{ok:false,error:"Не настроены MAX_BOT_TOKEN или MAX_WEBHOOK_SECRET"});
    const webhookUrl=process.env.NORKA_WEBHOOK_URL||"https://franshiza.vercel.app/api/webhook";
    const r=await requestMax({token,method:"POST",apiPath:"/subscriptions",body:{url:webhookUrl,update_types:["bot_added","bot_removed","bot_started","message_created","user_added","user_removed"],secret}});
    if(!r.ok)return json(res,502,{ok:false,error:"MAX не принял подписку на события",details:r.data||r.raw});
    return json(res,200,{ok:true,message:"Подписка на события MAX обновлена",webhookUrl});
   }
   if(action==="admin_overview"){const ids=await redis(["KEYS","norka:user:*"]);const users=Array.isArray(ids)?ids.length:0;const pending=await list("norka:pending");const rate=Number(await redis(["GET","norka:exchange-rate"]))||100;return json(res,200,{ok:true,users,pending,giveaways:await giveaways(),tasks:await tasks(),rate,progressConfig:await progressConfig()});}
   if(action==="admin_progress_config"){return json(res,200,{ok:true,config:await progressConfig()});}
   if(action==="admin_save_progress_config"){
    const input=body.config&&typeof body.config==="object"?body.config:{},xp=input.xp&&typeof input.xp==="object"?input.xp:{};
    const safeXp={};for(const key of ["visit","daily","task","exchange","giveaway"]){const n=Number(xp[key]);if(!Number.isInteger(n)||n<0||n>1000)return json(res,400,{ok:false,error:"XP для каждого действия должен быть от 0 до 1000"});safeXp[key]=n;}
    const thresholds=Array.isArray(input.thresholds)?input.thresholds.map(Number):[];
    if(thresholds.length<2||thresholds.length>50||thresholds[0]!==0||thresholds.some((n,i)=>!Number.isInteger(n)||n<0||n>100000000||(i>0&&n<=thresholds[i-1])))return json(res,400,{ok:false,error:"Пороги уровней должны возрастать, начинаться с нуля и содержать не более 50 значений"});
    const cleanRewards=source=>{const out={};if(source&&typeof source==="object")for(const [key,value] of Object.entries(source)){const n=Number(value);if(/^\d+$/.test(key)&&Number.isInteger(n)&&n>=0&&n<=100000)out[key]=n;}return out;};
    const config={xp:safeXp,thresholds,streakRewards:cleanRewards(input.streakRewards),levelRewards:cleanRewards(input.levelRewards),achievementRewards:{}};
    await set("norka:progress:config",config);return json(res,200,{ok:true,config});
   }
   if(action==="admin_set_rate"){const rate=Math.floor(Number(body.rate));if(!Number.isFinite(rate)||rate<1||rate>100000)return json(res,400,{ok:false,error:"Курс должен быть от 1 до 100000 ягод"});await redis(["SET","norka:exchange-rate",String(rate)]);return json(res,200,{ok:true,rate});}
   if(action==="admin_draw_winner"){
    const giveawayId=clean(body.giveawayId,60);
    const freezeScript=[
     "local n=redis.call('LLEN',KEYS[1]);",
     "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local item=cjson.decode(raw);",
     "if tostring(item.id)==ARGV[1] then if item.status=='completed' then return redis.error_reply('DRAW_ALREADY') end;",
     "if item.status=='active' then item.status='drawing'; redis.call('LSET',KEYS[1],i,cjson.encode(item)); return 1 end;",
     "if item.status=='drawing' then return 1 end; return redis.error_reply('DRAW_ALREADY') end end end;",
     "return redis.error_reply('NOT_FOUND')"
    ].join(" ");
    await redis(["EVAL",freezeScript,"1","norka:giveaways",giveawayId]);
    const entrants=await redis(["SMEMBERS","norka:entries:"+giveawayId]);
    if(!Array.isArray(entrants)||!entrants.length){
     const restoreScript="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local item=cjson.decode(raw); if tostring(item.id)==ARGV[1] and item.status=='drawing' then item.status='active'; redis.call('LSET',KEYS[1],i,cjson.encode(item)); return 1 end end end; return 0";
     await redis(["EVAL",restoreScript,"1","norka:giveaways",giveawayId]);
     return json(res,409,{ok:false,error:"В розыгрыше пока нет участников"});
    }
    const winnerId=String(entrants[randomInt(entrants.length)]),drawnAt=new Date().toISOString();
    const finishScript=[
     "local n=redis.call('LLEN',KEYS[1]);",
     "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local item=cjson.decode(raw);",
     "if tostring(item.id)==ARGV[1] then if item.status~='drawing' then return redis.error_reply('DRAW_ALREADY') end;",
     "item.status='completed'; item.winnerId=ARGV[2]; item.drawnAt=ARGV[3]; redis.call('LSET',KEYS[1],i,cjson.encode(item)); return 1 end end end;",
     "return redis.error_reply('NOT_FOUND')"
    ].join(" ");
    await redis(["EVAL",finishScript,"1","norka:giveaways",giveawayId,winnerId,drawnAt]);
    const item=(await giveaways()).find(x=>x.id===giveawayId);await notifyUser(winnerId,"giveaway-winner:"+giveawayId,"🏆 Поздравляем! Ты победил в розыгрыше «"+(item?.title||"Норка")+"»!\n🎁 Приз: "+(item?.prize||"уточни у организатора")); 
    return json(res,200,{ok:true,winnerId,title:item?.title||"",prize:item?.prize||"",entries:entrants.length});
   }
   if(action==="admin_create_giveaway"){const cost=Number(body.cost),endsAt=clean(body.endsAt,40);if(!clean(body.title,100)||!clean(body.prize,120))return json(res,400,{ok:false,error:"Заполните название и приз"});if(!Number.isInteger(cost)||cost<1||cost>100000)return json(res,400,{ok:false,error:"Стоимость участия должна быть от 1 до 100000 монет"});if(endsAt&&(!Number.isFinite(new Date(endsAt).getTime())||new Date(endsAt).getTime()<=Date.now()))return json(res,400,{ok:false,error:"Укажите корректный срок завершения в будущем"});const item={id:"g"+Date.now()+"_"+randomInt(100000,999999),title:clean(body.title,100),description:clean(body.description,500),prize:clean(body.prize,120),cost,endsAt,status:"active",createdAt:new Date().toISOString(),entries:0};await redis(["LPUSH","norka:giveaways",JSON.stringify(item)]);return json(res,200,{ok:true,item});}
   if(action==="admin_save_tasks"){if(!Array.isArray(body.tasks))return json(res,400,{ok:false,error:"Некорректные задания"});const safe=body.tasks.slice(0,30).map(t=>({id:clean(t.id,40),title:clean(t.title,100),description:clean(t.description,250),reward:Math.max(0,Math.min(10000,Number(t.reward)||0)),type:["daily","subscription","activity"].includes(t.type)?t.type:"activity",url:clean(t.url,500),active:Boolean(t.active)}));await set("norka:tasks",safe);return json(res,200,{ok:true,tasks:safe});}
   if(action==="admin_approve_task"){
   const id=clean(body.userId,80),taskId=clean(body.taskId,50);
   if(!id||!taskId)return json(res,400,{ok:false,error:"Нет пользователя или задания"});
   const pending=await list("norka:pending"),p=pending.find(x=>x.userId===id&&x.taskId===taskId);
   if(!p)return json(res,404,{ok:false,error:"Заявка не найдена"});
   const ts=await tasks(),t=ts.find(x=>x.id===taskId);
   if(!t)return json(res,404,{ok:false,error:"Задание не найдено"});
   await ensureUser(id);
   const reward=Math.max(0,Math.floor(Number(t.reward)||0)),now=new Date().toISOString();
   const ledgerItem=JSON.stringify({type:"task_reward",title:"Награда: "+t.title,berries:reward,at:now});
   const script=[
    "if redis.call('GET',KEYS[1]) then return redis.error_reply('TASK_ALREADY') end;",
    "local claimsRaw=redis.call('GET',KEYS[4]); local claims={}; if claimsRaw then claims=cjson.decode(claimsRaw) end;",
    "if claims[ARGV[2]]=='done' then return redis.error_reply('TASK_ALREADY') end;",
    "local current=tonumber(redis.call('HGET',KEYS[2],'berries') or '0');",
    "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[1]));",
    "redis.call('SET',KEYS[1],'1','EX','31536000');",
    "claims[ARGV[2]]='done'; redis.call('SET',KEYS[4],cjson.encode(claims));",
    "redis.call('LPUSH',KEYS[3],ARGV[3]); redis.call('LTRIM',KEYS[3],'0','99');",
    "redis.call('LREM',KEYS[5],'1',ARGV[4]);",
    "return {current+tonumber(ARGV[1]),tonumber(redis.call('HGET',KEYS[2],'coins') or '0')}"
   ].join(" ");
   const result=await redis(["EVAL",script,"5","norka:taskapproved:"+id+":"+taskId,"norka:wallet:"+id,"norka:ledger:"+id,"norka:claims:"+id,"norka:pending",String(reward),taskId,ledgerItem,JSON.stringify(p)]);
   await grantProgress(id,"task:"+taskId,"task",new Date().toISOString().slice(0,10));await notifyUser(id,"task-approved:"+taskId,"✅ Твоё задание «"+t.title+"» подтверждено!\n🍓 Начислено ягод: "+reward);return json(res,200,{ok:true,wallet:await readWallet(id),progress:await readProgress(id)});
  }
   return json(res,400,{ok:false,error:"Неизвестное действие"});
  }
  const verified=verifyInitData(req);if(!verified)return json(res,401,{ok:false,error:"Не удалось проверить данные MAX. Перезапусти мини-приложение."});
  const id=verified.id;const profile=verified.profile;await ensureUser(id,profile);
  if(action==="bootstrap"){const day=new Date().toISOString().slice(0,10);await grantProgress(id,"visit:"+day,"visit",day);const u=await get(userKey(id));if(u?.lastDaily)await grantProgress(id,"daily:"+u.lastDaily,"daily",u.lastDaily);const w=await readWallet(id);const history=await list("norka:ledger:"+id);const ts=(await tasks()).filter(t=>t.active);const gs=(await giveaways()).filter(g=>g.status==="active");await Promise.all(gs.map(async g=>{g.joined=Number(await redis(["SISMEMBER","norka:entries:"+g.id,id]))===1;}));const claims=await get("norka:claims:"+id)||{};const rate=Number(await redis(["GET","norka:exchange-rate"]))||100;const progress=await readProgress(id);return json(res,200,{ok:true,user:u,wallet:w,tasks:ts,giveaways:gs,history,claims,rate,progress});}
  if(action==="daily_claim"){
   const day=new Date().toISOString().slice(0,10),t=(await tasks()).find(x=>x.type==="daily"&&x.active);
   const reward=t?Math.max(0,Math.floor(Number(t.reward)||0)):10,now=new Date().toISOString();
   const ledgerItem=JSON.stringify({type:"daily",title:"Ежедневная награда",berries:reward,at:now});
   const script=[
    "local raw=redis.call('GET',KEYS[1]); if not raw then return redis.error_reply('USER_NOT_FOUND') end;",
    "if redis.call('GET',KEYS[4]) then return redis.error_reply('DAILY_ALREADY') end;",
    "local user=cjson.decode(raw); if user.lastDaily==ARGV[1] then return redis.error_reply('DAILY_ALREADY') end;",
    "local current=tonumber(redis.call('HGET',KEYS[2],'berries') or '0');",
    "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[2]));",
    "user.lastDaily=ARGV[1]; redis.call('SET',KEYS[1],cjson.encode(user));",
    "redis.call('SET',KEYS[4],'1','EX','172800');",
    "redis.call('LPUSH',KEYS[3],ARGV[3]); redis.call('LTRIM',KEYS[3],'0','99');",
    "return {current+tonumber(ARGV[2]),tonumber(redis.call('HGET',KEYS[2],'coins') or '0')}"
   ].join(" ");
   const result=await redis(["EVAL",script,"4",userKey(id),"norka:wallet:"+id,"norka:ledger:"+id,"norka:daily:"+id+":"+day,day,String(reward),ledgerItem]);
   await grantProgress(id,"daily:"+day,"daily",day);const wallet=await readWallet(id);return json(res,200,{ok:true,wallet,reward,progress:await readProgress(id)});
  }
  if(action==="check_subscription"){
   const t=(await tasks()).find(x=>x.id==="channel"&&x.active&&x.type==="subscription");
   if(!t)return json(res,404,{ok:false,error:"Задание на подписку не найдено"});
   const channelId=await redis(["GET","norka:channel:chat_id"]);
   if(!channelId)return json(res,503,{ok:false,error:"ID канала ещё не получен от MAX. Напиши администратору."});
   const check=await requestMax({token:process.env.MAX_BOT_TOKEN,apiPath:"/chats/"+encodeURIComponent(String(channelId))+"/members?user_ids="+encodeURIComponent(id)});
   if(!check.ok)return json(res,502,{ok:false,error:"MAX не смог проверить подписку. Проверь права бота-администратора.",details:check.data||check.raw});
   const members=Array.isArray(check.data?.members)?check.data.members:[];
   if(!members.some(m=>String(m.user_id)===id))return json(res,409,{ok:false,error:"Подписка пока не найдена. Подпишись на канал и нажми «Проверить» ещё раз."});
   const reward=Math.max(0,Math.floor(Number(t.reward)||0)),now=new Date().toISOString();
   const ledgerItem=JSON.stringify({type:"task_reward",title:"Награда: "+t.title,berries:reward,at:now});
   const script=[
    "if redis.call('GET',KEYS[1]) or redis.call('GET',KEYS[5]) then return redis.error_reply('SUBSCRIPTION_ALREADY') end;",
    "local claimsRaw=redis.call('GET',KEYS[4]); local claims={}; if claimsRaw then claims=cjson.decode(claimsRaw) end;",
    "if claims[ARGV[1]]=='done' then return redis.error_reply('SUBSCRIPTION_ALREADY') end;",
    "local current=tonumber(redis.call('HGET',KEYS[2],'berries') or '0');",
    "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[2]));",
    "redis.call('SET',KEYS[1],'1','EX','31536000');",
    "claims[ARGV[1]]='done'; redis.call('SET',KEYS[4],cjson.encode(claims));",
    "redis.call('LPUSH',KEYS[3],ARGV[3]); redis.call('LTRIM',KEYS[3],'0','99');",
    "return {current+tonumber(ARGV[2]),tonumber(redis.call('HGET',KEYS[2],'coins') or '0')}"
   ].join(" ");
   const result=await redis(["EVAL",script,"5","norka:taskclaim:"+id+":channel","norka:wallet:"+id,"norka:ledger:"+id,"norka:claims:"+id,"norka:taskapproved:"+id+":channel","channel",String(reward),ledgerItem]);
   await grantProgress(id,"task:channel","task",new Date().toISOString().slice(0,10));return json(res,200,{ok:true,wallet:await readWallet(id),reward,claims:{channel:"done"},progress:await readProgress(id)});
  }
  if(action==="request_task"){
   const taskId=clean(body.taskId,50),ts=await tasks(),t=ts.find(x=>x.id===taskId&&x.id!=="channel"&&x.active&&x.type!=="daily");
   if(!t)return json(res,404,{ok:false,error:"Задание не найдено"});
   const claims=await get("norka:claims:"+id)||{};
   if(claims[taskId])return json(res,409,{ok:false,error:"Задание уже отправлено или выполнено"});
   const p={userId:id,taskId,title:t.title,name:clean(profile.name,100),at:new Date().toISOString()};
   const script=[
    "if redis.call('GET',KEYS[1]) then return redis.error_reply('TASK_ALREADY') end;",
    "local raw=redis.call('GET',KEYS[2]); local claims={}; if raw then claims=cjson.decode(raw) end;",
    "if claims[ARGV[1]] then return redis.error_reply('TASK_ALREADY') end;",
    "redis.call('SET',KEYS[1],'1','NX','EX','31536000');",
    "claims[ARGV[1]]='pending'; redis.call('SET',KEYS[2],cjson.encode(claims));",
    "redis.call('LPUSH',KEYS[3],ARGV[2]); return 1"
   ].join(" ");
   await redis(["EVAL",script,"3","norka:taskclaim:"+id+":"+taskId,"norka:claims:"+id,"norka:pending",taskId,JSON.stringify(p)]);
   return json(res,200,{ok:true,message:"Заявка отправлена на проверку"});
  }
  if(action==="exchange"){
   const rate=Number(await redis(["GET","norka:exchange-rate"]))||100,amount=Math.floor(Number(body.berries)||0),requestId=clean(body.requestId,80);
   if(!requestId||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))return json(res,400,{ok:false,error:"Не удалось идентифицировать операцию обмена. Повтори попытку."});
   if(!Number.isFinite(amount)||amount<rate||amount>100000)return json(res,400,{ok:false,error:"Укажи количество ягод от "+rate+" до 100000"});
   const coins=Math.floor(amount/rate),spent=coins*rate,now=new Date().toISOString();
   const ledgerItem=JSON.stringify({type:"exchange",title:"Обмен ягод на монеты",berries:-spent,coins,at:now});
   const script=[
    "local previous=redis.call('GET',KEYS[3]); if previous then local result=cjson.decode(previous); return {tonumber(result.berries),tonumber(result.coins),0} end;",
    "local b=tonumber(redis.call('HGET',KEYS[1],'berries') or '0'); local c=tonumber(redis.call('HGET',KEYS[1],'coins') or '0');",
    "local db=tonumber(ARGV[1]); local dc=tonumber(ARGV[2]); if b+db<0 then return redis.error_reply('INSUFFICIENT') end;",
    "redis.call('HSET',KEYS[1],'berries',b+db,'coins',c+dc);",
    "redis.call('LPUSH',KEYS[2],ARGV[3]); redis.call('LTRIM',KEYS[2],'0','99');",
    "local result={berries=b+db,coins=c+dc}; redis.call('SET',KEYS[3],cjson.encode(result),'EX','86400');",
    "return {result.berries,result.coins,1}"
   ].join(" ");
   const result=await redis(["EVAL",script,"3","norka:wallet:"+id,"norka:ledger:"+id,"norka:exchange:request:"+id+":"+requestId,String(-spent),String(coins),ledgerItem]);
   await grantProgress(id,"exchange:"+requestId,"exchange",new Date().toISOString().slice(0,10));return json(res,200,{ok:true,wallet:{berries:Number(result[0])||0,coins:Number(result[1])||0},coins,duplicate:Number(result[2])===0,progress:await readProgress(id)});
  }
  if(action==="enter_giveaway"){
   const giveawayId=clean(body.giveawayId,60),gs=await giveaways(),g=gs.find(x=>x.id===giveawayId&&x.status==="active");
   if(!g)return json(res,404,{ok:false,error:"Розыгрыш не найден"});
   const endMs=g.endsAt?new Date(g.endsAt).getTime():0;
   if(g.endsAt&&(!Number.isFinite(endMs)||Date.now()>endMs))return json(res,409,{ok:false,error:"Срок участия завершён"});
   const cost=Math.floor(Number(g.cost)||0);
   if(cost<1)return json(res,409,{ok:false,error:"Некорректная стоимость участия"});
   const now=new Date().toISOString(),ledgerItem=JSON.stringify({type:"giveaway_entry",title:"Участие: "+g.title,coins:-cost,at:now});
   const script=[
    "local n=redis.call('LLEN',KEYS[5]); local found=false;",
    "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[5],i); if raw then local item=cjson.decode(raw);",
    "if tostring(item.id)==ARGV[3] then found=true; if item.status~='active' then return redis.error_reply('CLOSED') end;",
    "local endMs=tonumber(ARGV[4]) or 0; if endMs>0 and tonumber(ARGV[5])>endMs then return redis.error_reply('CLOSED') end; break end end end;",
    "if not found then return redis.error_reply('NOT_FOUND') end;",
    "if redis.call('SISMEMBER',KEYS[1],ARGV[1])==1 then return redis.error_reply('ALREADY') end;",
    "local c=tonumber(redis.call('HGET',KEYS[2],'coins') or '0'); local cost=tonumber(ARGV[2]);",
    "if c<cost then return redis.error_reply('INSUFFICIENT') end;",
    "redis.call('HSET',KEYS[2],'coins',c-cost); redis.call('SADD',KEYS[1],ARGV[1]);",
    "redis.call('HINCRBY',KEYS[3],ARGV[3],1);",
    "redis.call('LPUSH',KEYS[4],ARGV[6]); redis.call('LTRIM',KEYS[4],'0','99');",
    "return {c-cost}"
   ].join(" ");
   await redis(["EVAL",script,"5","norka:entries:"+giveawayId,"norka:wallet:"+id,"norka:giveaway-counts","norka:ledger:"+id,"norka:giveaways",id,String(cost),giveawayId,String(endMs),String(Date.now()),ledgerItem]);
   await grantProgress(id,"giveaway:"+giveawayId,"giveaway",new Date().toISOString().slice(0,10));const w=await readWallet(id);
   return json(res,200,{ok:true,wallet:w,progress:await readProgress(id)});
  }
  return json(res,400,{ok:false,error:"Неизвестное действие"});
 }catch(e){const msg=String(e&&e.message||"Ошибка сервера");if(msg.includes("INSUFFICIENT"))return json(res,409,{ok:false,error:"Недостаточно средств на балансе"});if(msg.includes("DAILY_ALREADY"))return json(res,409,{ok:false,error:"Ежедневная награда уже получена"});if(msg.includes("SUBSCRIPTION_ALREADY"))return json(res,409,{ok:false,error:"Награда за подписку уже получена"});if(msg.includes("TASK_ALREADY"))return json(res,409,{ok:false,error:"Заявка уже отправлена или задание подтверждено"});if(msg.includes("DRAW_ALREADY"))return json(res,409,{ok:false,error:"Победитель уже определяется или розыгрыш завершён"});if(msg.includes("CLOSED"))return json(res,409,{ok:false,error:"Розыгрыш уже завершён"});if(msg.includes("ALREADY"))return json(res,409,{ok:false,error:"Ты уже участвуешь в этом розыгрыше"});console.error("NORKA API:",msg);return json(res,500,{ok:false,error:"Внутренняя ошибка. Проверьте настройки Redis в Vercel."});}
};