const { requestMax, sendMaxMessage } = require("../lib/max-api");
const { handleGroupMessage } = require("./norka-group-assistant");
function redisConfig(){const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL;const token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;return url&&token?{url:url.replace(/\/$/, ""),token}:null;}
async function redis(parts){const c=redisConfig();if(!c)throw new Error("Redis is not configured");const r=await fetch(c.url,{method:"POST",headers:{Authorization:"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify(parts)});if(!r.ok)throw new Error("Redis HTTP "+r.status);const d=await r.json();if(d.error)throw new Error(d.error);return d.result;}
function json(res,status,data){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));}
function clean(v,n=200){return typeof v==="string"?v.trim().slice(0,n):"";}
function formatGroupMessage(text){
 const content=String(text||"").trim();
 if(!content)return "🌿 **НОРКА**";
 if(/^🌿\s*\*\*НОРКА\*\*/i.test(content))return content;
 return "🌿 **НОРКА**\n\n"+content;
}
async function send(chatId,text,attachments=[]){const token=process.env.MAX_BOT_TOKEN;const body={text:formatGroupMessage(text),format:"markdown"};if(attachments.length)body.attachments=attachments;const r=await requestMax({token,method:"POST",apiPath:"/messages?chat_id="+encodeURIComponent(String(chatId)),body});if(!r.ok)throw new Error("MAX message failed: "+r.status+" "+String(r.raw||"").slice(0,800));}
async function sendUser(userId,text,attachments=[]){const token=process.env.MAX_BOT_TOKEN;if(!token)throw new Error("MAX_BOT_TOKEN is not configured");const body={text,format:"markdown"};if(attachments.length)body.attachments=attachments;const r=await requestMax({token,method:"POST",apiPath:"/messages?user_id="+encodeURIComponent(String(userId)),body});if(!r.ok)throw new Error("MAX user message failed: "+r.status+" "+String(r.raw||"").slice(0,800));}
async function readUserWallet(userId){
 const raw=await redis(["HGETALL","norka:wallet:"+String(userId)]);
 const wallet={berries:0,coins:0};
 if(Array.isArray(raw))for(let i=0;i+1<raw.length;i+=2){
  if(raw[i]==="berries"||raw[i]==="coins")wallet[raw[i]]=Math.max(0,Number(raw[i+1])||0);
 }
 return wallet;
}
function asksForWallet(text){
 const value=String(text||"").toLowerCase().replace(/ё/g,"е");
 return /(баланс|сколько\s+(у\s+меня\s+)?(ягод|монет)|мои\s+(ягоды|монеты)|остаток\s+(ягод|монет)|кошелек|кошелёк)/i.test(value);
}
function asksForBerryBalance(text){
 const value=String(text||"").toLowerCase().replace(/ё/g,"е");
 return /(баланс\s+(моих\s+)?ягод|сколько\s+(у\s+меня\s+)?ягод|мои\s+ягоды|покажи\s+(мой\s+)?баланс\s+ягод|остаток\s+ягод)/i.test(value);
}
function supportButtons(){return [{type:"inline_keyboard",payload:{buttons:[[{type:"callback",text:"Да",payload:"norka_support_yes"},{type:"callback",text:"Нет",payload:"norka_support_no"}]]}}];}
function replyButton(ticketId){return [{type:"inline_keyboard",payload:{buttons:[[{type:"callback",text:"Ответить клиенту",payload:"norka_support_reply:"+ticketId}]]}}];}
function appButton(){return [{type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"🌿 Открыть мини-приложение Норки",web_app:"se14711525_bot"}]]}}];}
function isAppRelated(text){return /(мини.?прилож|приложени|кошел|баланс|ягод|монет|обмен|задан|розыгрыш|розыгр|приз|профил|достижен)/i.test(String(text||""));}
function adminUserId(){return clean(process.env.MAX_ADMIN_USER_ID||process.env.MAX_OWNER_USER_ID||"163701646",80);}
function allowedLinkHosts() {
 const configured=clean(process.env.NORKA_ALLOWED_LINK_DOMAINS||"",1000);
 const defaults=[];
 return (configured?configured.split(","):defaults).map(x=>x.trim().toLowerCase().replace(/^https?:\/\//,"").replace(/\/.*$/,"").replace(/^www\./,"")).filter(Boolean);
}
function extractLinks(message, update) {
 const body=message.body||{};
 const text=String(body.text||message.text||update.body?.text||update.text||"");
 const urls=text.match(/(?:https?:\/\/|www\.)[^\s<>()]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()]*)?/gi)||[];
 const attachments=[...(Array.isArray(body.attachments)?body.attachments:[]),...(Array.isArray(message.attachments)?message.attachments:[])];
 for(const item of attachments) {
  const raw=JSON.stringify(item||{});
  const found=raw.match(/https?:\\?\/\\?\/[^"\\\s<>]+/gi)||[];
  urls.push(...found);
 }
 return [...new Set(urls.map(x=>x.replace(/\\\//g,"/").replace(/[.,!?;:)\]}]+$/,"")))];
}
function isExternalLink(url) {
 try {
  const normalized=/^www\./i.test(url)?"https://"+url:url;
  const parsed=new URL(normalized);
  const host=parsed.hostname.toLowerCase().replace(/^www\./,"");
  // The Norka app's own MAX entry point is allowed; arbitrary max.ru links are not.
  if(host==="max.ru" && /^\/se14711525_bot\/?$/i.test(parsed.pathname))return false;
  const allowed=allowedLinkHosts();
  return !allowed.some(domain=>host===domain||host.endsWith("."+domain));
 } catch { return false; }
}
async function moderateGroupLink({chatId,userId,messageId,message,update}) {
 const links=extractLinks(message,update).filter(isExternalLink);
 if(!links.length)return null;
 if(!messageId)return {action:"link_detected_without_message_id"};
 const token=process.env.MAX_BOT_TOKEN;
 const deleted=await requestMax({token,method:"DELETE",apiPath:"/messages?message_id="+encodeURIComponent(String(messageId))});
 if(!deleted.ok || deleted.data?.success===false) {
  console.error("NORKA moderation message deletion failed:",deleted.status,String(deleted.raw||"").slice(0,300));
  return {action:"link_delete_failed"};
 }
 const strikeKey="norka:moderation:strikes:"+chatId+":"+userId;
 const strike=Number(await redis(["INCR",strikeKey]));
 if(strike>=3) {
  const removed=await requestMax({token,method:"DELETE",apiPath:"/chats/"+encodeURIComponent(String(chatId))+"/members?user_id="+encodeURIComponent(String(userId))+"&block=true"});
  if(!removed.ok || removed.data?.success===false) {
   console.error("NORKA moderation removal failed:",removed.status,String(removed.raw||"").slice(0,300));
   await send(chatId,"⛔ Ссылка удалена. Это третье нарушение правил публикации ссылок. Не удалось автоматически исключить участника — требуется администратор.");
   return {action:"link_third_strike_remove_failed",strike};
  }
  await send(chatId,"⛔ Ссылка удалена. За третье нарушение участник исключён из чата. Блокировка от повторного входа зависит от типа чата MAX.");
  return {action:"link_user_removed",strike};
 }
 const left=3-strike;
 await send(chatId,"⚠️ В этом чате запрещены ссылки, не относящиеся к Норке. Ваше сообщение удалено. Предупреждение "+strike+"/3. Ещё "+left+" нарушение"+(left===1?" —":" —")+" и Норка исключит вас из чата.");
 return {action:"link_warning",strike};
}

function userIdFromUpdate(u){const m=u.message||{},cm=u.callback?.message||{},s=m.sender||m.from||cm.sender||cm.from||u.user||u.from||u.callback?.user||{};return clean(String(u.callback?.user?.user_id||u.callback?.user?.id||u.callback?.message?.recipient?.user_id||u.user?.user_id||u.user?.id||u.user_id||s.user_id||s.id||""),80);}
async function grantLaunchReward(userId){
 const reward=50,now=new Date().toISOString(),item=JSON.stringify({type:"task_reward",taskId:"launch",title:"Награда: Запустить бота",berries:reward,at:now});
 const script=[
  "if redis.call('GET',KEYS[1]) then return 0 end;",
  "local raw=redis.call('GET',KEYS[4]);local claims={};if raw then claims=cjson.decode(raw) end;",
  "if claims['launch']=='done' then redis.call('SET',KEYS[1],'1');return 0 end;",
  "redis.call('HINCRBY',KEYS[2],'berries',tonumber(ARGV[1]));redis.call('INCRBY',KEYS[5],tonumber(ARGV[1]));redis.call('ZINCRBY',KEYS[6],tonumber(ARGV[1]),ARGV[3]);",
  "claims['launch']='done';redis.call('SET',KEYS[4],cjson.encode(claims));redis.call('SET',KEYS[1],'1');",
  "redis.call('LPUSH',KEYS[3],ARGV[2]);redis.call('LTRIM',KEYS[3],'0','99');return 1"
 ].join(" ");
 return Number(await redis(["EVAL",script,"6","norka:taskclaim:"+userId+":launch","norka:wallet:"+userId,"norka:ledger:"+userId,"norka:claims:"+userId,"norka:berries:earned:"+userId,"norka:berries:ranking",String(reward),item,String(userId)]) )===1;
}
module.exports=async function handler(req,res){
 if(req.method!=="POST"){res.setHeader("Allow","POST");return json(res,405,{ok:false,error:"Method not allowed"});}
 const secret=process.env.MAX_WEBHOOK_SECRET;if(!secret)return json(res,503,{ok:false,error:"Webhook secret is not configured"});
 if(req.headers["x-max-bot-api-secret"]!==secret)return json(res,401,{ok:false,error:"Unauthorized"});
 let root=req.body&&typeof req.body==="object"?req.body:{};
 if(typeof root==="string"){try{root=JSON.parse(root);}catch{return json(res,200,{ok:false,error:"Invalid JSON"});}}
 const updates=Array.isArray(root.updates)?root.updates:[root];
 if(Array.isArray(root.updates)){
  const results=[];
  for(const update of updates){
   const normalizedUpdate={...root,...(update&&typeof update==="object"?update:{})};
   delete normalizedUpdate.updates;
   normalizedUpdate.update_type=update?.update_type||update?.type||root.update_type||root.type||"";
   let subStatus=200,subBody="";
   const subRes={status(code){subStatus=Number(code)||200;return this;},setHeader(){return this;},end(value=""){subBody=String(value||"");}};
   await module.exports({...req,body:normalizedUpdate},subRes);
   let parsed={};try{parsed=JSON.parse(subBody||"{}");}catch{}
   results.push({status:subStatus,...parsed});
  }
  return json(res,200,{ok:true,received:true,results});
 }
 const u=updates[0]||{};
 const type=u.update_type||u.type||root.update_type||root.type||"";
 const callback=u.callback||{};
 const callbackEventKey=type==="message_callback"?[callback.callback_id,callback.id,callback.timestamp].filter(Boolean).join(":"):"";
 const eventId=clean(String(u.update_id||u.updateId||u.event_id||callbackEventKey||(u.message&&u.message.body&&u.message.body.mid)||""),180);
 const dedupeKey=eventId?"norka:webhook:processed:"+eventId:"";
 const chatId=u.chat_id||(u.message&&u.message.recipient&&u.message.recipient.chat_id)||(u.callback&&u.callback.message&&u.callback.message.recipient&&u.callback.message.recipient.chat_id);

 try{
  if(dedupeKey){
   try{
    const claimed=await redis(["SET",dedupeKey,"1","NX","EX","604800"]);
    if(!claimed)return json(res,200,{ok:true,duplicate:true});
   }catch(error){
    // Do not let a Redis outage prevent group assistant replies.
    console.error("NORKA webhook dedupe Redis unavailable:",error&&error.message||"unknown");
   }
  }
  if(type==="bot_added" && u.is_channel && chatId){
   await redis(["SET","norka:channel:chat_id",String(chatId)]);
   await redis(["SET","norka:channel:added_at",new Date().toISOString()]);
   return json(res,200,{ok:true,action:"channel_id_saved"});
  }
  if(type==="bot_removed" && u.is_channel && chatId){
   const current=await redis(["GET","norka:channel:chat_id"]);
   if(String(current)===String(chatId))await redis(["DEL","norka:channel:chat_id"]);
   return json(res,200,{ok:true,action:"channel_id_removed"});
  }
  if(type==="user_added" && !u.is_channel && chatId){
   const added=u.user||{};
   if(added.is_bot)return json(res,200,{ok:true,ignored:"bot_joined_group"});
   const addedUserId=clean(String(added.user_id||added.id||""),80);
   if(!addedUserId){
    console.warn("NORKA group welcome skipped: added user id missing");
    return json(res,200,{ok:true,ignored:"welcome_user_id_missing"});
   }
   try{
    const claimed=await redis(["SET","norka:welcome:sent:"+chatId+":"+addedUserId,"1","NX","EX","86400"]);
    if(!claimed)return json(res,200,{ok:true,duplicate:true,action:"group_welcome_deduplicated"});
   }catch(error){
    console.error("NORKA group welcome skipped: dedupe storage unavailable",error&&error.message||"unknown");
    return json(res,200,{ok:true,ignored:"welcome_dedupe_unavailable"});
   }
   const name=clean([added.first_name,added.last_name].filter(Boolean).join(" ")||added.name||"",80);
   await send(chatId,(name?"Привет, "+name+"! 👋":"Привет! 👋")+" Добро пожаловать в наше сообщество Норки! 🌿\n\nЯ здесь, чтобы поболтать и подсказать про ягоды 🍓, монеты 🪙, задания и розыгрыши 🎁. Можешь писать обычными сообщениями — не нужно звать меня по имени или использовать команды. Я сама подключусь к разговору, когда смогу быть полезна 🙂",appButton());
   return json(res,200,{ok:true,action:"group_member_welcomed"});
  }
  if(type==="bot_started"){
   if(!chatId)return json(res,200,{ok:true,ignored:"missing chat id"});
   const startedUser=u.user||u.from||u.message?.sender||{};
   const startedUserId=String(u.user_id||u.userId||startedUser.user_id||startedUser.id||"");
   if(startedUserId)await grantLaunchReward(startedUserId);
   const buttons=[{type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"🌿 Открыть Норку",web_app:"se14711525_bot"}]]}}];
   await send(chatId,"Привет! 👋 Добро пожаловать в «Норку»!\n\n🍓 Собирай ягоды за задания и активность.\n🪙 Обменивай ягоды на монеты.\n🎁 Используй монеты для участия в розыгрышах призов.\n\nЗагляни в свою Норку — здесь начинается удача!",buttons);
   return json(res,200,{ok:true,action:"norka_welcome"});
  }
  if(type==="message_callback"){
   const callback=u.callback||{},payload=clean(String(callback.payload||u.payload||""),180),actorId=clean(String(callback.user?.user_id||callback.user?.id||callback.sender?.user_id||u.user?.user_id||u.user?.id||u.user_id||""),80);
   const callbackId=callback.callback_id||callback.id||null;
   console.info("NORKA callback received",JSON.stringify({payload,hasCallbackId:!!callbackId,hasUserId:!!actorId}));
   if(callbackId){
    try{
     const ack=await requestMax({token:process.env.MAX_BOT_TOKEN,method:"POST",apiPath:"/answers?callback_id="+encodeURIComponent(String(callbackId)),body:{notification:"Готово"}});
     if(!ack.ok)console.warn("NORKA callback acknowledgement failed:",ack.status,String(ack.raw||"").slice(0,300));
    }catch(error){console.warn("NORKA callback acknowledgement error:",error&&error.message||"unknown error");}
   }
   // In a MAX dialog, message.recipient.chat_id is null; recipient.user_id identifies the DM target.
   const callbackUserId=actorId||userIdFromUpdate(u)||clean(String(callback.message?.recipient?.user_id||""),80);
   if(payload==="norka_support_yes"){
    const userId=callbackUserId;if(!userId)return json(res,200,{ok:true,ignored:"missing support user"});
    await redis(["SET","norka:support:state:"+userId,"awaiting_issue","EX","86400"]);
    await sendUser(userId,"✍️ Опишите, пожалуйста, вашу ситуацию одним сообщением. Я передам обращение специалисту поддержки.");
    return json(res,200,{ok:true,action:"support_issue_requested"});
   }
   if(payload==="norka_support_no"){
    if(!callbackUserId)return json(res,200,{ok:true,ignored:"missing support user"});
    await sendUser(callbackUserId,"Хорошо! Если понадобится помощь, просто напишите «поддержка».");
    return json(res,200,{ok:true,action:"support_cancelled"});
   }
   if(payload.startsWith("norka_support_reply:")){
    if(actorId!==adminUserId())return json(res,200,{ok:true,ignored:"support_reply_not_admin"});
    const ticketId=payload.slice("norka_support_reply:".length);
    const ticketRaw=await redis(["GET","norka:support:ticket:"+ticketId]);
    if(!ticketRaw){await sendUser(callbackUserId,"Обращение не найдено или срок ответа истёк.");return json(res,200,{ok:true,action:"support_ticket_missing"});}
    await redis(["SET","norka:support:reply:"+actorId,ticketId,"EX","1800"]);
    await sendUser(callbackUserId,"💬 Напишите следующим сообщением ответ клиенту. Я отправлю его в личный чат пользователя.");
    return json(res,200,{ok:true,action:"support_reply_started"});
   }
   return json(res,200,{ok:true,ignored:"unknown_callback"});
  }
  if(type==="message_created"){
   const m=u.message||{},sender=m.sender||m.from||{},rawText=clean(m.body&&m.body.text||m.text||u.body&&u.body.text||u.text,1500),text=rawText.toLowerCase(),userId=userIdFromUpdate(u);
   const recipient=m.recipient||{};
   const chatType=recipient.chat_type||m.chat_type||u.chat_type||"";
   console.info("NORKA incoming message",JSON.stringify({
    updateType:type,chatType:chatType||"missing",hasChatId:Boolean(chatId),
    hasUserId:Boolean(userId),hasText:Boolean(rawText),textLength:rawText.length,
    senderIsBot:Boolean(sender.is_bot),hasOpenAIKey:Boolean(process.env.OPENAI_API_KEY)
   }));
   const privateDialog=chatType==="dialog"||(!chatId&&Boolean(recipient.user_id));
   if(sender.is_bot||(!chatId&&!privateDialog)||!userId){
     console.warn("NORKA message ignored before routing",JSON.stringify({
     senderIsBot:Boolean(sender.is_bot),hasChatId:Boolean(chatId),hasUserId:Boolean(userId)
    }));
    return json(res,200,{ok:true,ignored:true});
   }
   if(!privateDialog && chatId && asksForBerryBalance(rawText)){
    try{
     const wallet=await readUserWallet(userId);
     await send(chatId,"🍓 Баланс ягод участника, который вызвал Норку: **"+wallet.berries.toLocaleString("ru-RU")+" ягод**.",appButton());
     return json(res,200,{ok:true,action:"group_public_berry_balance"});
    }catch(error){
     console.error("NORKA group berry balance read failed:",error&&error.message||"unknown");
     await send(chatId,"Не получилось получить баланс ягод прямо сейчас. Проверь его в приложении в разделе «Кошелёк».");
     return json(res,200,{ok:true,action:"group_public_berry_balance_unavailable"});
    }
   }
   if(privateDialog && asksForWallet(rawText)){
    try{
     const wallet=await readUserWallet(userId);
     await sendUser(userId,"👛 Твой актуальный баланс в Норке:\\n🍓 Ягоды: "+wallet.berries.toLocaleString("ru-RU")+"\\n🪙 Монеты: "+wallet.coins.toLocaleString("ru-RU")+"\\n\\nБаланс считан из кошелька приложения. Историю начислений и списаний можно посмотреть в разделе «Кошелёк».",appButton());
     return json(res,200,{ok:true,action:"private_wallet_balance"});
    }catch(error){
     console.error("NORKA private wallet read failed:",error&&error.message||"unknown");
     await sendUser(userId,"Не получилось получить баланс прямо сейчас. Открой приложение Норки → «Кошелёк» и проверь данные там. Если проблема повторится, напиши «поддержка».");
     return json(res,200,{ok:true,action:"private_wallet_balance_unavailable"});
    }
   }
   if(privateDialog && /(поддержк|оператор|жалоб|обращени)/i.test(rawText)){
    await sendUser(userId,"🛟 Нужна помощь поддержки? Нажми «Да», затем опиши ситуацию одним сообщением. Не отправляй пароли и коды подтверждения.",supportButtons());
    return json(res,200,{ok:true,action:"private_support_confirmation"});
   }
   if(privateDialog && /(обмен|курс|конвертац|перевести.*ягод|сколько.*монет.*ягод)/i.test(rawText)){
    let rate=100;
    try{rate=Math.max(1,Math.floor(Number(await redis(["GET","norka:exchange-rate"]))||100));}catch(error){console.warn("NORKA private exchange rate unavailable:",error&&error.message||"unknown");}
    const amountMatch=rawText.toLowerCase().replace(/ё/g,"е").match(/(\d{1,9})\s*(?:ягод|ягоды|ягоду)/);
    let answer="🔄 Обмен находится в приложении в разделе «Обмен». Сейчас курс: "+rate+" ягод = 1 монета. Укажи количество ягод — приложение покажет итог до подтверждения. Обмениваются целые монеты, остаток ягод сохраняется.";
    if(amountMatch){
     const amount=Number(amountMatch[1]),coins=Math.floor(amount/rate),spent=coins*rate,remainder=amount-spent;
     answer="🔄 По текущему курсу "+rate+" ягод = 1 монета. За "+amount.toLocaleString("ru-RU")+" ягод получится "+coins.toLocaleString("ru-RU")+" монет; спишется "+spent.toLocaleString("ru-RU")+" ягод"+(remainder?", останется "+remainder+" ягод":"")+". Подтвердить обмен можно в разделе «Обмен».";
    }
    await sendUser(userId,answer,appButton());
    return json(res,200,{ok:true,action:"private_exchange_help"});
   }
   if(privateDialog && /(купить|покупк|пополн|оплат|платеж|платёж|yoomoney|юмани)/i.test(rawText)){
    const failed=/(не приш|не зачисл|не поступ|списал|ошибк|не прош|завис)/i.test(rawText);
    const answer=failed
     ?"💳 Если деньги уже списались, но монеты не поступили, проверь раздел «Кошелёк» → историю операций. Не создавай повторный платёж. Нажми «поддержка» и приложи сумму, примерное время платежа и номер заказа, если он есть. Не присылай данные карты, пароли или коды."
     :"💳 Купить монеты можно в приложении: «Кошелёк» → «Купить монеты». Выбери сумму от 100 до 2000 ₽ с шагом 100 ₽, создай платёж и оплати по ссылке YooMoney. После подтверждения оплаты монеты автоматически поступят в кошелёк. Ягоды напрямую не продаются — их можно заработать за задания или получить через обмен.";
    await sendUser(userId,answer,appButton());
    return json(res,200,{ok:true,action:"private_payment_help"});
   }
   if(privateDialog && /(ягод|заработ|ежеднев|задан)/i.test(rawText)){
    await sendUser(userId,"🍓 Ягоды можно получать за ежедневный визит и доступные задания. Открой «Задания», проверь ежедневную награду и условия активностей. Баланс и историю начислений найдёшь в «Кошельке». Ягоды можно обменять на монеты в разделе «Обмен».",appButton());
    return json(res,200,{ok:true,action:"private_berries_help"});
   }

   const adminId=adminUserId();
   if(chatType==="chat" && userId!==adminId) {
    const messageId=clean(String(m.body?.mid||m.mid||m.message_id||u.message_id||""),180);
    try {
     const moderation=await moderateGroupLink({chatId,userId,messageId,message:m,update:u});
     if(moderation) {
      console.info("NORKA group link moderation",JSON.stringify({action:moderation.action,strike:moderation.strike||null,hasMessageId:Boolean(messageId)}));
      return json(res,200,{ok:true,...moderation});
     }
    } catch(error) {
     console.error("NORKA group link moderation error:",error&&error.message||"unknown");
     // If moderation storage or API is unavailable, stop normal assistant processing for this message.
     return json(res,200,{ok:true,moderation_error:true});
    }
   }
   if(userId===adminId){
    const pendingTicket=await redis(["GET","norka:support:reply:"+adminId]);
    if(pendingTicket){
     const ticketRaw=await redis(["GET","norka:support:ticket:"+pendingTicket]);
     if(!ticketRaw){await redis(["DEL","norka:support:reply:"+adminId]);await send(chatId,"Обращение уже недоступно. Попросите пользователя создать новое.");return json(res,200,{ok:true,action:"support_ticket_expired"});}
     const ticket=typeof ticketRaw==="string"?JSON.parse(ticketRaw):ticketRaw;
     if(!rawText){await send(chatId,"Ответ должен быть текстовым сообщением. Напишите ответ клиенту.");return json(res,200,{ok:true,action:"support_reply_needs_text"});}
     await sendUser(ticket.userId,"💬 Ответ поддержки Норки:\n\n"+rawText);
     await redis(["DEL","norka:support:reply:"+adminId]);
     await redis(["SET","norka:support:ticket:"+pendingTicket,JSON.stringify({...ticket,status:"answered",answeredAt:new Date().toISOString()}),"EX","2592000"]);
     await send(chatId,"✅ Ответ отправлен пользователю.");
     return json(res,200,{ok:true,action:"support_reply_sent",ticketId:pendingTicket});
    }
   }
   let supportState=null;
   try{supportState=await redis(["GET","norka:support:state:"+userId]);}
   catch(error){console.error("NORKA support state Redis unavailable:",error&&error.message||"unknown");}
   if(supportState==="awaiting_issue"){
    if(!rawText){await send(chatId,"Пожалуйста, опишите проблему текстом одним сообщением.");return json(res,200,{ok:true,action:"support_text_required"});}
    const ticketId=Date.now().toString(36)+"-"+userId;
    const ticket={ticketId,userId,chatId,name:clean([sender.first_name,sender.last_name].filter(Boolean).join(" ")||sender.name||sender.username||"Пользователь",120),username:clean(sender.username||"",80),issue:rawText,createdAt:new Date().toISOString(),status:"open"};
    await redis(["SET","norka:support:ticket:"+ticketId,JSON.stringify(ticket),"EX","2592000"]);
    await redis(["DEL","norka:support:state:"+userId]);
    const adminText="🆘 Новое обращение в поддержку Норки\n\n👤 Пользователь: ["+ticket.name.replace(/[\[\]\\]/g,"")+"](max://user/"+encodeURIComponent(userId)+")\n🆔 ID: "+userId+(ticket.username?"\n📛 @"+ticket.username.replace(/^@/,""):"")+"\n\n📝 Суть обращения:\n"+rawText;
    await sendUser(adminId,adminText,replyButton(ticketId));
    await send(chatId,"✅ Обращение передано в поддержку. Мы ответим вам здесь, в личном чате с Норкой.");
    return json(res,200,{ok:true,action:"support_ticket_created",ticketId});
   }
   if(chatType!=="chat"&&(text==="/start"||text==="старт"||text==="норка")){
    await send(chatId,"🌿 Норка ждёт тебя! Открой приложение, чтобы проверить баланс ягод и монет, выполнить задания и посмотреть розыгрыши.",[{type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"🌿 Открыть Норку",web_app:"se14711525_bot"}]]}}]);
    return json(res,200,{ok:true,action:"norka_start"});
   }
   if(/(^|[^а-яё])поддержк[а-яё]*(?=$|[^а-яё])/i.test(text)){
    await send(chatId,"Нужна помощь? Хотите связаться с поддержкой Норки?",supportButtons());
    return json(res,200,{ok:true,action:"support_confirmation"});
   }
   if(chatType==="chat"){
     console.info("NORKA group route selected",JSON.stringify({hasChatId:Boolean(chatId),hasUserId:Boolean(userId)}));
    const botUsername=clean(process.env.MAX_BOT_USERNAME||"",80).replace(/^@/,"").toLowerCase();
    const lowerText=rawText.toLowerCase();
    const botMentioned=lowerText.includes("норка")||(botUsername&&lowerText.includes("@"+botUsername));
    console.info("NORKA group assistant dispatch",JSON.stringify({botMentioned:Boolean(botMentioned),hasKnowledgeTopic:/ягод|монет|розыгр|розыгрыш|приз|обмен|курс|задан|ежеднев|баланс/i.test(rawText)}));
    const result=await handleGroupMessage({
     chatId,
     userId,
     userName:clean([sender.first_name,sender.last_name].filter(Boolean).join(" ")||sender.name||sender.username||"",80),
     text:rawText,
     botMentioned:Boolean(botMentioned)
    });
    console.info("NORKA group assistant result",JSON.stringify({handled:Boolean(result.handled),reason:result.reason||null,hasReply:Boolean(result.text)}));
     if(result.handled){
     await send(chatId,result.text,isAppRelated(rawText+" "+result.text)?appButton():[]);
       console.info("NORKA group reply sent",JSON.stringify({hasChatId:Boolean(chatId)}));
     return json(res,200,{ok:true,action:"group_assistant_reply"});
    }
    return json(res,200,{ok:true,ignored:result.reason||"group_message_not_relevant"});
   }
   return json(res,200,{ok:true,ignored:"unsupported_message"});
  }
  return json(res,200,{ok:true,ignored:type||"unknown update type"});
 }catch(e){if(dedupeKey){try{await redis(["DEL",dedupeKey]);}catch{}}console.error("NORKA webhook:",e&&e.message||"unknown error");return json(res,200,{ok:true,processing_error:true});}
};