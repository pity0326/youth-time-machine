function redisConfig(){
  const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  return url&&token?{url:url.replace(/\/$/,""),token}:null;
}
async function redis(cfg,path){
  const r=await fetch(cfg.url+path,{headers:{Authorization:`Bearer ${cfg.token}`},cache:"no-store"});
  if(!r.ok)throw new Error("redis");
  return r.json();
}
async function cacheSet(cfg,key,value,ttl){
  if(!cfg)return;
  try{
    const raw=JSON.stringify(value);
    await redis(cfg,`/set/${encodeURIComponent(key)}/${encodeURIComponent(raw)}`);
    await redis(cfg,`/expire/${encodeURIComponent(key)}/${ttl}`);
  }catch{}
}
async function availability(target,stamp,timeout=4500){
  const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch("https://archive.org/wayback/available?url="+
      encodeURIComponent(target)+"&timestamp="+stamp,{
      headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/v35"},
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
async function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

module.exports=async function(req,res){
  const username=String(req.query.username||"").trim();
  const type=String(req.query.type||"");
  const year=String(req.query.year||"");
  const part=String(req.query.part||"");
  const exactDate=String(req.query.exactDate||"").replace(/\D/g,"");

  if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({error:"帳號格式"});
  if(!["album","blog","guestbook"].includes(type))return res.status(400).json({error:"類型"});
  if(!/^(200[3-9]|201[0-4])$/.test(year))return res.status(400).json({error:"年份"});
  if(!exactDate && !/^[1-4]$/.test(part))return res.status(400).json({error:"分段"});
  if(exactDate && !/^\d{8}$/.test(exactDate))return res.status(400).json({error:"exactDate 請用 YYYYMMDD"});

  if(String(req.query.precheck||"")==="1"){
    const candidates=[...new Set([
      `http://www.wretch.cc:80/${type}/${username}`,
      `http://www.wretch.cc/${type}/${username}`,
      `http://wretch.cc:80/${type}/${username}`,
      `http://wretch.cc/${type}/${username}`
    ])];

    // Probe several years, not just one date/year. This is deliberately
    // conservative: a miss here is "no quick evidence", not proof of nonexistence.
    const stamps=["20130101","20120101","20100101","20080101","20060101"];
    const evidence=[];

    for(const stamp of stamps){
      for(let i=0;i<candidates.length;i+=2){
        const batch=candidates.slice(i,i+2);
        const got=await Promise.all(batch.map(async target=>{
          const hit=await availability(target,stamp,3200);
          return hit ? {target,requested:stamp,timestamp:hit.timestamp,url:hit.url} : null;
        }));
        evidence.push(...got.filter(Boolean));
        if(evidence.length) break;
        await sleep(90);
      }
      if(evidence.length) break;
    }

    return res.status(200).json({
      mode:"precheck",
      username,
      type,
      quickEvidence:evidence.length>0,
      evidence:evidence.slice(0,4),
      // IMPORTANT: false does not mean the account definitely never existed.
      // Frontend may warn, but must still let the user continue a deep search.
      conclusive:false
    });
  }

  if(exactDate){
    const testTargets=[...new Set([
      `http://wretch.cc/${type}/${username}`,
      `http://www.wretch.cc/${type}/${username}`,
      `http://wretch.cc:80/${type}/${username}`,
      `http://www.wretch.cc:80/${type}/${username}`,
      `http://wretch.cc/${type}/${username.toLowerCase()}`,
      `http://www.wretch.cc/${type}/${username.toLowerCase()}`,
      `http://wretch.cc:80/${type}/${username.toLowerCase()}`,
      `http://www.wretch.cc:80/${type}/${username.toLowerCase()}`
    ])];

    const results=[];
    for(let i=0;i<testTargets.length;i+=2){
      const batch=testTargets.slice(i,i+2);
      const got=await Promise.all(batch.map(async target=>{
        const hit=await availability(target,exactDate,5000);
        return {
          target,
          hit,
          sameDate:!!hit && String(hit.timestamp||"").slice(0,8)===exactDate
        };
      }));
      results.push(...got);
      await sleep(180);
    }

    const exactMatches=results.filter(x=>x.sameDate);
    return res.status(200).json({
      mode:"exactDate",
      username,
      type,
      exactDate,
      tested:results.length,
      exactMatches:exactMatches.length,
      results
    });
  }

  const quarter={"1":[1,2,3],"2":[4,5,6],"3":[7,8,9],"4":[10,11,12]}[part];

  // Important V35 change:
  // Do NOT fire 90+ Availability calls at once.
  // Use the single canonical URL that already proved successful in diagnostics.
  const target=`http://www.wretch.cc:80/${type}/${username}`;

  // V41: two-stage scan.
  // Stage 1 quickly probes every 4 days. Stage 2 fills the gaps.
  // Keep concurrency at 3: faster than V37, but still far below the V34 burst.
  const fastDays=[1,5,9,13,17,21,25,29];
  const fillDays=[3,7,11,15,19,23,27,31];
  const hits=[];
  let fastHitCount=0;

  async function runDays(days){
    for(const month of quarter){
      const mm=String(month).padStart(2,"0");
      for(let i=0;i<days.length;i+=3){
        const batch=days.slice(i,i+3);
        const got=await Promise.all(batch.map(day=>{
          const dd=String(day).padStart(2,"0");
          return availability(target,`${year}${mm}${dd}`,4200);
        }));
        hits.push(...got.filter(Boolean));
        await sleep(110);
      }
    }
  }

  // Fast pass first.
  await runDays(fastDays);
  fastHitCount=hits.length;

  // Fill pass: keeps coverage close to V37 without a huge simultaneous burst.
  await runDays(fillDays);

  const map=new Map();
  for(const h of hits){
    const ts=h.timestamp;
    if(!ts.startsWith(year)||ts.length<8)continue;
    const month=Number(ts.slice(4,6));
    if(!quarter.includes(month))continue;

    const date=ts.slice(0,8);
    if(map.has(date))continue;

    const original=originalFromReplay(h.url,target);
    map.set(date,{
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:ts,
      url:`https://web.archive.org/web/${ts}/${original}`
    });
  }

  const days=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const months={};
  for(const d of days)(months[d.month]??=[]).push(d);

  const result={
    found:days.length>0,
    year,
    part:Number(part),
    days,
    months,
    source:"two-stage-availability",
    fastHitCount,
    target
  };

  const cfg=redisConfig();

  if(result.found){
    // part cache
    await cacheSet(cfg,`ytm:v42:${username.toLowerCase()}:${type}:${year}:${part}`,result,7776000);

    // merge to full-year shared cache used by /api/year-cache
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
        await cacheSet(cfg,fullKey,{
          found:true,year,days:mergedDays,months:mergedMonths,updatedAt:Date.now()
        },7776000);
      }catch{}
    }
  }

  return res.status(200).json(result);
};