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

function cleanAccount(v){
  return String(v||"").trim().split("?")[0].split("#")[0].replace(/\/+$/,"");
}
async function timedFetch(url,timeout=4500){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{
      headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/v30"},
      signal:c.signal,cache:"no-store"
    });
    clearTimeout(timer);
    return r;
  }catch{
    clearTimeout(timer);
    return null;
  }
}
function extractOriginalFromWayback(waybackUrl){
  try{
    const s=String(waybackUrl||"");
    const m=s.match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i);
    return m?.[1]||null;
  }catch{return null}
}

module.exports=async function handler(req,res){
  const {type,year,part}=req.query;
  const username=cleanAccount(req.query.username);

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[3-9]|201[0-4])$/.test(String(year||"")))
    return res.status(400).json({error:"年份不正確"});
  if(!/^[1-4]$/.test(String(part||"")))
    return res.status(400).json({error:"分段不正確"});

  const monthsByPart={"1":[1,2,3],"2":[4,5,6],"3":[7,8,9],"4":[10,11,12]};
  const months=monthsByPart[String(part)];
  const lower=username.toLowerCase();

  const cfg=redisConfig();
  const cacheKey=`ytm:v30:${lower}:${type}:${year}:${part}`;
  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found&&cached.days?.length)
    return res.status(200).json({...cached,serverCache:true});

  const seedTargets=[...new Set([
    `wretch.cc/${type}/${username}`,
    `www.wretch.cc/${type}/${username}`,
    `http://wretch.cc/${type}/${username}`,
    `http://www.wretch.cc/${type}/${username}`
  ])];

  async function availability(target,stamp){
    const api="https://archive.org/wayback/available?url="+
      encodeURIComponent(target)+"&timestamp="+stamp;
    const r=await timedFetch(api,4500);
    if(!r?.ok)return null;
    try{
      const d=await r.json();
      const h=d?.archived_snapshots?.closest;
      if(!h?.available||!h.timestamp)return null;
      return {
        timestamp:String(h.timestamp),
        waybackUrl:String(h.url||""),
        original:extractOriginalFromWayback(h.url)||target
      };
    }catch{return null}
  }

  // Phase 1: fast probe. Learn the canonical URL that Archive itself returns.
  const probeStamps=[
    `${year}0115`,`${year}0615`,`${year}1215`,
    `${Number(year)-1}1215`,`${Number(year)+1}0115`
  ];

  const probes=(await Promise.all(
    seedTargets.flatMap(target=>probeStamps.map(stamp=>availability(target,stamp)))
  )).filter(Boolean);

  const canonicalTargets=[...new Set([
    ...probes.map(x=>x.original),
    ...seedTargets
  ])];

  // Phase 2: scan this quarter at several points in each month.
  // Availability is the route that diagnostics showed working reliably.
  const stamps=[];
  for(const m of months){
    const mm=String(m).padStart(2,"0");
    stamps.push(`${year}${mm}01`,`${year}${mm}15`,`${year}${mm}28`);
  }

  const hits=(await Promise.all(
    canonicalTargets.flatMap(target=>stamps.map(stamp=>availability(target,stamp)))
  )).filter(Boolean);

  const all=[...probes,...hits];
  const seen=new Set();
  const days=[];

  for(const h of all){
    const ts=h.timestamp;
    if(!ts.startsWith(String(year))||ts.length<8)continue;

    const month=Number(ts.slice(4,6));
    if(!months.includes(month))continue;

    const date=ts.slice(0,8);
    if(seen.has(date))continue;
    seen.add(date);

    const original=h.original;
    days.push({
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:ts,
      url:`https://web.archive.org/web/${ts}/${original}`
    });
  }

  // Phase 3: only if Availability found something, use Archive's canonical URL
  // for one short CDX attempt to fill more dates. It never blocks the main result.
  if(days.length){
    async function cdx(target){
      const first=String(months[0]).padStart(2,"0");
      const last=String(months[months.length-1]).padStart(2,"0");
      const lastDay=months[months.length-1]===2?"28":
        [4,6,9,11].includes(months[months.length-1])?"30":"31";
      const api="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(target)+
        `&from=${year}${first}01&to=${year}${last}${lastDay}`+
        "&output=json&fl=timestamp,original&collapse=timestamp:8&limit=150&gzip=false";
      const r=await timedFetch(api,3500);
      if(!r?.ok)return [];
      try{
        const d=JSON.parse(await r.text());
        if(!Array.isArray(d)||d.length<=1)return [];
        return d.slice(1);
      }catch{return []}
    }

    const bestTargets=[...new Set(probes.map(x=>x.original))].slice(0,3);
    const groups=await Promise.all(bestTargets.map(cdx));

    for(const row of groups.flat()){
      const ts=String(row?.[0]||"");
      if(!ts.startsWith(String(year))||ts.length<8)continue;
      const month=Number(ts.slice(4,6));
      if(!months.includes(month))continue;
      const date=ts.slice(0,8);
      if(seen.has(date))continue;
      seen.add(date);
      const original=String(row?.[1]||bestTargets[0]||seedTargets[0]);
      days.push({
        date,month:date.slice(4,6),day:date.slice(6,8),timestamp:ts,
        url:`https://web.archive.org/web/${ts}/${original}`
      });
    }
  }

  days.sort((a,b)=>a.date.localeCompare(b.date));
  const monthMap={};
  for(const x of days){
    if(!monthMap[x.month])monthMap[x.month]=[];
    monthMap[x.month].push(x);
  }

  const result={
    found:days.length>0,
    year:String(year),
    part:Number(part),
    days,
    months:monthMap,
    source:"availability-first",
    canonicalTargets:canonicalTargets.slice(0,6)
  };

  if(result.found)await cacheSet(cfg,cacheKey,result,7776000);
  return res.status(200).json(result);
};