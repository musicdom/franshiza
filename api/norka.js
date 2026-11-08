const { createHmac, timingSafeEqual, randomInt, randomBytes } = require("crypto");
const { requestMax, sendMaxMessage, uploadMaxImage } = require("../lib/max-api");
const NORKA_BACKEND_VERSION="norka-wheel-daily-limit-2026-11-08-v29";

function json(res,status,data){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));}
function cfg(){const kvUrl=process.env.KV_REST_API_URL,kvToken=process.env.KV_REST_API_TOKEN,upstashUrl=process.env.UPSTASH_REDIS_REST_URL,upstashToken=process.env.UPSTASH_REDIS_REST_TOKEN;if(kvUrl&&kvToken)return {url:kvUrl.replace(/\/$/,""),token:kvToken,source:"KV"};if(upstashUrl&&upstashToken)return {url:upstashUrl.replace(/\/$/,""),token:upstashToken,source:"UPSTASH"};if(kvUrl||kvToken||upstashUrl||upstashToken)throw new Error("Redis configuration is incomplete: URL and token must belong to the same provider");return null;}
async function redis(parts){const c=cfg();if(!c)throw new Error("Redis is not configured");const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);let r;try{r=await fetch(c.url,{method:"POST",headers:{Authorization:"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify(parts),signal:controller.signal});}catch(error){if(error&&error.name==="AbortError")throw new Error("Redis request timed out after 5000ms");throw error;}finally{clearTimeout(timer);}if(!r.ok)throw new Error("Redis HTTP "+r.status);const d=await r.json();if(d.error)throw new Error(d.error);return d.result;}
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
  return {id:String(user.id),profile:{name:[user.first_name,user.last_name].filter(Boolean).join(" ")||user.name||user.username||"Участник Норки",avatar:user.photo_url||""},startParam:clean(params.get("start_param")||"",512)};
 }catch{return null;}
}
function userKey(id){return "norka:user:"+id;}
async function ensureUser(id,profile={}){
 let u=await get(userKey(id)),changed=false;
 if(!u){u={id,name:clean(profile.name,100)||"Участник Норки",avatar:clean(profile.avatar,500),berries:0,coins:0,createdAt:new Date().toISOString(),lastDaily:null};changed=true;}
 const name=clean(profile.name,100),avatar=clean(profile.avatar,500);
 if(name&&u.name!==name){u.name=name;changed=true;}
 if(avatar&&u.avatar!==avatar){u.avatar=avatar;changed=true;}
 let mapped=u.referralCode?String(await redis(["GET","norka:referral:code:"+u.referralCode])||""):"";
 if(!u.referralCode||mapped&&mapped!==String(id)){
  u.referralCode="";
  for(let i=0;i<8&&!u.referralCode;i++){const code=randomBytes(6).toString("hex"),saved=await redis(["SET","norka:referral:code:"+code,id,"NX"]);if(saved==="OK"){u.referralCode=code;changed=true;}}
 }else if(!mapped){const saved=await redis(["SET","norka:referral:code:"+u.referralCode,id,"NX"]);if(saved!=="OK")throw new Error("REFERRAL_CODE_MAPPING_FAILED");}
 if(!u.referralCode)throw new Error("REFERRAL_CODE_CREATE_FAILED");
 const seedScript="if redis.call('EXISTS',KEYS[1])==0 then local b=tonumber(redis.call('HGET',KEYS[3],'berries') or '0');redis.call('SET',KEYS[1],b);if b>0 then redis.call('ZADD',KEYS[2],b,ARGV[1]);end;return b;end;return tonumber(redis.call('GET',KEYS[1])) or 0";
 await redis(["EVAL",seedScript,"3","norka:berries:earned:"+id,"norka:berries:ranking","norka:wallet:"+id,id]);
 if(changed)await set(userKey(id),u);
 return u;
}
async function ledger(id,item){await redis(["LPUSH","norka:ledger:"+id,JSON.stringify({...item,at:new Date().toISOString()})]);await redis(["LTRIM","norka:ledger:"+id,"0","99"]);}
async function claimLaunchTask(id){
 const reward=50,now=new Date().toISOString(),item=JSON.stringify({type:"task_reward",taskId:"launch",title:"Награда: Запустить бота",berries:reward,at:now});
 const script=[
  "if redis.call('GET',KEYS[1]) then return {0,tonumber(redis.call('HGET',KEYS[2],'berries') or '0')} end;",
  "local raw=redis.call('GET',KEYS[4]);local claims={};if raw then claims=cjson.decode(raw) end;",
  "if claims['launch']=='done' then redis.call('SET',KEYS[1],'1');return {0,tonumber(redis.call('HGET',KEYS[2],'berries') or '0')} end;",
  "local b=redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[1]));redis.call('INCRBY',KEYS[5],tonumber(ARGV[1]));redis.call('ZINCRBY',KEYS[6],tonumber(ARGV[1]),ARGV[3]);",
  "claims['launch']='done';redis.call('SET',KEYS[4],cjson.encode(claims));redis.call('SET',KEYS[1],'1');",
  "redis.call('LPUSH',KEYS[3],ARGV[2]);redis.call('LTRIM',KEYS[3],'0','99');return {1,b}"
 ].join(" ");
 const result=await redis(["EVAL",script,"6","norka:taskclaim:"+id+":launch","norka:wallet:"+id,"norka:ledger:"+id,"norka:claims:"+id,"norka:berries:earned:"+id,"norka:berries:ranking",String(reward),item,id]);
 return {awarded:Number(result?.[0])===1,berries:Number(result?.[1])||0,reward};
}
async function updateBalances(id,berryDelta,coinDelta){const script="local b=tonumber(redis.call('HGET',KEYS[1],'berries') or '0'); local c=tonumber(redis.call('HGET',KEYS[1],'coins') or '0'); local db=tonumber(ARGV[1]); local dc=tonumber(ARGV[2]); if b+db<0 or c+dc<0 then return {err='INSUFFICIENT'} end; redis.call('HSET',KEYS[1],'berries',b+db,'coins',c+dc); return {b+db,c+dc}";const raw=await redis(["EVAL",script,"1","norka:wallet:"+id,String(berryDelta),String(coinDelta)]);if(!raw||raw.error)throw new Error("Wallet update failed");return {berries:Number(raw[0]),coins:Number(raw[1])};}
function wheelDayInfo(){
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
 const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 const day=values.year+"-"+values.month+"-"+values.day;
 const nextMidnight=Math.floor((Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day)+1)-3*60*60*1000)/1000);
 return {day,key:"norka:wheel:daily:"+day,resetAt:nextMidnight};
}
async function readWallet(id){let w=await redis(["HGETALL","norka:wallet:"+id]);if(!Array.isArray(w)||!w.length)return {berries:0,coins:0};const o={};for(let i=0;i<w.length;i+=2)o[w[i]]=Number(w[i+1]);return {berries:o.berries||0,coins:o.coins||0};}
async function list(key){const ids=await redis(["LRANGE",key,"0","99"]);return Array.isArray(ids)?ids.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean):[];}
async function countUserKeys(){let cursor="0",count=0,iterations=0;do{const page=await redis(["SCAN",cursor,"MATCH","norka:user:*","COUNT","500"]);if(!Array.isArray(page)||page.length<2)throw new Error("Unexpected Redis SCAN response");cursor=String(page[0]);const keys=Array.isArray(page[1])?page[1]:[];count+=keys.filter(key=>/^norka:user:[^:]+$/.test(String(key))).length;iterations++;if(iterations>=200&&cursor!=="0")throw new Error("User count scan exceeded safety limit");}while(cursor!=="0");return count;}
async function admin(req){const expected=process.env.NORKA_ADMIN_PASSWORD;if(!expected)return false;const supplied=clean(req.headers["x-norka-admin"]||req.body?.adminPassword,300);const a=Buffer.from(supplied),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
const DEFAULT_TASKS=[{id:"daily",title:"Ежедневный визит",description:"Заглядывай в Норку каждый день",reward:10,type:"daily",active:true},{id:"launch",title:"Запустить бота",description:"Открой Норку впервые и получи награду",reward:50,type:"launch",active:true},{id:"channel",title:"Подписаться на канал",description:"Подпишись на канал Норки и подтверди подписку",reward:100,type:"subscription",url:process.env.NORKA_CHANNEL_URL||"https://max.ru/join/L_PrwMy9zacHRuwZDM8NF49IhSs_p_XpLuXUfzjXEpk",active:true},{id:"first_topup",title:"Первое пополнение",description:"Пополнить баланс впервые и получить бонус",reward:250,type:"first_topup",active:true}];
async function tasks(){const saved=await get("norka:tasks");const custom=Array.isArray(saved)?saved.filter(t=>!DEFAULT_TASKS.some(d=>d.id===t.id)):[];return [...DEFAULT_TASKS,...custom];}

const DEFAULT_PROGRESS_CONFIG={
 xp:{visit:2,daily:5,task:20,exchange:3,giveaway:5},
 thresholds:[0,100,250,450,700,1000,1400,1900,2500,3200,4000],
 streakRewards:{"3":10,"7":30,"14":70,"30":200},
 levelRewards:{"5":25,"10":75},
 achievementRewards:{}
};
async function migrateBerriesRanking(){
 const resetKey="norka:berries:ranking:migration_reset_v21";
 if(!(await redis(["GET",resetKey]))){
  await redis(["DEL","norka:berries:ranking:migrated","norka:berries:ranking:migration_cursor","norka:berries:ranking"]);
  await redis(["SET",resetKey,"1"]);
 }
 if(await redis(["GET","norka:berries:ranking:migrated"]))return true;
 let cursor=String(await redis(["GET","norka:berries:ranking:migration_cursor"])||"0"),pages=0;
 while(pages<10){
  const scan=await redis(["SCAN",cursor,"MATCH","norka:user:*","COUNT","500"]);
  if(!Array.isArray(scan)||scan.length<2)throw new Error("Unexpected Redis SCAN response during berries migration");
  cursor=String(scan[0]||"0");
  const userKeys=(Array.isArray(scan[1])?scan[1]:[]).filter(k=>/^norka:user:[^:]+$/.test(String(k)));
  if(userKeys.length){
   const script="for i=1,#ARGV do local key=ARGV[i];local id=string.sub(key,12);local totalKey='norka:berries:earned:'..id;local old=tonumber(redis.call('GET',totalKey) or '0');local balance=tonumber(redis.call('HGET','norka:wallet:'..id,'berries') or '0');local total=math.max(old,balance);redis.call('SET',totalKey,tostring(total));if total>0 then redis.call('ZADD',KEYS[1],total,id) else redis.call('ZREM',KEYS[1],id) end;end;return #ARGV";
   await redis(["EVAL",script,"1","norka:berries:ranking",...userKeys]);
  }
  pages++;
  if(cursor==="0"){
   await redis(["SET","norka:berries:ranking:migrated","1"]);
   await redis(["DEL","norka:berries:ranking:migration_cursor"]);
   return true;
  }
  await redis(["SET","norka:berries:ranking:migration_cursor",cursor]);
 }
 return false;
}
async function applyReferralSignup(friendId,startParam){
 const match=/^ref_([a-f0-9]{12})$/.exec(String(startParam||""));if(!match)return false;
 const referrerId=String(await redis(["GET","norka:referral:code:"+match[1]])||"");if(!referrerId||referrerId===String(friendId))return false;
 const reward=25,ledgerItem=JSON.stringify({type:"referral_signup",title:"Друг присоединился к Норке",berries:reward,at:new Date().toISOString()});
 const script=["if ARGV[1]==ARGV[2] or redis.call('EXISTS',KEYS[4])==1 then return {0,0} end;","if redis.call('SISMEMBER',KEYS[5],ARGV[1])==1 then return {0,0} end;","redis.call('SET',KEYS[4],ARGV[2]);redis.call('SADD',KEYS[5],ARGV[1]);","local balance=redis.call('HINCRBY',KEYS[1],'berries',tonumber(ARGV[3]));","redis.call('INCRBY',KEYS[2],tonumber(ARGV[3]));redis.call('ZINCRBY',KEYS[3],tonumber(ARGV[3]),ARGV[2]);","redis.call('HINCRBY',KEYS[6],'berries',tonumber(ARGV[3]));","redis.call('LPUSH',KEYS[7],ARGV[4]);redis.call('LTRIM',KEYS[7],'0','99');","return {1,balance}"].join(" ");
 const result=await redis(["EVAL",script,"7","norka:wallet:"+referrerId,"norka:berries:earned:"+referrerId,"norka:berries:ranking","norka:referral:inviter:"+friendId,"norka:referrals:"+referrerId,"norka:referral:stats:"+referrerId,"norka:ledger:"+referrerId,String(friendId),referrerId,String(reward),ledgerItem]);
 if(Number(result?.[0])===1){notifyUser(referrerId,"referral-signup:"+friendId,"🍓 По твоей ссылке в Норку пришёл новый друг!\nТебе начислено 25 ягод.");return true;}return false;
}
async function readCommunityData(id,user){
 const migrationComplete=await migrateBerriesRanking(),code=String(user?.referralCode||"");
 const [count,statsRaw,topRaw,rankRaw,earnedRaw,friendIds]=await Promise.all([redis(["SCARD","norka:referrals:"+id]),redis(["HGETALL","norka:referral:stats:"+id]),redis(["ZREVRANGE","norka:berries:ranking","0","19","WITHSCORES"]),redis(["ZREVRANK","norka:berries:ranking",id]),redis(["GET","norka:berries:earned:"+id]),redis(["SMEMBERS","norka:referrals:"+id])]);
 const stats={};if(Array.isArray(statsRaw))for(let i=0;i<statsRaw.length;i+=2)stats[statsRaw[i]]=Number(statsRaw[i+1])||0;
 const topEntries=[];if(Array.isArray(topRaw))for(let i=0;i+1<topRaw.length;i+=2)topEntries.push({userId:String(topRaw[i]),berries:Number(topRaw[i+1])||0});
 const topProfiles=await Promise.all(topEntries.map(entry=>get(userKey(entry.userId))));
 const top=topEntries.map((entry,index)=>{const profile=topProfiles[index];return {userId:entry.userId,name:clean(profile?.name,100)||"Участник Норки",avatar:clean(profile?.avatar,500),berries:entry.berries};});
 const referralIds=Array.isArray(friendIds)?friendIds.map(String).slice(0,100):[];
 const referrals=await Promise.all(referralIds.map(async friendId=>{
  const [profileRaw,rewardRaw]=await Promise.all([get(userKey(friendId)),get("norka:referral:reward:"+friendId)]);
  const profile=profileRaw&&typeof profileRaw==="object"?profileRaw:{};
  let topup=null;
  if(rewardRaw&&typeof rewardRaw==="object"&&String(rewardRaw.referrerId||"")===String(id)){
   topup={berries:Number(rewardRaw.berries)||100,coins:Number(rewardRaw.coins)||0,purchaseCoins:Number(rewardRaw.purchaseCoins)||0,coinsKnown:true,at:clean(rewardRaw.at,40)};
  }else{
   const marker=await redis(["GET","norka:referral:first_topup:"+friendId]);
   if(marker){
    const ledgerRaw=await redis(["LRANGE","norka:ledger:"+friendId,"0","99"]);
    const entries=Array.isArray(ledgerRaw)?ledgerRaw.map(raw=>{try{return JSON.parse(raw)}catch{return null}}).filter(Boolean):[];
    const purchases=entries.filter(entry=>entry.type==="coin_purchase");
    const firstPurchase=purchases[purchases.length-1];
    if(firstPurchase){
     let order=null;if(firstPurchase.orderId){const orderRaw=await get("norka:payment:order:"+String(firstPurchase.orderId));if(orderRaw&&typeof orderRaw==="object")order=orderRaw;}
     const purchaseCoins=Number(order?.coins||firstPurchase.coins)||0;
     topup={berries:100,coins:Math.floor(purchaseCoins*0.02),purchaseCoins,coinsKnown:true,at:clean(order?.paidAt||firstPurchase.at,40)};
    }else topup={berries:100,coins:0,purchaseCoins:0,coinsKnown:false,at:""};
   }
  }
  return {userId:friendId,name:clean(profile.name,100)||"Участник Норки",avatar:clean(profile.avatar,500),joinedAt:clean(profile.createdAt,40),signupReward:{berries:25},topup};
 }));
 referrals.sort((a,b)=>String(b.joinedAt||"").localeCompare(String(a.joinedAt||"")));
 return {referral:{code,count:Number(count)||0,berries:stats.berries||0,coins:stats.coins||0,friends:referrals},ranking:{top,rank:rankRaw===null||rankRaw===undefined?null:Number(rankRaw)+1,total:Number(earnedRaw)||0,migrationComplete}};
}

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
async function notifyAllUsers(eventId,message){const keys=await redis(["KEYS","norka:user:*"]);const ids=(Array.isArray(keys)?keys:[]).filter(key=>/^norka:user:[^:]+$/.test(key)).map(key=>key.slice(11)).slice(0,100);for(let i=0;i<ids.length;i+=10)await Promise.all(ids.slice(i,i+10).map(id=>notifyUser(id,eventId,message)));return ids.length;}
async function notifyGiveawayResult(item,entrants,winnerId){const title=clean(item?.title,100)||"Норка";for(const userId of Array.isArray(entrants)?entrants:[]){if(String(userId)===String(winnerId)){await notifyUser(userId,"giveaway-winner-gift:"+item.id,"🏆 Поздравляем! Ты победил в розыгрыше «"+title+"»!\n🎁 Твой приз: "+(clean(item?.prize,120)||"уточни у организатора")+"\nОткрой личный кабинет → «Мои подарки» и нажми «Забрать». Кнопка получения пока работает как заглушка.");}else{await notifyUser(userId,"giveaway-end:"+item.id,"⏰ Розыгрыш «"+title+"» завершён. Спасибо за участие! Победитель уже определён. Результаты доступны в приложении.");}}}

async function readNumberedEntries(giveawayId){
 const raw=await redis(["HGETALL","norka:number-entries:"+giveawayId]),out=[];
 if(Array.isArray(raw))for(let i=0;i+1<raw.length;i+=2){const number=Number(raw[i]),userId=String(raw[i+1]||"");if(Number.isInteger(number)&&number>0&&userId)out.push({number,userId});}
 return out;
}
async function ensureNumberedPrizeReward(item,winner){
 if(!item||!winner||!winner.userId)return false;
 const prize=winner.prize||{},gift={id:"giveaway_"+String(item.id)+"_place_"+String(winner.place),type:"giveaway_prize",giveawayId:String(item.id),title:clean(item.title,100)||"Подарок от Норки",prize:clean(prize.title,120)||"Приз розыгрыша",description:clean(prize.description,500),imageUrl:clean(prize.imageUrl,500),winningNumber:Number(winner.number),place:Number(winner.place),status:"available",claimed:false,createdAt:item.drawnAt||new Date().toISOString()};
 const key="norka:giveaway:number-reward:"+String(item.id)+":"+String(winner.place);
 const script="if redis.call('GET',KEYS[2]) then return 0 end; redis.call('LPUSH',KEYS[1],ARGV[1]); redis.call('LTRIM',KEYS[1],'0','49'); redis.call('SET',KEYS[2],ARGV[1]); return 1";
 return Number(await redis(["EVAL",script,"2","norka:rewards:"+String(winner.userId),key,JSON.stringify(gift)]))===1;
}
async function notifyNumberedGiveawayResult(item,entries,winners){
 const notified=new Set();
 for(const winner of winners||[]){
  await notifyUser(winner.userId,"number-giveaway-winner:"+item.id+":"+winner.place,"🏆 Поздравляем! Ты выиграл в розыгрыше «"+clean(item.title,100)+"»!\n🎟️ Твой номер: "+String(winner.number).padStart(2,"0")+"\n🎁 Твой приз: "+clean(winner.prize?.title,120)+"\nОткрой Норку → «Мои подарки», чтобы увидеть награду.");
  notified.add(String(winner.userId));
 }
 const allUsers=[...new Set((entries||[]).map(e=>String(e.userId)))];
 for(const uid of allUsers)if(!notified.has(uid))await notifyUser(uid,"number-giveaway-end:"+item.id,"⏰ Розыгрыш «"+clean(item.title,100)+"» завершён. Спасибо за участие! Победители уже определены. Результаты доступны в Норке.");
}
async function publishNumberedGiveawayResult(item){
 try{
  const {publishNumberedGiveaway}=require("../lib/winner-publisher");
  const published=await publishNumberedGiveaway(item,item.winners,async userId=>ensureUser(String(userId)),redis);
  if(published)await redis(["DEL","norka:giveaway:channel-error:"+String(item.id)]);
  return published;
 }catch(error){
  const message=String(error&&error.message||error||"unknown").slice(0,1000);
  console.error("NORKA winner channel publication failed:",message);
  try{await redis(["SET","norka:giveaway:channel-error:"+String(item.id),message]);}catch(saveError){console.error("NORKA publication error save failed:",saveError&&saveError.message||"unknown");}
  return false;
 }
}
async function drawNumberedGiveaway(giveawayId){
 const items=await list("norka:giveaways"),item=items.find(x=>String(x.id)===String(giveawayId));
 if(!item||item.type!=="numbers")return {completed:false};
 if(item.status==="completed")return {completed:true,item};
 if(item.status!=="drawing")return {completed:false};
 const entries=await readNumberedEntries(giveawayId);
 if(entries.length!==Number(item.capacity))return {completed:false};
 const pool=entries.slice(),winners=[];
 for(let i=0;i<item.prizes.length&&pool.length;i++){
  const index=randomInt(pool.length),entry=pool.splice(index,1)[0];
  winners.push({place:i+1,number:entry.number,userId:entry.userId,prize:item.prizes[i]});
 }
 if(winners.length!==item.prizes.length)return {completed:false};
 const drawnAt=new Date().toISOString(),encoded=JSON.stringify(winners);
 const script="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local g=cjson.decode(raw); if tostring(g.id)==ARGV[1] then if g.status=='completed' then return 0 end; if g.status~='drawing' then return -1 end; g.status='completed'; g.winners=cjson.decode(ARGV[2]); g.drawnAt=ARGV[3]; redis.call('LSET',KEYS[1],i,cjson.encode(g)); return 1 end end end; return -1";
 const saved=Number(await redis(["EVAL",script,"1","norka:giveaways",String(giveawayId),encoded,drawnAt]));
 if(saved===0){const fresh=(await list("norka:giveaways")).find(x=>String(x.id)===String(giveawayId));return {completed:true,item:fresh};}
 if(saved!==1)return {completed:false};
 const completed={...item,status:"completed",winners,drawnAt};
 for(const winner of winners)await ensureNumberedPrizeReward(completed,winner);
 await notifyNumberedGiveawayResult(completed,entries,winners);
 await publishNumberedGiveawayResult(completed);
 return {completed:true,item:completed,winners};
}

async function grantProgress(id,eventId,kind,day,sendNotification=true){
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
  "if berries>0 then redis.call('HINCRBY',KEYS[2],'berries',berries);redis.call('INCRBY',KEYS[8],berries);redis.call('ZINCRBY',KEYS[9],berries,ARGV[10]);for _,item in ipairs(ledger) do redis.call('LPUSH',KEYS[3],item) end;redis.call('LTRIM',KEYS[3],'0','99') end;",
  "redis.call('SET',KEYS[1],cjson.encode(p)); return {1,p.xp,p.level,p.streak,berries,#unlocked,oldLevel}"
 ].join(" ");
 const result=await redis(["EVAL",script,"9","norka:progress:"+id,"norka:wallet:"+id,"norka:ledger:"+id,"norka:progress:events:"+id,"norka:achievements:"+id,"norka:streak:rewards:"+id,"norka:level:rewards:"+id,"norka:berries:earned:"+id,"norka:berries:ranking",eventId,day,kind,String(xp),JSON.stringify(thresholds),JSON.stringify(config.streakRewards),JSON.stringify(config.levelRewards),new Date().toISOString(),new Date(Date.parse(day+"T00:00:00Z")-86400000).toISOString().slice(0,10),id]);
 const progress={applied:Number(result[0])===1,xp:Number(result[1])||0,level:Number(result[2])||1,streak:Number(result[3])||0,berries:Number(result[4])||0};if(sendNotification&&progress.applied&&(progress.berries>0||Number(result[5])>0||progress.level>Number(result[6])))await notifyUser(id,"progress:"+eventId,"🌿 Отличная работа в Норке!\nУровень: "+progress.level+" · Опыт: "+progress.xp+" XP\nСерия: "+progress.streak+" дней\n"+(progress.berries>0?"🍓 Начислено ягод: "+progress.berries:"Новое достижение открыто!"));return progress;
}
async function readProgress(id){
 const p=await get("norka:progress:"+id)||{xp:0,level:1,streak:0,bestStreak:0,lastVisit:""};
 const achievements=await redis(["SMEMBERS","norka:achievements:"+id]);
 const config=await progressConfig(),thresholds=config.thresholds;
 const level=Math.max(1,Number(p.level)||1),current=Number(thresholds[level-1])||0,next=Number(thresholds[level])||current;
 return {...p,level,currentLevelXp:current,nextLevelXp:next,levelProgress:next>current?Math.max(0,Math.min(100,Math.round((Number(p.xp)-current)/(next-current)*100))):100,achievements:Array.isArray(achievements)?achievements:[],thresholds};
}
async function giveaways(){const items=await list("norka:giveaways");await Promise.all(items.map(async item=>{const count=Number(await redis([item.type==="numbers"?"HLEN":"SCARD",item.type==="numbers"?"norka:number-entries:"+item.id:"norka:entries:"+item.id]))||0;item.entries=count;}));return items;}
async function nextGiveawayNumber(){
 const value=await redis(["EVAL","local n=redis.call('GET',KEYS[1]); if not n then n=redis.call('LLEN',KEYS[2]); redis.call('SET',KEYS[1],n); end; return redis.call('INCR',KEYS[1])","2","norka:giveaway:sequence","norka:giveaways"]);
 return Math.max(1,Number(value)||1);
}
async function publishGiveawayStart(item){
 const id=String(item&&item.id||"");if(!id)return false;
 const numbered=item.type==="numbers";
 const marker="norka:giveaway:start-channel-published:"+id,errorKey="norka:giveaway:start-channel-error:"+id;
 const lock=await redis(["SET",marker,"sending","NX","EX","900"]);if(!lock)return false;
 try{
  const token=process.env.MAX_BOT_TOKEN,chatId=await redis(["GET","norka:channel:chat_id"]);
  if(!token||!chatId)throw new Error(!token?"MAX_BOT_TOKEN is not configured":"Norka channel ID is not configured in Redis");
  const miniApp=process.env.NORKA_MINI_APP_URL||"https://max.ru/se14711525_bot";
  const safe=v=>String(v==null?"":v).replace(/[\r\n]+/g," ").trim();
  const prizes=numbered&&Array.isArray(item.prizes)?item.prizes.map((p,i)=>"🏆 "+(i+1)+". "+safe(p&&p.title||"Приз")):["🎁 "+safe(item.prize||"Приз розыгрыша")];
  const title=safe(item.title||"Без названия"),description=safe(item.description||"");
  const common=["🎉 НОВЫЙ РОЗЫГРЫШ В НОРКЕ!","","🎟 Розыгрыш №"+(Number(item.number)||"—")+" · "+title,description,"","👥 Участников: 0"];
  const lines=numbered
   ? [...common,"🔢 Всего номеров: "+(Number(item.capacity)||0),"🪙 Стоимость одного номера: "+(Number(item.cost)||0)+" монет","","🏆 ЧТО РАЗЫГРЫВАЕМ",...prizes,"","Выбирай свободные номера и участвуй!"]
   : [...common,"🎫 Доступно мест: "+(Number(item.capacity)||0),"🪙 Стоимость участия: "+(Number(item.cost)||0)+" монет","","🎁 ПРИЗ",...prizes,"","Присоединяйся к розыгрышу в Норке — участвуй и жди итоги!"];
  const text=lines.filter(Boolean).join("\n");
  const keyboard={type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:numbered?"🎟 Выбрать номер":"🎉 Участвовать",web_app:miniApp}]]}};
  const post=attachments=>sendMaxMessage({token,chatId,text,attachments});let sent=null,imageError=null;
  try{
   const imagePath=numbered?"Image/%D0%B3%D0%B8%D0%B2%D0%B2%D0%B5%D0%B8%CC%862.png":"Image/%D0%B3%D0%B8%D0%B2%D0%B2%D0%B5%D0%B8%CC%86.png";
   const imageUrl="https://raw.githubusercontent.com/musicdom/franshiza/main/"+imagePath;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);let response;
   try{response=await fetch(imageUrl,{signal:controller.signal});}finally{clearTimeout(timer);}
   if(!response.ok)throw new Error("GitHub announcement image HTTP "+response.status);
   if(!String(response.headers.get("content-type")||"").toLowerCase().startsWith("image/"))throw new Error("GitHub announcement asset is not an image");
   const image=Buffer.from(await response.arrayBuffer());if(!image.length||image.length>8*1024*1024)throw new Error("Announcement image must be between 1 byte and 8 MB");
   const imageToken=await uploadMaxImage({token,image});await new Promise(resolve=>setTimeout(resolve,1800));
   sent=await post([{type:"image",payload:{token:imageToken}},keyboard]);
   if(!sent.ok&&String(sent.raw||"").includes("attachment.not.ready")){await new Promise(resolve=>setTimeout(resolve,2500));sent=await post([{type:"image",payload:{token:imageToken}},keyboard]);}
   if(!sent.ok)throw new Error("MAX image announcement failed: "+String(sent.raw||sent.status).slice(0,800));
  }catch(error){imageError=String(error&&error.message||error||"Image upload failed").slice(0,1000);}
  if(!sent||!sent.ok)sent=await post([keyboard]);
  if(!sent.ok)throw new Error("MAX channel announcement failed: "+String(sent.raw||sent.status).slice(0,1000));
  if(imageError){await redis(["SET",errorKey,imageError,"EX","2592000"]);console.error("NORKA giveaway channel image failed; text post sent:",imageError);}else await redis(["DEL",errorKey]);
  await redis(["SET",marker,"sent"]);return true;
 }catch(error){await redis(["DEL",marker]);await redis(["SET",errorKey,String(error&&error.message||error||"unknown").slice(0,1000),"EX","2592000"]);console.error("NORKA giveaway channel announcement failed:",error&&error.message||"unknown");return false;}
}
async function completeGiveaway(giveawayId,winnerId,drawnAt){
 const script=[
  "local n=redis.call('LLEN',KEYS[1]);",
  "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local item=cjson.decode(raw);",
  "if tostring(item.id)==ARGV[1] then",
  "if item.status=='drawing' then item.status='completed'; item.winnerId=ARGV[2]; item.drawnAt=ARGV[3]; redis.call('LSET',KEYS[1],i,cjson.encode(item)); return {1,ARGV[2]};",
  "elseif item.status=='completed' and item.winnerId then return {1,tostring(item.winnerId)};",
  "else return {0,''} end end end end; return {0,''}"
 ].join(" ");
 const result=await redis(["EVAL",script,"1","norka:giveaways",String(giveawayId),String(winnerId),String(drawnAt)]);
 return {completed:Array.isArray(result)&&Number(result[0])===1,winnerId:Array.isArray(result)&&result[1]?String(result[1]):""};
}
async function ensureGiveawayReward(item,winnerId){
 if(!item||!item.id||!winnerId)return false;
 const gift={id:"giveaway_"+String(item.id),type:"giveaway_prize",giveawayId:String(item.id),title:clean(item.title,100)||"Подарок от Норки",prize:clean(item.prize,120)||"Приз розыгрыша",status:"available",claimed:false,createdAt:item.drawnAt||new Date().toISOString()};
 const script="if redis.call('GET',KEYS[2]) then return 0 end; redis.call('LPUSH',KEYS[1],ARGV[1]); redis.call('LTRIM',KEYS[1],'0','49'); redis.call('SET',KEYS[2],ARGV[1]); return 1";
 return Number(await redis(["EVAL",script,"2","norka:rewards:"+String(winnerId),"norka:giveaway:reward:"+String(item.id),JSON.stringify(gift)]))===1;
}
async function markFullGiveawayDrawing(item){
 const script="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local g=cjson.decode(raw); if tostring(g.id)==ARGV[1] then local cap=tonumber(g.capacity) or 0; local sold=redis.call('SCARD',KEYS[2]); if g.status=='active' and cap>0 and sold==cap then g.status='drawing'; redis.call('LSET',KEYS[1],i,cjson.encode(g)); return 1 end; return 0 end end end; return 0";
 return Number(await redis(["EVAL",script,"2","norka:giveaways","norka:entries:"+item.id,String(item.id)]))===1;
}
async function processGiveawayLifecycle(){
 const items=await list("norka:giveaways");
 for(let item of items){
  if(item.type==="numbers"&&item.status==="active"&&Number(item.capacity)>0){const sold=Number(await redis(["HLEN","norka:number-entries:"+item.id]))||0;if(sold===Number(item.capacity)){const freeze="local n=redis.call('LLEN',KEYS[1]);for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i);if raw then local g=cjson.decode(raw);if tostring(g.id)==ARGV[1] and g.status=='active' then g.status='drawing';redis.call('LSET',KEYS[1],i,cjson.encode(g));return 1 end end end;return 0";await redis(["EVAL",freeze,"1","norka:giveaways",String(item.id)]);item.status="drawing";}}
  if(item.type==="numbers"&&item.status==="drawing"){await drawNumberedGiveaway(item.id);const fresh=(await list("norka:giveaways")).find(x=>String(x.id)===String(item.id));if(fresh)item=fresh;}
  if(item.type!=="numbers"&&item.status==="active"&&Number(item.capacity)>0){
   const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
   if(Array.isArray(entrants)&&entrants.length===Number(item.capacity))item.status=await markFullGiveawayDrawing(item)?"drawing":item.status;
  }
  if(item.type!=="numbers"&&item.status==="drawing"){
   const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
   if(Array.isArray(entrants)&&entrants.length){
    const selected=String(entrants[randomInt(entrants.length)]);
    const result=await completeGiveaway(item.id,selected,new Date().toISOString());
    if(result.completed){const fresh=await list("norka:giveaways");item=fresh.find(x=>String(x.id)===String(item.id))||item;}
   }else{
    const script="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local g=cjson.decode(raw); if tostring(g.id)==ARGV[1] and g.status=='drawing' then g.status='cancelled'; g.cancelledAt=ARGV[2]; g.cancelReason='no_participants'; redis.call('LSET',KEYS[1],i,cjson.encode(g)); return 1 end end end; return 0";
    await redis(["EVAL",script,"1","norka:giveaways",String(item.id),new Date().toISOString()]);
    item.status="cancelled";
   }
  }
  if(item.status==="completed"&&item.winnerId){
   await ensureGiveawayReward(item,item.winnerId);
   const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
   await notifyGiveawayResult(item,entrants,item.winnerId);
  }
  if(item.type==="numbers"&&item.status==="completed"&&Array.isArray(item.winners)){
   const entries=await readNumberedEntries(item.id);
   for(const winner of item.winners)await ensureNumberedPrizeReward(item,winner);
   await notifyNumberedGiveawayResult(item,entries,item.winners);
   await publishNumberedGiveawayResult(item);
  }
 }
}
async function readUserRewards(id){
 const items=await list("norka:giveaways");
 for(const item of items){if(item.status==="completed"&&String(item.winnerId)===String(id))await ensureGiveawayReward(item,id);if(item.type==="numbers"&&item.status==="completed"&&Array.isArray(item.winners))for(const winner of item.winners)if(String(winner.userId)===String(id))await ensureNumberedPrizeReward(item,winner);}
 return list("norka:rewards:"+id);
}
module.exports=async function handler(req,res){
 if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-InitData,X-Norka-Admin");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");return res.status(204).end();}
 res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-Norka-InitData,X-Norka-Admin");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
 if(!["GET","POST"].includes(req.method))return json(res,405,{ok:false,error:"Method not allowed"});
 try{
  const body=req.body&&typeof req.body==="object"?req.body:{};const action=clean(req.method==="GET"?req.query?.action:body.action,60);
  if(action==="norka_process_giveaway_lifecycle"){const expected=process.env.NORKA_CRON_SECRET,supplied=String(req.headers["x-norka-cron"]||body.cronSecret||"");if(!expected)return json(res,503,{ok:false,error:"Не задан NORKA_CRON_SECRET"});const a=Buffer.from(supplied),b=Buffer.from(expected);if(a.length!==b.length||!timingSafeEqual(a,b))return json(res,401,{ok:false,error:"Доступ к обработчику розыгрышей запрещён"});await processGiveawayLifecycle();return json(res,200,{ok:true,processed:true,backendVersion:NORKA_BACKEND_VERSION});}
   if(action.startsWith("admin_")){
   if(!process.env.NORKA_ADMIN_PASSWORD)return json(res,503,{ok:false,error:"Не задан пароль админ-панели. Добавь NORKA_ADMIN_PASSWORD в переменные окружения backend и перезапусти функцию."});
   if(!(await admin(req)))return json(res,401,{ok:false,error:"Неверный пароль админ-панели. Проверь NORKA_ADMIN_PASSWORD."});
   if(action==="admin_auth")return json(res,200,{ok:true,authenticated:true});
   if(action==="admin_winner_publisher_diagnostics"){
    const diagnostics={
     backendVersion:NORKA_BACKEND_VERSION,
     nodeVersion:process.version,
     nodePlatform:process.platform,
     nodeArch:process.arch,
     workingDirectory:process.cwd(),
     npmConfigOptional:process.env.npm_config_optional||null,
     nodeEnv:process.env.NODE_ENV||null
    };
    try{
     const publisherPath=require.resolve("../lib/winner-publisher");
     const publisher=require("../lib/winner-publisher");
     diagnostics.publisherPath=publisherPath;
     diagnostics.publisherBuild=publisher.WINNER_PUBLISHER_BUILD||"missing_build_marker";
     diagnostics.publisherExport=typeof publisher.publishNumberedGiveaway;
    }catch(error){
     diagnostics.publisherLoadError=String(error&&error.message||error).slice(0,1000);
    }
    try{
     diagnostics.sharpPath=require.resolve("sharp");
    }catch(error){
     diagnostics.sharpPath="not_found";
    }
    for(const [label,moduleName] of [
     ["sharpPackage","sharp"],
     ["sharpLinuxBinary","@img/sharp-linux-x64"],
     ["sharpLinuxLibvips","@img/sharp-libvips-linux-x64"]
    ]){
     try{
      diagnostics[label+"Path"]=require.resolve(moduleName);
      try{
       const packagePath=require.resolve(moduleName+"/package.json");
       diagnostics[label+"Version"]=require(packagePath).version||null;
      }catch(error){
       diagnostics[label+"PackageMetadataError"]=String(error&&error.message||error).slice(0,500);
      }
      diagnostics[label+"Present"]=true;
     }catch(error){
      diagnostics[label+"Path"]="not_found";
      diagnostics[label+"Present"]=false;
      diagnostics[label+"ResolveError"]=String(error&&error.message||error).slice(0,500);
     }
    }
    try{
     const sharp=require("sharp");
     diagnostics.sharpLoad="ok";
     diagnostics.sharpVersion=sharp.versions&&sharp.versions.sharp||null;
     diagnostics.sharpVipsVersion=sharp.versions&&sharp.versions.vips||null;
     const testSvg=Buffer.from('<svg width="2" height="2" xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2" fill="#000"/></svg>');
     const testPng=await sharp(testSvg).png().toBuffer();
     diagnostics.sharpImageTest="ok";
     diagnostics.sharpImageBytes=testPng.length;
    }catch(error){
     diagnostics.sharpLoad="error";
     diagnostics.sharpError=String(error&&error.stack||error&&error.message||error).slice(0,3000);
     diagnostics.sharpImageTest="failed";
    }
    // Safe local-only integration test: render the real winner template in memory.
    // This does not access Redis, upload an image, or publish anything to MAX.
    try{
     const cardModule=require("../lib/winner-card");
     diagnostics.winnerCardModule="loaded";
     diagnostics.winnerCardExport=typeof cardModule.createWinnerCard;
     const testItem={title:"Диагностика карточки Норки",drawnAt:new Date().toISOString()};
     const testWinners=[{number:7,name:"Тестовый победитель",prize:"Тестовый приз"}];
     const card=await cardModule.createWinnerCard(testItem,testWinners);
     diagnostics.winnerCardTest="ok";
     diagnostics.winnerCardBytes=card.length;
     const cardMetadata=await require("sharp")(card).metadata();
     diagnostics.winnerCardFormat=cardMetadata.format||null;
     diagnostics.winnerCardWidth=cardMetadata.width||null;
     diagnostics.winnerCardHeight=cardMetadata.height||null;
    }catch(error){
     diagnostics.winnerCardTest="failed";
     diagnostics.winnerCardError=String(error&&error.stack||error&&error.message||error).slice(0,5000);
    }
    return json(res,200,{ok:true,...diagnostics});
   }
   if(action==="admin_latest_channel_publication_status"){
    const items=await list("norka:giveaways");
    const item=items.filter(x=>x&&x.type==="numbers"&&x.status==="completed"&&Array.isArray(x.winners)&&x.winners.length).sort((a,b)=>String(b.drawnAt||b.createdAt||"").localeCompare(String(a.drawnAt||a.createdAt||"")))[0];
    if(!item)return json(res,200,{ok:true,found:false,backendVersion:NORKA_BACKEND_VERSION,message:"Не найден завершённый розыгрыш по номерам с сохранёнными победителями."});
    const giveawayId=String(item.id);
    const [marker,error,imageError]=await Promise.all([redis(["GET","norka:giveaway:channel-published:"+giveawayId]),redis(["GET","norka:giveaway:channel-error:"+giveawayId]),redis(["GET","norka:giveaway:channel-image-error:"+giveawayId])]);
    return json(res,200,{ok:true,found:true,backendVersion:NORKA_BACKEND_VERSION,giveaway:{id:giveawayId,title:String(item.title||"Без названия"),status:item.status,drawnAt:item.drawnAt||null,winners:item.winners.map(w=>({place:w.place,number:w.number,userId:String(w.userId||""),prize:String(w.prize||"")}))},publication:marker||"not_sent",lastError:error||null,imageError:imageError||null});
   }
   if(action==="admin_retry_latest_giveaway_publication"){
    const items=await list("norka:giveaways");
    const item=items.filter(x=>x&&x.type==="numbers"&&x.status==="completed"&&Array.isArray(x.winners)&&x.winners.length).sort((a,b)=>String(b.drawnAt||b.createdAt||"").localeCompare(String(a.drawnAt||a.createdAt||"")))[0];
    if(!item)return json(res,404,{ok:false,error:"Не найден завершённый розыгрыш по номерам с победителями."});
    const giveawayId=String(item.id);
    await publishNumberedGiveawayResult(item);
    const [marker,error,imageError]=await Promise.all([redis(["GET","norka:giveaway:channel-published:"+giveawayId]),redis(["GET","norka:giveaway:channel-error:"+giveawayId]),redis(["GET","norka:giveaway:channel-image-error:"+giveawayId])]);
    return json(res,200,{ok:true,giveawayId,title:item.title||"Без названия",publication:marker||"not_sent",lastError:error||null,imageError:imageError||null,backendVersion:NORKA_BACKEND_VERSION});
   }
   if(action==="admin_channel_publication_status"){
    const giveawayId=clean(body.giveawayId,60);
    if(!giveawayId)return json(res,400,{ok:false,error:"Не указан ID розыгрыша"});
    const [marker,error,imageError]=await Promise.all([redis(["GET","norka:giveaway:channel-published:"+giveawayId]),redis(["GET","norka:giveaway:channel-error:"+giveawayId]),redis(["GET","norka:giveaway:channel-image-error:"+giveawayId])]);
    return json(res,200,{ok:true,giveawayId,publication:marker||"not_sent",lastError:error||null,imageError:imageError||null});
   }
   if(action==="admin_set_channel_id"){const channelId=clean(String(body.channelId||""),40);if(!/^-?\d{1,30}$/.test(channelId))return json(res,400,{ok:false,error:"Укажите числовой ID канала MAX"});await redis(["SET","norka:channel:chat_id",channelId]);return json(res,200,{ok:true,channelId});}
   if(action==="admin_test_channel_image"){
    const token=process.env.MAX_BOT_TOKEN;
    const channelId=await redis(["GET","norka:channel:chat_id"]);
    if(!token)return json(res,503,{ok:false,error:"Не настроен MAX_BOT_TOKEN"});
    if(!channelId)return json(res,400,{ok:false,error:"В Redis не сохранён ID канала"});
    let stage="проверка канала";
    try{
     const channelInfo=await requestMax({token,method:"GET",apiPath:"/chats/"+encodeURIComponent(String(channelId))});
     if(!channelInfo.ok)return json(res,502,{ok:false,error:"Не удалось получить сведения о канале",stage,httpStatus:channelInfo.status,details:channelInfo.data||channelInfo.raw||null,channelId:String(channelId)});
     const chatType=channelInfo.data?.chat_type||channelInfo.data?.type||null;
     if(chatType && chatType!=="channel")return json(res,409,{ok:false,error:"Сохранённый ID принадлежит не каналу",chatType,channelId:String(channelId)});
     stage="генерация PNG";
     const {createWinnerCard}=require("../lib/winner-card");
     const item={title:"ТЕСТ ОТПРАВКИ КАРТОЧКИ НОРКИ",drawnAt:new Date().toISOString()};
     const winners=[{number:"TEST-07",name:"Тестовый победитель",prize:"Тестовая проверка PNG"}];
     const image=await createWinnerCard(item,winners);
     const imageBytes=image.length;
     stage="загрузка PNG";
     const imageToken=await uploadMaxImage({token,image});
     const message="🧪 ТЕСТ КАРТОЧКИ НОРКИ\n\nЭто проверочная публикация от бота Норки. Реальный розыгрыш и его результаты не затрагиваются.";
     const attachments=[{type:"image",payload:{token:imageToken}}];
     stage="отправка PNG в канал";
     let sent=await sendMaxMessage({token,chatId:channelId,text:message,attachments});
     if(!sent.ok && String(sent.raw||"").includes("attachment.not.ready")){
      await new Promise(resolve=>setTimeout(resolve,2500));
      sent=await sendMaxMessage({token,chatId:channelId,text:message,attachments});
     }
     if(!sent.ok)return json(res,502,{ok:false,error:"Бот загрузил карточку, но MAX не принял публикацию PNG",stage,httpStatus:sent.status,details:sent.data||sent.raw||null,channelId:String(channelId),imageBytes});
     return json(res,200,{ok:true,message:"Бот Норки отправил тестовую PNG-карточку в канал",channelId:String(channelId),chatType,imageBytes,format:"png",width:864,height:1154,messageId:sent.data?.message?.body?.mid||sent.data?.message?.mid||null});
    }catch(error){
     return json(res,502,{ok:false,error:"Ошибка на этапе «"+stage+"»: "+String(error&&error.message||error).slice(0,1200),stage,channelId:String(channelId)});
    }
   }
   if(action==="admin_test_channel_message"){
    const token=process.env.MAX_BOT_TOKEN;
    const channelId=await redis(["GET","norka:channel:chat_id"]);
    if(!token)return json(res,503,{ok:false,error:"Не настроен MAX_BOT_TOKEN"});
    if(!channelId)return json(res,400,{ok:false,error:"В Redis не сохранён ID канала"});
    try{
     const channelInfo=await requestMax({token,method:"GET",apiPath:"/chats/"+encodeURIComponent(String(channelId))});
     if(!channelInfo.ok)return json(res,502,{ok:false,error:"Не удалось получить сведения о канале по сохранённому ID",httpStatus:channelInfo.status,details:channelInfo.data||channelInfo.raw||null,channelId:String(channelId)});
     const chatType=channelInfo.data?.chat_type||channelInfo.data?.type||null;
     if(chatType && chatType!=="channel")return json(res,409,{ok:false,error:"Сохранённый ID принадлежит не каналу",chatType,channelId:String(channelId),channel:channelInfo.data});
     const message="🔎 Тестовая публикация от бота Норка · "+new Date().toLocaleString("ru-RU");
     const result=await sendMaxMessage({token,chatId:channelId,text:message});
     if(!result.ok)return json(res,502,{ok:false,error:"Бот не смог отправить сообщение в канал",httpStatus:result.status,details:result.data||result.raw||null,channelId:String(channelId),chatType});
     return json(res,200,{ok:true,message:"Бот отправил тестовое сообщение в канал",channelId:String(channelId),chatType,messageId:result.data?.message?.body?.mid||result.data?.message?.mid||null});
    }catch(error){return json(res,502,{ok:false,error:"Ошибка запроса к MAX: "+String(error&&error.message||error).slice(0,500),channelId:String(channelId)});}
   }
    if(action==="admin_setup_channel_tracking"){
    const token=process.env.MAX_BOT_TOKEN,secret=process.env.MAX_WEBHOOK_SECRET;
    if(!token||!secret)return json(res,503,{ok:false,error:"Не настроены MAX_BOT_TOKEN или MAX_WEBHOOK_SECRET"});
    const webhookUrl=process.env.NORKA_WEBHOOK_URL||"https://franshiza.vercel.app/api/webhook";
    const r=await requestMax({token,method:"POST",apiPath:"/subscriptions",body:{url:webhookUrl,update_types:["bot_added","bot_removed","bot_started","message_created","user_added","user_removed"],secret}});
    if(!r.ok)return json(res,502,{ok:false,error:"MAX не принял подписку на события",details:r.data||r.raw});
    return json(res,200,{ok:true,message:"Подписка на события MAX обновлена",webhookUrl});
   }
   if(action==="admin_overview"){const started=Date.now();const [pending,rateRaw,channelId,giveawayItems,taskItems,config]=await Promise.all([list("norka:pending"),redis(["GET","norka:exchange-rate"]),redis(["GET","norka:channel:chat_id"]),giveaways(),tasks(),progressConfig()]);return json(res,200,{ok:true,backendVersion:NORKA_BACKEND_VERSION,pending,giveaways:giveawayItems,tasks:taskItems,rate:Number(rateRaw)||100,channelId:channelId||"",progressConfig:config,loadTimeMs:Date.now()-started});}
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
    const selectedWinner=String(entrants[randomInt(entrants.length)]),drawnAt=new Date().toISOString();
    const completed=await completeGiveaway(giveawayId,selectedWinner,drawnAt);
    if(!completed.completed)return json(res,409,{ok:false,error:"Не удалось завершить розыгрыш. Обнови список и попробуй ещё раз."});
    const winnerId=completed.winnerId||selectedWinner;
    const item=(await giveaways()).find(x=>x.id===giveawayId);
    await ensureGiveawayReward(item||{id:giveawayId},winnerId);
    await notifyGiveawayResult(item||{id:giveawayId},entrants,winnerId);
    return json(res,200,{ok:true,winnerId,title:item?.title||"",prize:item?.prize||"",entries:entrants.length,backendVersion:NORKA_BACKEND_VERSION});
   }
   if(action==="admin_delete_giveaway"){const giveawayId=clean(body.giveawayId,60);if(!giveawayId)return json(res,400,{ok:false,error:"Не указан розыгрыш"});const script="local n=redis.call('LLEN',KEYS[1]); local keep={}; local removed=0; for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local ok,item=pcall(cjson.decode,raw); if ok and tostring(item.id)==ARGV[1] then removed=removed+1 else table.insert(keep,raw) end end end; local participants=redis.call('SCARD',KEYS[2]); if removed>0 then redis.call('DEL',KEYS[1]); for i=#keep,1,-1 do redis.call('LPUSH',KEYS[1],keep[i]); end; redis.call('DEL',KEYS[2],KEYS[4]); redis.call('HDEL',KEYS[3],ARGV[1]); end; return {removed,participants}";const result=await redis(["EVAL",script,"4","norka:giveaways","norka:entries:"+giveawayId,"norka:giveaway-counts","norka:number-entries:"+giveawayId,giveawayId]);const removed=Array.isArray(result)?Number(result[0]):Number(result);if(!removed)return json(res,404,{ok:false,error:"Розыгрыш не найден в текущей базе Redis. Проверь подключение Яндекс-функции к той же базе, что использует приложение.",backendVersion:NORKA_BACKEND_VERSION});return json(res,200,{ok:true,deleted:removed,participantsRemoved:Array.isArray(result)?Number(result[1])||0:0,backendVersion:NORKA_BACKEND_VERSION});}
    if(action==="admin_create_numbered_giveaway"){
 const cost=Number(body.cost),capacity=Number(body.capacity),rawPrizes=Array.isArray(body.prizes)?body.prizes:[];
 if(!clean(body.title,100))return json(res,400,{ok:false,error:"Укажите название розыгрыша"});
 if(!Number.isInteger(cost)||cost<1||cost>100000)return json(res,400,{ok:false,error:"Стоимость номера должна быть от 1 до 100000 монет"});
 if(!Number.isInteger(capacity)||capacity<1||capacity>500)return json(res,400,{ok:false,error:"Количество номеров должно быть от 1 до 500"});
 if(rawPrizes.length<1||rawPrizes.length>25||rawPrizes.length>capacity)return json(res,400,{ok:false,error:"Количество призов должно быть от 1 до 25 и не превышать количество номеров"});
 const prizes=rawPrizes.map((p,i)=>({place:i+1,title:clean(p&&p.title,120),description:clean(p&&p.description,500),imageUrl:clean(p&&p.imageUrl,500)}));
 if(prizes.some(p=>!p.title))return json(res,400,{ok:false,error:"Укажите название каждого приза"});
 if(prizes.some(p=>p.imageUrl&&!/^https:\/\//i.test(p.imageUrl)))return json(res,400,{ok:false,error:"Ссылка на изображение должна начинаться с https://"});
 const item={id:"n"+Date.now()+"_"+randomInt(100000,999999),number:await nextGiveawayNumber(),type:"numbers",title:clean(body.title,100),description:clean(body.description,500),cost,capacity,prizes,status:"active",createdAt:new Date().toISOString(),entries:0};
 await redis(["LPUSH","norka:giveaways",JSON.stringify(item)]);
 try{await publishGiveawayStart(item);}catch(error){console.error("NORKA numbered giveaway channel announcement failed:",error&&error.message||"unknown");}
 try{await notifyAllUsers("number-giveaway-start:"+item.id,"🎟️ В Норке начался розыгрыш по номерам!\n"+item.title+"\nНомеров: "+capacity+" · цена: "+cost+" монет. Призов: "+prizes.length+". Открой Норку и выбери свои номера!");}catch(error){console.error("NORKA numbered giveaway announcement failed:",error&&error.message||"unknown");}
 return json(res,200,{ok:true,item});
}
   if(action==="admin_create_giveaway"){const cost=Number(body.cost),capacity=Number(body.capacity);if(!clean(body.title,100)||!clean(body.prize,120))return json(res,400,{ok:false,error:"Заполните название и приз"});if(!Number.isInteger(cost)||cost<1||cost>100000)return json(res,400,{ok:false,error:"Стоимость участия должна быть от 1 до 100000 монет"});if(!Number.isInteger(capacity)||capacity<1||capacity>1000000)return json(res,400,{ok:false,error:"Укажите количество мест от 1 до 1000000"});const item={id:"g"+Date.now()+"_"+randomInt(100000,999999),number:await nextGiveawayNumber(),title:clean(body.title,100),description:clean(body.description,500),prize:clean(body.prize,120),cost,capacity,status:"active",createdAt:new Date().toISOString(),entries:0};await redis(["LPUSH","norka:giveaways",JSON.stringify(item)]);try{await publishGiveawayStart(item);}catch(error){console.error("NORKA giveaway channel announcement failed:",error&&error.message||"unknown");}try{await notifyAllUsers("giveaway-start:"+item.id,"🎁 В Норке начался новый розыгрыш!\nПриз: "+item.prize+"\nУчастие: "+item.cost+" монет. Открой приложение, чтобы узнать подробности.");}catch(error){console.error("NORKA giveaway announcement failed:",error&&error.message||"unknown");}return json(res,200,{ok:true,item});}
   if(action==="admin_save_tasks"){if(!Array.isArray(body.tasks)||body.tasks.length>30)return json(res,400,{ok:false,error:"Некорректный список заданий"});const seen=new Set(),safe=[];for(const t of body.tasks){const id=clean(t.id,40),title=clean(t.title,100),reward=Number(t.reward);if(!id||!title||seen.has(id)||!Number.isInteger(reward)||reward<0||reward>10000)return json(res,400,{ok:false,error:"Проверьте названия и награды заданий (0–10000 ягод)"});seen.add(id);safe.push({id,title,description:clean(t.description,250),reward,type:["daily","subscription","activity"].includes(t.type)?t.type:"activity",url:clean(t.url,500),channelId:clean(String(t.channelId||""),40),active:Boolean(t.active)});}if(!safe.some(t=>t.id==="daily"))safe.unshift(DEFAULT_TASKS[0]);await set("norka:tasks",safe);return json(res,200,{ok:true,tasks:await tasks()});}
    if(action==="admin_create_task"){const title=clean(body.title,100),description=clean(body.description,250),url=clean(body.url,500),reward=Number(body.reward),type=body.type==="subscription"?"subscription":"activity";if(!title)return json(res,400,{ok:false,error:"Укажите название задания"});if(!Number.isInteger(reward)||reward<0||reward>10000)return json(res,400,{ok:false,error:"Награда должна быть от 0 до 10000 ягод"});const current=await tasks();if(current.length>=30)return json(res,409,{ok:false,error:"Достигнут лимит в 30 заданий"});let channelId="";if(type==="subscription"){if(!url)return json(res,400,{ok:false,error:"Для задания на подписку укажи публичную ссылку на канал MAX"});if(!process.env.MAX_BOT_TOKEN)return json(res,503,{ok:false,error:"Не настроен MAX_BOT_TOKEN"});let link="";try{const parsed=new URL(url);if(!["max.ru","www.max.ru","max.com","www.max.com"].includes(parsed.hostname.toLowerCase()))throw new Error("domain");const parts=parsed.pathname.split("/").filter(Boolean);if(parts.length!==1||parts[0].toLowerCase()==="join")throw new Error("private");link=decodeURIComponent(parts[0]).replace(/^@/,"");if(!/^[a-zA-Z][\\w-]{1,63}$/.test(link))throw new Error("format");}catch(error){return json(res,400,{ok:false,error:"Вставь публичную ссылку канала вида https://max.ru/channel_name. Пригласительные ссылки /join/ не подходят для автоматического поиска канала."});}const found=await requestMax({token:process.env.MAX_BOT_TOKEN,apiPath:"/chats/"+encodeURIComponent(link)});if(!found.ok)return json(res,422,{ok:false,error:"MAX не смог найти канал по этой ссылке. Проверь публичную ссылку и доступность канала."});channelId=String(found.data?.chat_id||found.data?.chatId||"");if(!channelId)return json(res,422,{ok:false,error:"MAX вернул данные канала без chat_id. Задание не создано."});}else if(url&&!/^https:\/\//i.test(url))return json(res,400,{ok:false,error:"Ссылка задания должна начинаться с https://"});const item={id:"task_"+Date.now()+"_"+randomInt(1000,9999),title,description:description||(type==="subscription"?"Подпишись на канал и вернись проверить подписку":"Выполни задание и отправь заявку на проверку"),reward,type,url,channelId,active:true,createdAt:new Date().toISOString()};const next=current.filter(t=>t.id!=="daily");next.push(item);await set("norka:tasks",[DEFAULT_TASKS[0],...next]);return json(res,200,{ok:true,item,tasks:await tasks()});}
    if(action==="admin_delete_task"){const taskId=clean(body.taskId,50);if(!taskId||DEFAULT_TASKS.some(t=>t.id===taskId))return json(res,400,{ok:false,error:"Постоянное системное задание нельзя удалить"});const current=await tasks(),item=current.find(t=>t.id===taskId);if(!item)return json(res,404,{ok:false,error:"Задание не найдено"});await set("norka:tasks",current.filter(t=>t.id!==taskId));const cleanup="local n=redis.call('LLEN',KEYS[1]); local removed=0; for i=n-1,0,-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local ok,p=pcall(cjson.decode,raw); if ok and tostring(p.taskId)==ARGV[1] then removed=removed+redis.call('LREM',KEYS[1],0,raw) end end end; return removed";await redis(["EVAL",cleanup,"1","norka:pending",taskId]);return json(res,200,{ok:true,tasks:await tasks()});}
   if(action==="admin_approve_task"){
   const id=clean(body.userId,80),taskId=clean(body.taskId,50);
   if(!id||!taskId)return json(res,400,{ok:false,error:"Нет пользователя или задания"});
   if(DEFAULT_TASKS.some(t=>t.id===taskId))return json(res,400,{ok:false,error:"Постоянные системные задания подтверждаются автоматически"});
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
    "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[1]));redis.call('INCRBY',KEYS[6],tonumber(ARGV[1]));redis.call('ZINCRBY',KEYS[7],tonumber(ARGV[1]),ARGV[5]);",
    "redis.call('SET',KEYS[1],'1','EX','31536000');",
    "claims[ARGV[2]]='done'; redis.call('SET',KEYS[4],cjson.encode(claims));",
    "redis.call('LPUSH',KEYS[3],ARGV[3]); redis.call('LTRIM',KEYS[3],'0','99');",
    "redis.call('LREM',KEYS[5],'1',ARGV[4]);",
    "return {current+tonumber(ARGV[1]),tonumber(redis.call('HGET',KEYS[2],'coins') or '0')}"
   ].join(" ");
   const result=await redis(["EVAL",script,"7","norka:taskapproved:"+id+":"+taskId,"norka:wallet:"+id,"norka:ledger:"+id,"norka:claims:"+id,"norka:pending","norka:berries:earned:"+id,"norka:berries:ranking",String(reward),taskId,ledgerItem,JSON.stringify(p),id]);
   await grantProgress(id,"task:"+taskId,"task",new Date().toISOString().slice(0,10));await notifyUser(id,"task-approved:"+taskId,"✅ Твоё задание «"+t.title+"» подтверждено!\n🍓 Начислено ягод: "+reward);return json(res,200,{ok:true,wallet:await readWallet(id),progress:await readProgress(id)});
  }
   return json(res,400,{ok:false,error:"Неизвестное действие"});
  }
  const verified=verifyInitData(req);if(!verified)return json(res,401,{ok:false,error:"Не удалось проверить данные MAX. Перезапусти мини-приложение."});
  const id=verified.id;const profile=verified.profile;
  if(action==="auth_check"){
   const pong=await redis(["PING"]);
   const existingUser=Boolean(await get(userKey(id)));
   return json(res,200,{ok:true,authenticated:true,redis:pong,existingUser});
  }
  if(action==="snapshot_check"){
   const u=await get(userKey(id));
   const wallet=await readWallet(id);
   const progress=await readProgress(id);
   const historyCount=Number(await redis(["LLEN","norka:ledger:"+id]))||0;
   return json(res,200,{ok:true,snapshot:{
    userExists:Boolean(u),
    userWallet:{berries:Number(u?.berries)||0,coins:Number(u?.coins)||0,lastDaily:u?.lastDaily||null},
    wallet,
    progress,
    historyCount
   }});
  }
   if(action==="bootstrap"){
    const started=Date.now(),timings={};
    const stage=async(name,fn)=>{const at=Date.now();try{return await fn();}finally{timings[name]=Date.now()-at;console.info("NORKA bootstrap stage",JSON.stringify({stage:name,durationMs:timings[name]}));}};
    let u=null,w={berries:0,coins:0},history=[],ts=[],gs=[],claims={},rate=100,progress={xp:0,level:1,streak:0,bestStreak:0,achievements:[]},rewards=[],community=null;
    try{const existing=Boolean(await stage("user_exists",()=>get(userKey(id))));u=await stage("user",()=>ensureUser(id,profile));if(!existing&&verified.startParam)await stage("referral_signup",()=>applyReferralSignup(id,verified.startParam));await stage("launch_task",()=>claimLaunchTask(id));}catch(error){console.error("NORKA bootstrap user:",error&&error.message||"unknown");return json(res,503,{ok:false,error:"Не удалось загрузить профиль пользователя.",code:"BOOTSTRAP_USER_READ_FAILED",stage:"user",backendVersion:NORKA_BACKEND_VERSION});}
    const runStage=async(name,fn,fallback)=>{try{return await stage(name,fn);}catch(error){console.error("NORKA bootstrap "+name+":",error&&error.message||"unknown");return fallback;}};
    const [walletResult,historyResult,tasksResult,giveawaysResult,claimsResult,rateResult,progressResult,rewardsResult,communityResult]=await Promise.all([
     runStage("wallet",()=>readWallet(id),{berries:Number(u?.berries)||0,coins:Number(u?.coins)||0}),
     runStage("history",()=>list("norka:ledger:"+id),[]),
     runStage("tasks",async()=>(await tasks()).filter(t=>t.active),[]),
     runStage("giveaways",async()=>{const items=(await list("norka:giveaways")).filter(g=>g.status==="active");return Promise.all(items.map(async g=>{if(g.type==="numbers"){const entries=await readNumberedEntries(g.id),userNumbers=entries.filter(x=>String(x.userId)===String(id)).map(x=>x.number);return {...g,entries:entries.length,soldNumbers:entries.map(x=>x.number),userNumbers,joined:userNumbers.length>0};}const [count,joined]=await Promise.all([redis(["SCARD","norka:entries:"+g.id]),redis(["SISMEMBER","norka:entries:"+g.id,id])]);return {...g,entries:Number(count)||0,joined:Number(joined)===1};}));},[]),
     runStage("claims",async()=>await get("norka:claims:"+id)||{},{}),
     runStage("rate",async()=>Number(await redis(["GET","norka:exchange-rate"]))||100,100),
     runStage("progress",async()=>{const day=new Date().toISOString().slice(0,10);await grantProgress(id,"visit:"+day,"visit",day,false);if(u?.lastDaily)await grantProgress(id,"daily:"+u.lastDaily,"daily",u.lastDaily,false);return readProgress(id);},progress),
     runStage("rewards",()=>readUserRewards(id),[]),
     runStage("community",()=>readCommunityData(id,u),{referral:{code:u?.referralCode||"",count:0,berries:0,coins:0},ranking:{top:[],rank:null,total:0,migrationComplete:false}})
    ]);
    w=walletResult;history=historyResult;ts=tasksResult;gs=giveawaysResult;claims=claimsResult;rate=rateResult;progress=progressResult;rewards=rewardsResult;community=communityResult;
    timings.total=Date.now()-started;console.info("NORKA bootstrap complete",JSON.stringify(timings));
    return json(res,200,{ok:true,user:u,wallet:w,tasks:ts,giveaways:gs,history,claims,rate,progress,rewards,community,backendVersion:NORKA_BACKEND_VERSION,diagnostics:timings});
   }
  await ensureUser(id,profile);
  if(action==="numbered_giveaway_state"){
   const giveawayId=clean(body.giveawayId,60);
   if(!giveawayId)return json(res,400,{ok:false,error:"Не указан розыгрыш"});
   const items=await list("norka:giveaways"),item=items.find(x=>String(x.id)===giveawayId&&x.type==="numbers");
   if(!item)return json(res,404,{ok:false,error:"Розыгрыш не найден"});
   const entries=await readNumberedEntries(giveawayId);
   const userNumbers=entries.filter(x=>String(x.userId)===String(id)).map(x=>x.number);
   return json(res,200,{ok:true,giveawayId,status:item.status,entries:entries.length,capacity:Number(item.capacity)||0,soldNumbers:entries.map(x=>x.number),userNumbers});
  }
  if(action==="daily_claim"){
   const day=new Date().toISOString().slice(0,10),t=(await tasks()).find(x=>x.type==="daily"&&x.active);
   const reward=t?Math.max(0,Math.floor(Number(t.reward)||0)):10,now=new Date().toISOString();
   const ledgerItem=JSON.stringify({type:"daily",title:"Ежедневная награда",berries:reward,at:now});
   const script=[
    "local raw=redis.call('GET',KEYS[1]); if not raw then return redis.error_reply('USER_NOT_FOUND') end;",
    "local user=cjson.decode(raw); local current=tonumber(redis.call('HGET',KEYS[2],'berries') or '0'); local coins=tonumber(redis.call('HGET',KEYS[2],'coins') or '0');",
    "if redis.call('GET',KEYS[4]) or user.lastDaily==ARGV[1] then return {0,current,coins} end;",
    "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[2]));redis.call('INCRBY',KEYS[5],tonumber(ARGV[2]));redis.call('ZINCRBY',KEYS[6],tonumber(ARGV[2]),ARGV[4]);",
    "user.lastDaily=ARGV[1]; redis.call('SET',KEYS[1],cjson.encode(user));",
    "redis.call('SET',KEYS[4],'1','EX','172800');",
    "redis.call('LPUSH',KEYS[3],ARGV[3]); redis.call('LTRIM',KEYS[3],'0','99');",
    "return {1,current+tonumber(ARGV[2]),coins}"
   ].join(" ");
   const result=await redis(["EVAL",script,"6",userKey(id),"norka:wallet:"+id,"norka:ledger:"+id,"norka:daily:"+id+":"+day,"norka:berries:earned:"+id,"norka:berries:ranking",day,String(reward),ledgerItem,id]);
   const already=Number(result[0])!==1;
   if(!already)grantProgress(id,"daily:"+day,"daily",day).catch(error=>console.error("NORKA daily progress failed:",error&&error.message||"unknown"));
   return json(res,200,{ok:true,already,wallet:{berries:Number(result[1])||0,coins:Number(result[2])||0},reward:already?0:reward});
  }
  if(action==="check_subscription"){
   const taskId=clean(body.taskId||"channel",50),t=(await tasks()).find(x=>x.id===taskId&&x.active&&x.type==="subscription");
   if(!t)return json(res,404,{ok:false,error:"Задание на подписку не найдено"});
   const channelId=t.channelId||(taskId==="channel"?await redis(["GET","norka:channel:chat_id"]):"");
   if(!channelId)return json(res,503,{ok:false,error:"Для этого задания не привязан ID канала MAX. Удали и создай задание заново по публичной ссылке."});
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
    "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[2]));redis.call('INCRBY',KEYS[6],tonumber(ARGV[2]));redis.call('ZINCRBY',KEYS[7],tonumber(ARGV[2]),ARGV[4]);",
    "redis.call('SET',KEYS[1],'1','EX','31536000');",
    "claims[ARGV[1]]='done'; redis.call('SET',KEYS[4],cjson.encode(claims));",
    "redis.call('LPUSH',KEYS[3],ARGV[3]); redis.call('LTRIM',KEYS[3],'0','99');",
    "return {current+tonumber(ARGV[2]),tonumber(redis.call('HGET',KEYS[2],'coins') or '0')}"
   ].join(" ");
   const result=await redis(["EVAL",script,"7","norka:taskclaim:"+id+":"+taskId,"norka:wallet:"+id,"norka:ledger:"+id,"norka:claims:"+id,"norka:taskapproved:"+id+":"+taskId,"norka:berries:earned:"+id,"norka:berries:ranking",taskId,String(reward),ledgerItem,id]);
   await grantProgress(id,"task:"+taskId,"task",new Date().toISOString().slice(0,10));return json(res,200,{ok:true,wallet:await readWallet(id),reward,claims:{[taskId]:"done"},progress:await readProgress(id)});
  }
  if(action==="request_task"){
   const taskId=clean(body.taskId,50),ts=await tasks(),t=ts.find(x=>x.id===taskId&&!DEFAULT_TASKS.some(d=>d.id===x.id)&&x.active&&x.type!=="daily");
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
  if(action==="wheel_status"){
   const day=wheelDayInfo(),used=Number(await redis(["GET",day.key+":"+id])||0);
   return json(res,200,{ok:true,used,remaining:Math.max(0,3-used),limit:3,resetAt:day.resetAt,timeZone:"Europe/Moscow"});
  }
  if(action==="spin_wheel"){
   const day=wheelDayInfo(),dailyKey=day.key+":"+id;
   const requestId=clean(body.requestId,80),cost=50;
   if(!requestId||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))return json(res,400,{ok:false,error:"Не удалось определить вращение. Попробуй ещё раз."});
   const prizes=[
    {index:0,icon:"🪙",title:"+1 монета",type:"coins",amount:1,chance:10},
    {index:1,icon:"🍓",title:"+25 ягод",type:"berries",amount:25,chance:25},
    {index:2,icon:"💰",title:"+2 монеты",type:"coins",amount:2,chance:7},
    {index:3,icon:"🧰",title:"+250 ягод",type:"berries",amount:250,chance:15},
    {index:4,icon:"💎",title:"+5 монет",type:"coins",amount:5,chance:5},
    {index:5,icon:"⭐",title:"+150 ягод",type:"berries",amount:150,chance:15},
    {index:6,icon:"💠",title:"+10 монет",type:"coins",amount:10,chance:3},
    {index:7,icon:"🏆",title:"+75 ягод",type:"berries",amount:75,chance:20}
   ];
   const roll=randomInt(100);let cumulative=0,prize=prizes[prizes.length-1];
   for(const item of prizes){cumulative+=item.chance;if(roll<cumulative){prize=item;break;}}
   const berryReward=prize.type==="berries"?prize.amount:0,coinReward=prize.type==="coins"?prize.amount:0,now=new Date().toISOString();
   const ledgerItem=JSON.stringify({type:"wheel_spin",title:"Колесо удачи — "+prize.title,berries:berryReward-cost,coins:coinReward,spentBerries:cost,rewardBerries:berryReward,rewardCoins:coinReward,at:now});
   const prizeData=JSON.stringify(prize);
   const script=[
    "local previous=redis.call('GET',KEYS[3]); if previous then local cached=cjson.decode(previous); cached.duplicate=true; return cjson.encode(cached) end;",
    "local used=tonumber(redis.call('GET',KEYS[6]) or '0'); if used>=3 then return cjson.encode({error='DAILY_LIMIT',used=used,remaining=0}) end;",
    "local b=tonumber(redis.call('HGET',KEYS[1],'berries') or '0'); local c=tonumber(redis.call('HGET',KEYS[1],'coins') or '0');",
    "if b<tonumber(ARGV[1]) then return cjson.encode({error='INSUFFICIENT',wallet={berries=b,coins=c},used=used,remaining=3-used}) end;",
    "local nextB=b-tonumber(ARGV[1])+tonumber(ARGV[2]); local nextC=c+tonumber(ARGV[3]);",
    "redis.call('HSET',KEYS[1],'berries',nextB,'coins',nextC);",
    "if tonumber(ARGV[2])>0 then redis.call('INCRBY',KEYS[4],tonumber(ARGV[2])); redis.call('ZINCRBY',KEYS[5],tonumber(ARGV[2]),ARGV[6]); end;",
    "redis.call('LPUSH',KEYS[2],ARGV[4]); redis.call('LTRIM',KEYS[2],'0','99');",
    "used=redis.call('INCR',KEYS[6]); redis.call('EXPIREAT',KEYS[6],tonumber(ARGV[8]));",
    "local result={wallet={berries=nextB,coins=nextC},prize=cjson.decode(ARGV[5]),duplicate=false,used=used,remaining=3-used};",
    "redis.call('SET',KEYS[3],cjson.encode(result),'EX','86400'); return cjson.encode(result)"
   ].join(" ");
   const raw=await redis(["EVAL",script,"6","norka:wallet:"+id,"norka:ledger:"+id,"norka:wheel:request:"+id+":"+requestId,"norka:berries:earned:"+id,"norka:berries:ranking",dailyKey,String(cost),String(berryReward),String(coinReward),ledgerItem,prizeData,id,String(day.resetAt)]);
   const result=typeof raw==="string"?JSON.parse(raw):raw;
   if(result?.error==="INSUFFICIENT")return json(res,409,{ok:false,error:"Для вращения нужно 50 ягод. Пополни запас и попробуй ещё раз.",wallet:result.wallet});
   return json(res,200,{ok:true,wallet:result.wallet,prize:result.prize,duplicate:Boolean(result.duplicate)});
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
   let progress=null;
   try{
    await grantProgress(id,"exchange:"+requestId,"exchange",new Date().toISOString().slice(0,10));
    progress=await readProgress(id);
   }catch(error){
    console.error("NORKA exchange progress failed:",error&&error.message||"unknown");
   }
   return json(res,200,{ok:true,wallet:{berries:Number(result[0])||0,coins:Number(result[1])||0},coins,duplicate:Number(result[2])===0,progress});
  }

  if(action==="buy_numbered_entries"){
   const giveawayId=clean(body.giveawayId,60),rawNumbers=Array.isArray(body.numbers)?body.numbers:[],numbers=[...new Set(rawNumbers.map(Number))];
   if(!giveawayId||!numbers.length||numbers.length>500||numbers.some(n=>!Number.isInteger(n)||n<1))return json(res,400,{ok:false,error:"Выбери корректные номера"});
   const gs=await giveaways(),g=gs.find(x=>x.id===giveawayId&&x.type==="numbers"&&x.status==="active");
   if(!g)return json(res,404,{ok:false,error:"Розыгрыш по номерам не найден или уже завершён"});
   if(numbers.some(n=>n>Number(g.capacity)))return json(res,400,{ok:false,error:"Один из номеров выходит за пределы розыгрыша"});
   const total=Number(g.cost)*numbers.length;if(!Number.isSafeInteger(total)||total<1)return json(res,409,{ok:false,error:"Некорректная стоимость покупки"});
   const now=new Date().toISOString(),ledgerItem=JSON.stringify({type:"numbered_giveaway_entry",title:"Номера: "+g.title+" ("+numbers.join(", ")+")",coins:-total,at:now});
   const script=[
    "local n=redis.call('LLEN',KEYS[5]);local found=false;local cap=0;local unit=tonumber(ARGV[3]);",
    "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[5],i);if raw then local item=cjson.decode(raw);if tostring(item.id)==ARGV[2] then found=true;if item.status~='active' or item.type~='numbers' then return redis.error_reply('CLOSED') end;cap=tonumber(item.capacity) or 0;break end end end;",
    "if not found then return redis.error_reply('NOT_FOUND') end;",
    "local chosen=cjson.decode(ARGV[1]);if #chosen==0 then return redis.error_reply('NO_NUMBERS') end;",
    "for _,v in ipairs(chosen) do local num=tostring(v);if tonumber(v)<1 or tonumber(v)>cap or tonumber(v)~=math.floor(tonumber(v)) then return redis.error_reply('BAD_NUMBER') end;if redis.call('HEXISTS',KEYS[1],num)==1 then return redis.error_reply('NUMBER_TAKEN') end end;",
    "local sold=redis.call('HLEN',KEYS[1]);if sold+#chosen>cap then return redis.error_reply('SOLD_OUT') end;",
    "local coins=tonumber(redis.call('HGET',KEYS[2],'coins') or '0');local berries=tonumber(redis.call('HGET',KEYS[2],'berries') or '0');local total=unit*#chosen;if coins<total then return redis.error_reply('INSUFFICIENT') end;",
    "redis.call('HSET',KEYS[2],'coins',coins-total);for _,v in ipairs(chosen) do redis.call('HSET',KEYS[1],tostring(v),ARGV[4]) end;",
    "local soldNow=redis.call('HLEN',KEYS[1]);redis.call('LPUSH',KEYS[3],ARGV[5]);redis.call('LTRIM',KEYS[3],'0','99');",
    "if soldNow==cap then for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[5],i);if raw then local item=cjson.decode(raw);if tostring(item.id)==ARGV[2] and item.status=='active' then item.status='drawing';redis.call('LSET',KEYS[5],i,cjson.encode(item));break end end end end;",
    "return {coins-total,berries,soldNow,(soldNow==cap) and 1 or 0}"
   ].join(" ");
   const result=await redis(["EVAL",script,"5","norka:number-entries:"+giveawayId,"norka:wallet:"+id,"norka:ledger:"+id,"norka:giveaway-counts","norka:giveaways",JSON.stringify(numbers),giveawayId,String(g.cost),id,ledgerItem]);
   let draw=null;if(Number(result[3])===1){try{draw=await drawNumberedGiveaway(giveawayId);}catch(error){console.error("NORKA numbered giveaway draw deferred:",error&&error.message||"unknown");}}
   let progress=null;try{await grantProgress(id,"numbered-giveaway:"+giveawayId,"giveaway",new Date().toISOString().slice(0,10));progress=await readProgress(id);}catch(error){console.error("NORKA numbered giveaway progress failed:",error&&error.message||"unknown");}
   return json(res,200,{ok:true,wallet:{coins:Number(result[0])||0,berries:Number(result[1])||0},entries:Number(result[2])||0,giveawayCompleted:Boolean(draw&&draw.completed),winners:draw?.winners||[],progress});
  }

  if(action==="enter_giveaway"){
   const giveawayId=clean(body.giveawayId,60),gs=await giveaways(),g=gs.find(x=>x.id===giveawayId&&x.status==="active");
   if(!g)return json(res,404,{ok:false,error:"Розыгрыш не найден"});
   const cost=Math.floor(Number(g.cost)||0);
   if(cost<1)return json(res,409,{ok:false,error:"Некорректная стоимость участия"});
   const now=new Date().toISOString(),ledgerItem=JSON.stringify({type:"giveaway_entry",title:"Участие: "+g.title,coins:-cost,at:now});
   const script=[
    "local n=redis.call('LLEN',KEYS[5]); local found=false;",
    "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[5],i); if raw then local item=cjson.decode(raw);",
    "if tostring(item.id)==ARGV[3] then found=true; if item.status~='active' then return redis.error_reply('CLOSED') end;",
    "break end end end;",
    "if not found then return redis.error_reply('NOT_FOUND') end;",
    "if redis.call('SISMEMBER',KEYS[1],ARGV[1])==1 then return redis.error_reply('ALREADY') end;",
    "local cap=0; for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[5],i); if raw then local item=cjson.decode(raw); if tostring(item.id)==ARGV[3] then cap=tonumber(item.capacity) or 0; break end end end;",
    "local sold=redis.call('SCARD',KEYS[1]); if cap>0 and sold>=cap then return redis.error_reply('SOLD_OUT') end;",
    "local c=tonumber(redis.call('HGET',KEYS[2],'coins') or '0'); local cost=tonumber(ARGV[2]);",
    "if c<cost then return redis.error_reply('INSUFFICIENT') end;",
    "redis.call('HSET',KEYS[2],'coins',c-cost); redis.call('SADD',KEYS[1],ARGV[1]);",
    "local soldNow=redis.call('SCARD',KEYS[1]); redis.call('HSET',KEYS[3],ARGV[3],soldNow);",
    "redis.call('LPUSH',KEYS[4],ARGV[4]); redis.call('LTRIM',KEYS[4],'0','99');",
    "if cap>0 and soldNow==cap then for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[5],i); if raw then local item=cjson.decode(raw); if tostring(item.id)==ARGV[3] and item.status=='active' then item.status='drawing'; redis.call('LSET',KEYS[5],i,cjson.encode(item)); break end end end end;",
    "return {c-cost,tonumber(redis.call('HGET',KEYS[2],'berries') or '0'),(cap>0 and soldNow==cap) and 1 or 0}"
   ].join(" ");
   const result=await redis(["EVAL",script,"5","norka:entries:"+giveawayId,"norka:wallet:"+id,"norka:giveaway-counts","norka:ledger:"+id,"norka:giveaways",id,String(cost),giveawayId,ledgerItem]);
   let winnerId=null;
   if(Number(result[2])===1){
    const entrants=await redis(["SMEMBERS","norka:entries:"+giveawayId]);
    if(Array.isArray(entrants)&&entrants.length){
     const selected=String(entrants[randomInt(entrants.length)]),drawnAt=new Date().toISOString();
     const completed=await completeGiveaway(giveawayId,selected,drawnAt);
     const current=(await giveaways()).find(x=>x.id===giveawayId);
     winnerId=completed.completed?(completed.winnerId||selected):current?.winnerId||null;
     if(winnerId){await ensureGiveawayReward(current||{id:giveawayId},winnerId);await notifyGiveawayResult(current||{id:giveawayId},entrants,winnerId);}
    }
   }
   let progress=null;
   try{
    await grantProgress(id,"giveaway:"+giveawayId,"giveaway",new Date().toISOString().slice(0,10));
    progress=await readProgress(id);
   }catch(error){
    console.error("NORKA giveaway progress failed:",error&&error.message||"unknown");
   }
   return json(res,200,{ok:true,wallet:{coins:Number(result[0])||0,berries:Number(result[1])||0},giveawayCompleted:Boolean(winnerId),winnerId,progress});
  }
  return json(res,400,{ok:false,error:"Неизвестное действие"});
 }catch(e){const msg=String(e&&e.message||"Ошибка сервера");if(msg.includes("INSUFFICIENT"))return json(res,409,{ok:false,error:"Недостаточно средств на балансе"});if(msg.includes("DAILY_ALREADY"))return json(res,409,{ok:false,error:"Ежедневная награда уже получена"});if(msg.includes("SUBSCRIPTION_ALREADY"))return json(res,409,{ok:false,error:"Награда за подписку уже получена"});if(msg.includes("TASK_ALREADY"))return json(res,409,{ok:false,error:"Заявка уже отправлена или задание подтверждено"});if(msg.includes("DRAW_ALREADY"))return json(res,409,{ok:false,error:"Победитель уже определяется или розыгрыш завершён"});if(msg.includes("CLOSED"))return json(res,409,{ok:false,error:"Розыгрыш уже завершён"});if(msg.includes("ALREADY"))return json(res,409,{ok:false,error:"Ты уже участвуешь в этом розыгрыше"});if(msg.includes("SOLD_OUT"))return json(res,409,{ok:false,error:"Все места в этом розыгрыше уже заняты"});if(msg.includes("NUMBER_TAKEN"))return json(res,409,{ok:false,error:"Один или несколько номеров уже купили. Обнови сетку и выбери свободные номера."});if(msg.includes("BAD_NUMBER"))return json(res,400,{ok:false,error:"Выбран некорректный номер"});if(msg.includes("NO_NUMBERS"))return json(res,400,{ok:false,error:"Выбери хотя бы один номер"});console.error("NORKA API:",msg);return json(res,500,{ok:false,error:"Внутренняя ошибка сервера Норки.",code:"NORKA_INTERNAL_ERROR",backendVersion:NORKA_BACKEND_VERSION});}
}; 