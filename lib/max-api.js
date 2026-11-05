const fs = require("fs");
const https = require("https");
const tls = require("tls");
const path = require("path");

function getCertificates() {
  const rootPath = path.join(process.cwd(), "certs", "russian_trusted_root_ca.pem");
  const gostPath = path.join(process.cwd(), "certs", "russian_trusted_root_ca_gost_2025.pem");
  if (!fs.existsSync(rootPath) || !fs.existsSync(gostPath)) {
    throw new Error("Ministry of Digital Development CA certificates are missing");
  }
  return [fs.readFileSync(rootPath), fs.readFileSync(gostPath)];
}

function requestMax({ token, method = "GET", apiPath, body = null }) {
  return new Promise((resolve, reject) => {
    const bodyText = body == null ? null : JSON.stringify(body);
    const options = {
      hostname: "platform-api2.max.ru",
      path: apiPath,
      method,
      headers: {
        Authorization: token,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(bodyText ? { "Content-Length": Buffer.byteLength(bodyText) } : {})
      },
      ca: getCertificates(),
      rejectUnauthorized: true,
      timeout: 15000
    };
    const request = https.request(options, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        resolve({ status: response.statusCode || 0, ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, data, raw });
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("MAX API request timed out")));
    if (bodyText) request.write(bodyText);
    request.end();
  });
}

function requestBuffer(url, {method="POST", headers={}, body=null}={}) {
  return new Promise((resolve,reject)=>{
    const target = new URL(url);
    const request = https.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || 443,
      path: target.pathname + target.search, method, headers,
      ca: [...tls.rootCertificates, ...getCertificates()], rejectUnauthorized:true, timeout:30000
    }, response=>{
      const chunks=[];
      response.on("data",chunk=>chunks.push(Buffer.from(chunk)));
      response.on("end",()=>{
        const raw=Buffer.concat(chunks);
        let data={}; try{data=JSON.parse(raw.toString("utf8"));}catch{}
        resolve({status:response.statusCode||0,ok:(response.statusCode||0)>=200&&(response.statusCode||0)<300,data,raw:raw.toString("utf8")});
      });
    });
    request.on("error",reject);
    request.on("timeout",()=>request.destroy(new Error("MAX media request timed out")));
    if(body)request.write(body);
    request.end();
  });
}

async function uploadMaxImage({token, image}) {
  const slot=await requestMax({token,method:"POST",apiPath:"/uploads?type=image"});
  if(!slot.ok||!slot.data||!slot.data.url)throw new Error("MAX image upload slot failed: "+(slot.raw||slot.status));
  const boundary="----NorkaImage"+Date.now().toString(16);
  const head=Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"data\"; filename=\"norka-winners.png\"\r\nContent-Type: image/png\r\n\r\n");
  const tail=Buffer.from("\r\n--"+boundary+"--\r\n");
  const payload=Buffer.concat([head,image,tail]);
  const uploaded=await requestBuffer(slot.data.url,{
    method:"POST",
    headers:{"Content-Type":"multipart/form-data; boundary="+boundary,"Content-Length":payload.length},
    body:payload
  });
  if(!uploaded.ok)throw new Error("MAX image upload failed: "+(uploaded.raw||uploaded.status));
  const imageToken=uploaded.data.token
    || uploaded.data.photos?.photoIds?.token
    || slot.data.token;
  if(!imageToken)throw new Error("MAX image upload did not return an attachment token; upload response shape: "+JSON.stringify({keys:Object.keys(uploaded.data||{}),photosKeys:Object.keys(uploaded.data?.photos||{}),photoIdsKeys:Object.keys(uploaded.data?.photos?.photoIds||{}),slotKeys:Object.keys(slot.data||{})}));
  return imageToken;
}

async function sendMaxMessage({token, chatId, text, attachments = []}) {
  if (!token) throw new Error("MAX_BOT_TOKEN is not configured");
  if (chatId == null || String(chatId).trim() === "") throw new Error("MAX chat_id is missing");
  const body = { text: String(text || "") };
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  return requestMax({
    token,
    method: "POST",
    apiPath: "/messages?chat_id=" + encodeURIComponent(String(chatId)),
    body
  });
}

module.exports = { requestMax, sendMaxMessage, uploadMaxImage };
