#!/usr/bin/env node
"use strict";
const ALLOWED_COMMANDS = new Set(["SCAN", "GET", "HGETALL"]);
function redisConfig(env = process.env) {
  const kvUrl=env.KV_REST_API_URL, kvToken=env.KV_REST_API_TOKEN;
  const upstashUrl=env.UPSTASH_REDIS_REST_URL, upstashToken=env.UPSTASH_REDIS_REST_TOKEN;
  if ((kvUrl&&!kvToken)||(!kvUrl&&kvToken)) throw new Error("KV Redis configuration is incomplete; URL and token must be paired");
  if ((upstashUrl&&!upstashToken)||(!upstashUrl&&upstashToken)) throw new Error("Upstash Redis configuration is incomplete; URL and token must be paired");
  if (kvUrl&&kvToken) return {url:kvUrl.replace(/\/$/,""),token:kvToken};
  if (upstashUrl&&upstashToken) return {url:upstashUrl.replace(/\/$/,""),token:upstashToken};
  throw new Error("Redis credentials are not configured");
}
function createRedisClient(config, fetchImpl=globalThis.fetch) {
  if (!config?.url||!config?.token) throw new Error("Redis config is required");
  if (typeof fetchImpl!=="function") throw new Error("A fetch implementation is required");
  return async function redis(parts) {
    if (!ALLOWED_COMMANDS.has(String(parts[0]||"").toUpperCase())) throw new Error("Blocked non-read-only Redis command");
    const response=await fetchImpl(config.url,{method:"POST",headers:{Authorization:"Bearer "+config.token,"Content-Type":"application/json"},body:JSON.stringify(parts)});
    if (!response.ok) throw new Error("Redis HTTP "+response.status);
    const data=await response.json();
    if (data.error) throw new Error("Redis command failed");
    return data.result;
  };
}
function exactIds(keys,pattern) {
  const prefix=pattern==="norka:user:*"?"norka:user:":"norka:wallet:";
  return (Array.isArray(keys)?keys:[]).map(String).filter(k=>k.startsWith(prefix))
    .filter(k=>!k.slice(prefix.length).includes(":")).map(k=>k.slice(prefix.length)).filter(Boolean);
}
async function scanIds(redis,pattern,maxPages=20000) {
  let cursor="0",pages=0; const ids=new Set();
  do {
    const page=await redis(["SCAN",cursor,"MATCH",pattern,"COUNT","500"]);
    if(!Array.isArray(page)||page.length<2||!Array.isArray(page[1])) throw new Error("Unexpected Redis SCAN response");
    cursor=String(page[0]); for(const id of exactIds(page[1],pattern)) ids.add(id);
    pages++; if(pages>maxPages) throw new Error("Redis SCAN safety page limit exceeded");
  } while(cursor!=="0");
  return ids;
}
function parseHash(raw) {
  if(Array.isArray(raw)){const out={};for(let i=0;i+1<raw.length;i+=2)out[String(raw[i])]=raw[i+1];return out;}
  return raw&&typeof raw==="object"?raw:{};
}
function numericField(value) {
  if(value===undefined||value===null||value==="") return null;
  const n=Number(value); return Number.isFinite(n)?n:null;
}
async function mapLimit(items,limit,worker) {
  for(let i=0;i<items.length;i+=limit) await Promise.all(items.slice(i,i+limit).map(worker));
}
async function auditRedis(redis,options={}) {
  const concurrency=Math.max(1,Math.min(50,Number(options.concurrency)||20));
  const report={profileCount:0,walletCount:0,profilesWithoutWallet:0,walletsWithoutProfile:0,
    berriesMismatches:0,coinsMismatches:0,profilesWithMissingBalanceFields:0,
    walletsWithMissingBalanceFields:0,malformedProfileJson:0,redisReadErrors:0};
  const [profiles,wallets]=await Promise.all([scanIds(redis,"norka:user:*"),scanIds(redis,"norka:wallet:*")]);
  report.profileCount=profiles.size; report.walletCount=wallets.size;
  for(const id of profiles) if(!wallets.has(id)) report.profilesWithoutWallet++;
  for(const id of wallets) if(!profiles.has(id)) report.walletsWithoutProfile++;
  const shared=[...profiles].filter(id=>wallets.has(id));
  await mapLimit(shared,concurrency,async id=>{
    let profileRaw,walletRaw;
    try {[profileRaw,walletRaw]=await Promise.all([redis(["GET","norka:user:"+id]),redis(["HGETALL","norka:wallet:"+id])]);}
    catch {report.redisReadErrors++;return;}
    let profile;
    try {profile=typeof profileRaw==="string"?JSON.parse(profileRaw):profileRaw;if(!profile||typeof profile!=="object"||Array.isArray(profile))throw new Error("invalid");}
    catch {report.malformedProfileJson++;return;}
    const wallet=parseHash(walletRaw);
    const pb=numericField(profile.berries),pc=numericField(profile.coins),wb=numericField(wallet.berries),wc=numericField(wallet.coins);
    if(pb===null||pc===null) report.profilesWithMissingBalanceFields++;
    if(wb===null||wc===null) report.walletsWithMissingBalanceFields++;
    if(pb!==null&&wb!==null&&pb!==wb) report.berriesMismatches++;
    if(pc!==null&&wc!==null&&pc!==wc) report.coinsMismatches++;
  });
  return report;
}
async function main() {
  if(process.env.NORKA_AUDIT_CONFIRM!=="READ_ONLY") throw new Error("Set NORKA_AUDIT_CONFIRM=READ_ONLY to explicitly enable this read-only audit");
  const redis=createRedisClient(redisConfig());
  const report=await auditRedis(redis);
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  if(report.redisReadErrors>0) process.exitCode=2;
}
module.exports={ALLOWED_COMMANDS,redisConfig,createRedisClient,exactIds,scanIds,parseHash,auditRedis};
if(require.main===module) main().catch(e=>{process.stderr.write("Norka Redis audit failed: "+String(e.message||"unknown error")+"\n");process.exitCode=1;});
