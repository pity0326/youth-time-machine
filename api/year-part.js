function redisConfig(){
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  if(!redisUrl||!redisToken)return null;
  return {baseUrl:redisUrl.replace(/\/$/,""),token:redisToken};
}
async function redisCall(cfg,path){
  const r=await fetch(cfg.baseUrl+path,{
    headers:{Authorization:`Bearer ${cfg.token}`},cache:"no-store"
  });
  if(!r.ok)throw new Error("Redis");
  return r.json();
}
async function cacheGet(cfg,key){
  if(!cfg)return null;
  try{
    const d=await redisCall(cfg,`/get/${encodeURIComponent(key)}`);
    return d?.result?JSON.parse(d.result):null;
  }catch{return null}
}
async function cacheSet(cfg,key,value,ttl){
  if(!cfg)return;
  try{
    const raw=JSON.stringify(value);
    await redisCall(cfg,`/set/${encodeURIComponent(key)}/${encodeURIComponent(raw)}`);
    if(ttl)await redisCall(cfg,`/expire/${encodeURIComponent(key)}/${ttl}`);
  }catch{}
}
async function timedFetch(url,timeout=4500){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{
      headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/v32"},
      signal:c.signal,cache:"no-store"
    });
    clearTimeout(timer);
    return r;
  }catch{
    clearTimeout(timer);
    return null;
  }
}
function cleanAccount(v){
  return String(v||"").trim().split("?")[0].split("#")[0].replace(/\/+$/,"");
}
function extractOriginal(waybackUrl,fallback){
  const s=String(waybackUrl||"");
  const m=s.match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i);
  return m?.[1]||fallback;
}

module.exports=async function handler(req,res){
  const username=cleanAccount(req.query.username);
  const type=String(req.query.type||"");
  const year=String(req.query.year||"");
  const part=String(req.query.part||"");

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[3-9]|201[0-4])$/.test(year))
    return res.status(400).json({error:"年份不正確"});
  if(!/^[1-4]$/.test(part))
    return res.status(400).json({error:"分段不正確"});

  const monthsByPart={"1":[1,2,3],"2":[4,5,6],"3":[7,8,9],"4":[10,11,12]};
  const months=monthsByPart[part];
  const lower=username.toLowerCase();
  const cfg=redisConfig();

  const cacheKey=`ytm:v32:${lower}:${type}:${year}:${part}`;
  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found&&Array.isArray(cached.days)&&cached.days.length)
    return res.status(200).json({...cached,serverCache:true});

  async function availability(target,stamp){
    const api="https://archive.org/wayback/available?url="+
      encodeURIComponent(target)+"&timestamp="+stamp;
    const r=await timedFetch(api,4500);
    if(!r?.ok)return null;
    try{
      const d=await r.json(),h=d?.archived_snapshots?.closest;
      if(!h?.available||!h.timestamp)return null;
      return {
        timestamp:String(h.timestamp),
        original:extractOriginal(h.url,target),
        waybackUrl:String(h.url||"")
      };
    }catch{return null}
  }

  // 先用少量探針取得 Archive 自己認得的 canonical URL。
  const seeds=[...new Set([
    `http://wretch.cc/${type}/${username}`,
    `http://www.wretch.cc/${type}/${username}`,
    `http://wretch.cc/${type}/${lower}`,
    `http://www.wretch.cc/${type}/${lower}`
  ])];

  const probeStamp=`${year}${String(months[1]).padStart(2,"0")}15`;
  const probes=(await Promise.all(seeds.map(t=>availability(t,probeStamp)))).filter(Boolean);

  const canonical=[...new Set([
    ...probes.map(x=>x.original),
    ...seeds
  ])];

  // 舊年份用較密的 Availability 掃描。
  // 第一輪：每月 1 / 8 / 15 / 22 / 28。
  const primaryDays=[1,8,15,22,28];

  function makeStamps(days){
    const out=[];
    for(const m of months){
      const mm=String(m).padStart(2,"0");
      for(const d of days){
        const dd=String(d).padStart(2,"0");
        out.push(`${year}${mm}${dd}`);
      }
    }
    return out;
  }

  async function scanTargets(targets,stamps){
    const jobs=[];
    for(const target of targets){
      for(const stamp of stamps)jobs.push(availability(target,stamp));
    }
    return (await Promise.all(jobs)).filter(Boolean);
  }

  // 只用 Archive canonical + 最主要 root，避免像舊版一樣變成幾十組 URL * 幾十日期。
  const scanTargetsList=[...new Set([
    ...probes.map(x=>x.original),
    `http://www.wretch.cc/${type}/${username}`,
    `http://www.wretch.cc/${type}/${lower}`
  ])].slice(0,4);

  let hits=await scanTargets(scanTargetsList,makeStamps(primaryDays));

  function sameQuarter(h){
    const ts=String(h?.timestamp||"");
    if(!ts.startsWith(year)||ts.length<8)return false;
    return months.includes(Number(ts.slice(4,6)));
  }

  // 如果第一輪完全沒有命中目標季度，再做第二輪補掃。
  // 這能抓到像 2010-01-02 這種很靠近月初的紀錄，
  // 又不會所有搜尋一開始就發出大量請求。
  if(!hits.some(sameQuarter)){
    const secondaryDays=[2,4,6,11,13,17,19,24,26,30];
    hits.push(...await scanTargets(scanTargetsList,makeStamps(secondaryDays)));
  }

  const seen=new Set();
  const days=[];

  for(const h of hits){
    const ts=String(h.timestamp||"");
    if(!sameQuarter(h))continue;
    const date=ts.slice(0,8);
    if(seen.has(date))continue;
    seen.add(date);
    days.push({
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:ts,
      url:`https://web.archive.org/web/${ts}/${h.original}`
    });
  }

  days.sort((a,b)=>a.date.localeCompare(b.date));

  const monthMap={};
  for(const x of days){
    if(!monthMap[x.month])monthMap[x.month]=[];
    monthMap[x.month].push(x);
  }

  const result={
    found:days.length>0,
    year,
    part:Number(part),
    days,
    months:monthMap,
    source:"availability-dense",
    canonicalTargets:scanTargetsList
  };

  if(result.found)await cacheSet(cfg,cacheKey,result,7776000);
  return res.status(200).json(result);
};