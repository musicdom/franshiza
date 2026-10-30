const { requestMax } = require("../../lib/max-api");
function json(res,status,data){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(data));}
async function redis(parts){const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL,token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;if(!url||!token)throw new Error("Redis not configured");const r=await fetch(url.replace(/\/$/,""),{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(parts)});const d=await r.json();if(!r.ok||d.error)throw new Error("Redis error");return d.result;}
async function send(id,text){const token=process.env.MAX_BOT_TOKEN;if(!token)return false;const r=await requestMax({token,method:"POST",apiPath:"/messages?user_id="+encodeURIComponent(String(id)),body:{text}});return !!r.ok;}
module.exports=async function(req,res){const secret=process.env.CRON_SECRET;if(!secret||req.headers.authorization!=="Bearer "+secret)return json(res,401,{ok:false,error:"Unauthorized"});try{const day=new Date().toISOString().slice(0,10),keys=await redis(["KEYS","norka:user:*"]);let reminders=0;for(const key of (Array.isArray(keys)?keys:[])){if(key.split(":").length!==3)continue;const raw=await redis(["GET",key]);if(!raw)continue;let u;try{u=JSON.parse(raw)}catch{continue;}if(u.lastDaily===day)continue;const id=key.slice(11),mark="norka:reminder:"+id+":"+day;if(await redis(["GET",mark]))continue;if(await send(id,"🍓 Твоя ежедневная награда в Норке уже ждёт! Загляни в приложение и продолжай серию посещений.")){await redis(["SET",mark,"1","EX","172800"]);reminders++;}}let closedGiveaways=0,finishMessages=0;
  const rows=await redis(["LRANGE","norka:giveaways","0","99"]);
  for(const raw of Array.isArray(rows)?rows:[]){
   let item;try{item=JSON.parse(raw)}catch{continue;}
   if(!item.endsAt||new Date(item.endsAt).getTime()>Date.now())continue;
   if(item.status==="active"){
    const script="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local g=cjson.decode(raw); if tostring(g.id)==ARGV[1] and g.status=='active' then g.status='completed'; redis.call('LSET',KEYS[1],i,cjson.encode(g)); return 1 end end end; return 0";
    if(Number(await redis(["EVAL",script,"1","norka:giveaways",String(item.id)]))===1)closedGiveaways++;
   }
   if(item.status==="completed"){
    const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
    for(const userId of Array.isArray(entrants)?entrants:[]){
     const mark="norka:notify:giveaway-end:"+item.id+":"+userId;if(await redis(["GET",mark]))continue;
     if(await send(userId,"⏰ Розыгрыш «"+String(item.title||"Норка").slice(0,100)+"» завершён. Спасибо за участие! Результаты доступны в приложении.")){await redis(["SET",mark,"1","EX","2592000"]);finishMessages++;}
    }
   }
  }
  return json(res,200,{ok:true,reminders,closedGiveaways,finishMessages});}catch(e){console.error("NORKA CRON",e.message);return json(res,500,{ok:false,error:"Cron failed"});}};
