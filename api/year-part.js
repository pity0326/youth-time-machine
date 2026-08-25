function redisConfig(){
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  if(!redisUrl||!redisToken)return null;
  return {baseUrl:redisUrl.replace(/\/$/,""),token:redisToken};
}
async function redisCall(cfg,path){
  const r=await fetch(cfg.baseUrl+path,{
    headers:{Authorization:`Bearer ${cfg.token}`},
    cache:"no-store"
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

module.exports=async function handler(req,res){
  const {username,type,year,part}=req.query;

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-3])$/.test(year||""))
    return res.status(400).json({error:"年份不正確"});
  if(!/^[1-4]$/.test(String(part||"")))
    return res.status(400).json({error:"分段不正確"});

  const quarterMonths={
    "1":[1,2,3],
    "2":[4,5,6],
    "3":[7,8,9],
    "4":[10,11,12]
  };
  const allowedMonths=new Set(quarterMonths[String(part)]);

  const raw=String(username);
  const lower=raw.toLowerCase();

  // Wayback's calendar page can distinguish these URL variants.
  const bases=[...new Set([
    `wretch.cc/${type}/${raw}`,
    `www.wretch.cc/${type}/${raw}`,
    `wretch.cc/${type}/${lower}`,
    `www.wretch.cc/${type}/${lower}`,
    `http://wretch.cc/${type}/${raw}`,
    `http://www.wretch.cc/${type}/${raw}`,
    `http://wretch.cc/${type}/${lower}`,
    `http://www.wretch.cc/${type}/${lower}`
  ])];

  const cfg=redisConfig();
  const cacheKey=`ytm:calendar:v1:${lower}:${type}:${year}:${part}`;
  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true){
    return res.status(200).json({...cached,serverCache:true});
  }

  async function timedFetch(url,timeout=8000){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{
        headers:{
          "Accept":"application/json",
          "User-Agent":"YouthTimeMachine/calendar-1.0",
          "Referer":`https://web.archive.org/web/${year}0000000000*/wretch.cc/${type}/${lower}`
        },
        signal:c.signal,
        cache:"no-store"
      });
      clearTimeout(timer);
      return r;
    }catch{
      clearTimeout(timer);
      return null;
    }
  }

  async function getDays(base){
    const u="https://web.archive.org/__wb/calendarcaptures/2?url="+
      encodeURIComponent(base)+"&date="+encodeURIComponent(year)+"&groupby=day";
    const r=await timedFetch(u,8000);
    if(!r?.ok)return [];
    try{
      const d=await r.json();
      return Array.isArray(d?.items)?d.items:[];
    }catch{return []}
  }

  async function getFirstTime(base,mmdd){
    const date=year+mmdd;
    const u="https://web.archive.org/__wb/calendarcaptures/2?url="+
      encodeURIComponent(base)+"&date="+encodeURIComponent(date);
    const r=await timedFetch(u,6500);
    if(!r?.ok)return null;

    try{
      const d=await r.json();
      const items=Array.isArray(d?.items)?d.items:[];
      if(!items.length)return null;

      // Prefer 2xx, then 3xx, then anything with a valid HHMMSS.
      const ranked=items.slice().sort((a,b)=>{
        const sa=Number(a?.[1]||0), sb=Number(b?.[1]||0);
        const ra=(sa>=200&&sa<300)?0:(sa>=300&&sa<400)?1:2;
        const rb=(sb>=200&&sb<300)?0:(sb>=300&&sb<400)?1:2;
        return ra-rb;
      });

      for(const item of ranked){
        const hhmmss=String(item?.[0]??"").padStart(6,"0");
        if(/^\d{6}$/.test(hhmmss)){
          return year+mmdd+hhmmss;
        }
      }
      return null;
    }catch{return null}
  }

  // 1) Ask the same calendar data source used by the Wayback calendar UI.
  const dayGroups=await Promise.all(
    bases.map(async base=>({base,items:await getDays(base)}))
  );

  // Merge unique MMDD + remember which base produced it.
  const dayMap=new Map();

  for(const g of dayGroups){
    for(const item of g.items){
      const mmdd=String(item?.[0]??"").padStart(4,"0");
      if(!/^\d{4}$/.test(mmdd))continue;

      const month=Number(mmdd.slice(0,2));
      if(!allowedMonths.has(month))continue;

      if(!dayMap.has(mmdd)){
        dayMap.set(mmdd,g.base);
      }
    }
  }

  if(!dayMap.size){
    return res.status(200).json({
      found:false,
      year,
      part:Number(part),
      days:[],
      months:{},
      source:"calendarcaptures"
    });
  }

  // 2) Resolve one real timestamp for each day, in small batches.
  const entries=[...dayMap.entries()];
  const resolved=[];

  for(let i=0;i<entries.length;i+=6){
    const batch=entries.slice(i,i+6);
    const got=await Promise.all(batch.map(async ([mmdd,base])=>{
      const ts=await getFirstTime(base,mmdd);
      return ts?{mmdd,base,ts}:null;
    }));
    resolved.push(...got.filter(Boolean));
  }

  const days=resolved.map(x=>({
    date:x.ts.slice(0,8),
    month:x.ts.slice(4,6),
    day:x.ts.slice(6,8),
    timestamp:x.ts,
    url:`https://web.archive.org/web/${x.ts}/${x.base}`
  })).sort((a,b)=>a.date.localeCompare(b.date));

  const months={};
  for(const x of days){
    if(!months[x.month])months[x.month]=[];
    months[x.month].push(x);
  }

  const result={
    found:days.length>0,
    year,
    part:Number(part),
    days,
    months,
    source:"calendarcaptures"
  };

  // Store only successful results.
  if(result.found){
    await cacheSet(cfg,cacheKey,result,2592000);
  }

  return res.status(200).json(result);
};