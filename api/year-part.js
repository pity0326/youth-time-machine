function redisConfig(){
  const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  return url&&token?{url:url.replace(/\/$/,""),token}:null;
}
async function redis(cfg,path){
  const r=await fetch(cfg.url+path,{headers:{Authorization:`Bearer ${cfg.token}`},cache:"no-store"});
  if(!r.ok) throw new Error("redis");
  return r.json();
}
async function savePart(cfg,key,data){
  if(!cfg||!data?.found)return;
  try{
    const raw=JSON.stringify(data);
    await redis(cfg,`/set/${encodeURIComponent(key)}/${encodeURIComponent(raw)}`);
    await redis(cfg,`/expire/${encodeURIComponent(key)}/7776000`);
  }catch{}
}
async function availability(target,stamp,timeout=5000){
  const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch("https://archive.org/wayback/available?url="+
      encodeURIComponent(target)+"&timestamp="+stamp,{
      headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/v34"},
      signal:c.signal,cache:"no-store"
    });
    clearTimeout(tm);
    if(!r.ok)return null;
    const d=await r.json(),h=d?.archived_snapshots?.closest;
    if(!h?.available||!h.timestamp)return null;
    return {timestamp:String(h.timestamp),url:String(h.url||"")};
  }catch{clearTimeout(tm);return null}
}
function originalFromReplay(url,fallback){
  const m=String(url||"").match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i);
  return m?.[1]||fallback;
}
module.exports=async function(req,res){
  const username=String(req.query.username||"").trim();
  const type=String(req.query.type||"");
  const year=String(req.query.year||"");
  const part=String(req.query.part||"");
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({error:"帳號格式"});
  if(!["album","blog","guestbook"].includes(type))return res.status(400).json({error:"類型"});
  if(!/^(200[3-9]|201[0-4])$/.test(year))return res.status(400).json({error:"年份"});
  if(!/^[1-4]$/.test(part))return res.status(400).json({error:"分段"});

  const quarter={"1":[1,2,3],"2":[4,5,6],"3":[7,8,9],"4":[10,11,12]}[part];
  const targets=[...new Set([
    `http://www.wretch.cc/${type}/${username}`,
    `http://wretch.cc/${type}/${username}`,
    `http://www.wretch.cc:80/${type}/${username}`
  ])];

  // First prove the exact path with dense day-by-day probes.
  // Run one month at a time to avoid a huge simultaneous burst.
  const hits=[];
  for(const month of quarter){
    const mm=String(month).padStart(2,"0");
    const jobs=[];
    for(const target of targets){
      for(let day=1;day<=31;day++){
        const dd=String(day).padStart(2,"0");
        jobs.push(availability(target,`${year}${mm}${dd}`));
      }
    }
    const batch=(await Promise.all(jobs)).filter(Boolean);
    hits.push(...batch);
  }

  const map=new Map();
  for(const h of hits){
    const ts=h.timestamp;
    if(!ts.startsWith(year)||ts.length<8)continue;
    const month=Number(ts.slice(4,6));
    if(!quarter.includes(month))continue;
    const date=ts.slice(0,8);
    if(map.has(date))continue;
    const original=originalFromReplay(h.url,targets[0]);
    map.set(date,{
      date,month:date.slice(4,6),day:date.slice(6,8),
      timestamp:ts,url:`https://web.archive.org/web/${ts}/${original}`
    });
  }
  const days=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const months={};
  for(const d of days)(months[d.month]??=[]).push(d);
  const result={found:days.length>0,year,part:Number(part),days,months,source:"exact-daily-availability"};

  const cfg=redisConfig();
  if(result.found){
    await savePart(cfg,`ytm:v34:${username.toLowerCase()}:${type}:${year}:${part}`,result);

    // Also merge directly into the same full-year cloud-cache key used by year-cache.js.
    if(cfg){
      const fullKey=`ytm:yearcloud:v1:${username.toLowerCase()}:${type}:${year}`;
      try{
        const oldResp=await redis(cfg,`/get/${encodeURIComponent(fullKey)}`);
        let old=null; try{old=oldResp?.result?JSON.parse(oldResp.result):null}catch{}
        const all=new Map();
        for(const x of old?.days||[])if(x?.date)all.set(x.date,x);
        for(const x of days)all.set(x.date,x);
        const mergedDays=[...all.values()].sort((a,b)=>a.date.localeCompare(b.date));
        const mergedMonths={};
        for(const x of mergedDays)(mergedMonths[x.month]??=[]).push(x);
        const full={found:true,year,days:mergedDays,months:mergedMonths,updatedAt:Date.now()};
        const raw=JSON.stringify(full);
        await redis(cfg,`/set/${encodeURIComponent(fullKey)}/${encodeURIComponent(raw)}`);
        await redis(cfg,`/expire/${encodeURIComponent(fullKey)}/7776000`);
      }catch{}
    }
  }
  return res.status(200).json(result);
};