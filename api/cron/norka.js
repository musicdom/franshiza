const { requestMax } = require("../../lib/max-api");
const { randomInt } = require("crypto");
function json(res,status,data){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(data));}
async function redis(parts){const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL,token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;if(!url||!token)throw new Error("Redis not configured");const r=await fetch(url.replace(/\/$/,""),{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(parts)});const d=await r.json();if(!r.ok||d.error)throw new Error("Redis error");return d.result;}
async function send(id,text){const token=process.env.MAX_BOT_TOKEN;if(!token)return false;const r=await requestMax({token,method:"POST",apiPath:"/messages?user_id="+encodeURIComponent(String(id)),body:{text}});return !!r.ok;}
module.exports=async function(req,res){const secret=process.env.CRON_SECRET;if(!secret||req.headers.authorization!=="Bearer "+secret)return json(res,401,{ok:false,error:"Unauthorized"});try{const day=new Date().toISOString().slice(0,10),keys=await redis(["KEYS","norka:user:*"]);let reminders=0;for(const key of (Array.isArray(keys)?keys:[])){if(key.split(":").length!==3)continue;const raw=await redis(["GET",key]);if(!raw)continue;let u;try{u=JSON.parse(raw)}catch{continue;}if(u.lastDaily===day)continue;const id=key.slice(11),mark="norka:reminder:"+id+":"+day;if(await redis(["GET",mark]))continue;if(await send(id,"🍓 Твоя ежедневная награда в Норке уже ждёт! Загляни в приложение и продолжай серию посещений.")){await redis(["SET",mark,"1","EX","172800"]);reminders++;}}let closedGiveaways=0,finishMessages=0,refundedGiveaways=0,refundMessages=0,winnerMessages=0;
  const rows=await redis(["LRANGE","norka:giveaways","0","99"]);
  for(const raw of Array.isArray(rows)?rows:[]){
   let item;try{item=JSON.parse(raw)}catch{continue;}
   const endTime=item.endsAt?new Date(item.endsAt).getTime():0;
   if(item.status==="drawing"){
    const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
    if(Array.isArray(entrants)&&entrants.length){
     const selected=String(entrants[randomInt(entrants.length)]),drawnAt=new Date().toISOString();
     const finishScript="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local g=cjson.decode(raw); if tostring(g.id)==ARGV[1] then if g.status~='drawing' then return 0 end; g.status='completed'; g.winnerId=ARGV[2]; g.drawnAt=ARGV[3]; redis.call('LSET',KEYS[1],i,cjson.encode(g)); return 1 end end end; return 0";
     await redis(["EVAL",finishScript,"1","norka:giveaways",String(item.id),selected,drawnAt]);
    }
    const fresh=await redis(["LRANGE","norka:giveaways","0","99"]);
    for(const r of Array.isArray(fresh)?fresh:[]){try{const g=JSON.parse(r);if(String(g.id)===String(item.id)){item=g;break;}}catch{}}
   }
   if(item.status==="active"&&item.endsAt&&Number.isFinite(endTime)&&endTime<=Date.now()){
    const refundScript=[
     "local n=redis.call('LLEN',KEYS[1]); local idx=nil; local g=nil;",
     "for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local x=cjson.decode(raw); if tostring(x.id)==ARGV[1] then idx=i; g=x; break end end end;",
     "if not g or g.status~='active' then return 0 end;",
     "local users=redis.call('SMEMBERS',KEYS[2]); local cap=tonumber(g.capacity) or 0; if cap>0 and #users>=cap then g.status='drawing'; redis.call('LSET',KEYS[1],idx,cjson.encode(g)); return -1 end; local cost=tonumber(g.cost) or 0;",
     "for _,uid in ipairs(users) do local marker='norka:giveaway:refund:'..ARGV[1]..':'..uid;",
     "if redis.call('SET',marker,'1','NX','EX','31536000') then redis.call('HINCRBY','norka:wallet:'..uid,'coins',cost);",
     "local entry=cjson.encode({type='giveaway_refund',title='Возврат монет: '..tostring(g.title or 'розыгрыш'),coins=cost,at=ARGV[2]});",
     "redis.call('LPUSH','norka:ledger:'..uid,entry); redis.call('LTRIM','norka:ledger:'..uid,'0','99'); end end;",
     "g.status='refunded'; g.refundedAt=ARGV[2]; redis.call('LSET',KEYS[1],idx,cjson.encode(g)); return #users"
    ].join(" ");
    const refundResult=Number(await redis(["EVAL",refundScript,"2","norka:giveaways","norka:entries:"+item.id,String(item.id),new Date().toISOString()]));
    if(refundResult===0||refundResult===-1){
     const fresh=await redis(["LRANGE","norka:giveaways","0","99"]);
     for(const r of Array.isArray(fresh)?fresh:[]){try{const g=JSON.parse(r);if(String(g.id)===String(item.id)){item=g;break;}}catch{}}
     if(item.status==="drawing"){
      const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
      if(Array.isArray(entrants)&&entrants.length){
       const selected=String(entrants[randomInt(entrants.length)]),drawnAt=new Date().toISOString();
       const finishScript="local n=redis.call('LLEN',KEYS[1]); for i=0,n-1 do local raw=redis.call('LINDEX',KEYS[1],i); if raw then local g=cjson.decode(raw); if tostring(g.id)==ARGV[1] then if g.status~='drawing' then return 0 end; g.status='completed'; g.winnerId=ARGV[2]; g.drawnAt=ARGV[3]; redis.call('LSET',KEYS[1],i,cjson.encode(g)); return 1 end end end; return 0";
       await redis(["EVAL",finishScript,"1","norka:giveaways",String(item.id),selected,drawnAt]);
       const afterDraw=await redis(["LRANGE","norka:giveaways","0","99"]);
       for(const r of Array.isArray(afterDraw)?afterDraw:[]){try{const g=JSON.parse(r);if(String(g.id)===String(item.id)){item=g;break;}}catch{}}
      }
     }
    }else if(refundResult>0){
     item.status="refunded";refundedGiveaways++;
    }
   }
   if(item.status==="refunded"){
    const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
    for(const userId of Array.isArray(entrants)?entrants:[]){
     const mark="norka:notify:giveaway-refund:"+item.id+":"+userId;if(await redis(["GET",mark]))continue;
     const message="⏰ Розыгрыш «"+String(item.title||"Норка").slice(0,100)+"» завершён. К сожалению, не все места были заполнены. 🍓 Монеты за участие возвращены на твой баланс. Проверь кошелёк в приложении.";
     if(await send(userId,message)){await redis(["SET",mark,"1","EX","2592000"]);refundMessages++;}
    }
   }
   if(item.status==="completed"&&item.winnerId){
    const mark="norka:notify:sent:"+item.winnerId+":giveaway-winner:"+item.id;
    if(!(await redis(["GET",mark]))){
     const message="🏆 Поздравляем! Ты победил в розыгрыше «"+String(item.title||"Норка").slice(0,100)+"»!\n🎁 Твой приз: "+String(item.prize||"уточни у организатора").slice(0,120)+"\nДля получения приза свяжись с организатором через поддержку приложения.";
     if(await send(item.winnerId,message)){await redis(["SET",mark,"1","EX","2592000"]);winnerMessages++;}
    }
   }
   if(item.status==="completed"&&item.winnerId){
    const entrants=await redis(["SMEMBERS","norka:entries:"+item.id]);
    for(const userId of Array.isArray(entrants)?entrants:[]){
     if(String(userId)===String(item.winnerId||""))continue;
     const mark="norka:notify:sent:"+userId+":giveaway-end:"+item.id;if(await redis(["GET",mark]))continue;
     if(await send(userId,"⏰ Розыгрыш «"+String(item.title||"Норка").slice(0,100)+"» завершён. Спасибо за участие! Результаты доступны в приложении.")){await redis(["SET",mark,"1","EX","2592000"]);finishMessages++;}
    }
   }
  }
  return json(res,200,{ok:true,reminders,closedGiveaways,finishMessages,refundedGiveaways,refundMessages,winnerMessages});}catch(e){console.error("NORKA CRON",e.message);return json(res,500,{ok:false,error:"Cron failed"});}};
