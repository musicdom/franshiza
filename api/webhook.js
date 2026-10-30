const { requestMax } = require("../lib/max-api");
function json(res,status,data){res.status(status).setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));}
function clean(v,n=200){return typeof v==="string"?v.trim().slice(0,n):"";}
async function send(chatId,text,attachments=[]){const token=process.env.MAX_BOT_TOKEN;if(!token)throw new Error("MAX_BOT_TOKEN is not configured");const r=await requestMax({token,method:"POST",apiPath:"/messages?chat_id="+encodeURIComponent(String(chatId)),body:{text,...(attachments.length?{attachments}:{})}});if(!r.ok)throw new Error("MAX message failed: "+r.status);}
module.exports=async function handler(req,res){
 if(req.method!=="POST"){res.setHeader("Allow","POST");return json(res,405,{ok:false,error:"Method not allowed"});}
 const secret=process.env.MAX_WEBHOOK_SECRET;if(!secret)return json(res,503,{ok:false,error:"Webhook secret is not configured"});
 if(req.headers["x-max-bot-api-secret"]!==secret)return json(res,401,{ok:false,error:"Unauthorized"});
 const u=req.body&&typeof req.body==="object"?req.body:{};const type=u.update_type;const chatId=u.chat_id||(u.message&&u.message.recipient&&u.message.recipient.chat_id)||(u.callback&&u.callback.message&&u.callback.message.recipient&&u.callback.message.recipient.chat_id);
 try{
  if(type==="bot_started"){
   if(!chatId)return json(res,200,{ok:true,ignored:"missing chat id"});
   const buttons=[{type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"🌿 Открыть Норку",web_app:"se14711525_bot"}]]}}];
   await send(chatId,"Привет! 👋 Добро пожаловать в «Норку»!\n\n🍓 Собирай ягоды за задания и активность.\n🪙 Обменивай ягоды на монеты.\n🎁 Используй монеты для участия в розыгрышах призов.\n\nЗагляни в свою Норку — здесь начинается удача!",buttons);
   return json(res,200,{ok:true,action:"norka_welcome"});
  }
  if(type==="message_created"){
   const m=u.message||{},sender=m.sender||{},text=clean(m.body&&m.body.text,500).toLowerCase();
   if(sender.is_bot||!chatId)return json(res,200,{ok:true,ignored:true});
   if(text==="/start"||text==="старт"||text==="норка"){
    await send(chatId,"🌿 Норка ждёт тебя! Открой приложение, чтобы проверить баланс ягод и монет, выполнить задания и посмотреть розыгрыши.",[{type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"🌿 Открыть Норку",web_app:"se14711525_bot"}]]}}]);
    return json(res,200,{ok:true,action:"norka_start"});
   }
   await send(chatId,"Я пока умею только открывать Норку 🌿 Нажми кнопку ниже, чтобы перейти в приложение.",[{type:"inline_keyboard",payload:{buttons:[[{type:"open_app",text:"🌿 Открыть Норку",web_app:"se14711525_bot"}]]}}]);
   return json(res,200,{ok:true});
  }
  return json(res,200,{ok:true,ignored:type||"unknown update type"});
 }catch(e){console.error("NORKA webhook:",e&&e.message||"unknown error");return json(res,200,{ok:true,processing_error:true});}
};