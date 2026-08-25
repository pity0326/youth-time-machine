function redisConfig(){
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  if(!redisUrl||!redisToken)return null;
  return {baseUrl:redisUrl.replace(/\/$/,""),token:redisToken};
}
async function redisCall(cfg,path){
  const r=await fetch(cfg.baseUrl+path,{headers:{Authorization:`Bearer ${cfg.token}`},cache:"no-store"});
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

module.exports=async function handler(req,res){
  const {username,type,year,part}=req.query;
  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-3])$/.test(year||""))return res.status(400).json({error:"年份不正確"});
  if(!/^[1-4]$/.test(String(part||"")))return res.status(400).json({error:"分段不正確"});

  const ranges={"1":["01","03"],"2":["04","06"],"3":["07","09"],"4":["10","12"]};
  const [startM,endM]=ranges[String(part)];
  const userRaw=String(username),userLower=userRaw.toLowerCase();

  const bases=[
    `http://wretch.cc/${type}/${userRaw}`,
    `http://www.wretch.cc/${type}/${userRaw}`,
    `https://wretch.cc/${type}/${userRaw}`,
    `https://www.wretch.cc/${type}/${userRaw}`,
    `http://wretch.cc/${type}/${userLower}`,
    `http://www.wretch.cc/${type}/${userLower}`
  ];
  const uniqueBases=[...new Set(bases)];
  const cfg=redisConfig();
  const cacheKey=`ytm:yearpart:v4:${userLower}:${type}:${year}:${part}`;

  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true)return res.status(200).json({...cached,serverCache:true});

  async function timedFetch(url,timeout=6500){
    const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/fallback-2.0"},signal:c.signal,cache:"no-store"});
      clearTimeout(tm);return r;
    }catch{clearTimeout(tm);return null}
  }

  async function cdx(base){
    const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(base)+
      "&from="+year+startM+"01"+
      "&to="+year+endM+"31"+
      "&output=json&fl=timestamp,original,statuscode&collapse=timestamp:8&limit=120&gzip=false";
    const r=await timedFetch(q,6500);
    if(!r?.ok)return [];
    let data;try{data=JSON.parse(await r.text())}catch{return []}
    if(!Array.isArray(data)||data.length<=1)return [];
    return data.slice(1).map(x=>({ts:String(x?.[0]||""),original:String(x?.[1]||base)})).filter(x=>x.ts.length>=8);
  }

  async function available(base,stamp){
    const u="https://archive.org/wayback/available?url="+encodeURIComponent(base)+"&timestamp="+stamp;
    const r=await timedFetch(u,4500);
    if(!r?.ok)return null;
    try{
      const d=await r.json(),h=d?.archived_snapshots?.closest;
      if(!h?.available||!h.timestamp)return null;
      const ts=String(h.timestamp);
      if(!ts.startsWith(year))return null;
      return {ts,original:base};
    }catch{return null}
  }

  // First try CDX exact base variants.
  let rows=(await Promise.all(uniqueBases.map(cdx))).flat();

  // If CDX gives nothing, query monthly checkpoints through availability.
  // This is intentionally a fallback, because availability often works when CDX is busy.
  if(!rows.length){
    const months=[];
    for(let m=Number(startM);m<=Number(endM);m++)months.push(String(m).padStart(2,"0"));
    const jobs=[];
    for(const base of uniqueBases){
      for(const m of months){
        jobs.push(available(base,`${year}${m}15`));
      }
    }
    rows=(await Promise.all(jobs)).filter(Boolean);
  }

  const seen=new Set(),days=[];
  for(const row of rows){
    const date=row.ts.slice(0,8);
    if(date.slice(0,4)!==year||seen.has(date))continue;
    seen.add(date);
    days.push({
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:row.ts,
      url:`https://web.archive.org/web/${row.ts}/${row.original}`
    });
  }
  days.sort((a,b)=>a.date.localeCompare(b.date));

  const months={};
  for(const x of days){
    if(!months[x.month])months[x.month]=[];
    months[x.month].push(x);
  }

  const result={found:days.length>0,year,part:Number(part),days,months};
  if(result.found)await cacheSet(cfg,cacheKey,result,2592000);
  return res.status(200).json(result);
};