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

function cleanAccount(input){
  return String(input||"")
    .trim()
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/,"");
}
function cleanOriginalUrl(input){
  try{
    let s=String(input||"").trim();
    if(!s)return s;

    // Wayback can return an original URL with tracking parameters. Strip them.
    const hasScheme=/^https?:\/\//i.test(s);
    const u=new URL(hasScheme?s:`http://${s}`);

    const trash=[
      "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
      "utm_id","utm_name","fbclid","gclid","dclid","msclkid","mc_cid","mc_eid"
    ];
    for(const k of trash)u.searchParams.delete(k);

    // Also remove any arbitrary utm_* variants.
    for(const k of [...u.searchParams.keys()]){
      if(/^utm_/i.test(k))u.searchParams.delete(k);
    }

    u.hash="";
    return hasScheme?u.href:u.href.replace(/^http:\/\//i,"");
  }catch{
    return String(input||"")
      .replace(/[?&](?:utm_[^=&]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)=[^&#]*/gi,"")
      .replace(/[?&]$/,"");
  }
}

module.exports=async function handler(req,res){
  const {username,type,year,part}=req.query;

  const account=cleanAccount(username);
  if(!account||!/^[A-Za-z0-9._-]{1,80}$/.test(account))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[3-9]|201[0-4])$/.test(String(year||"")))
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
  const raw=account;
  const lower=raw.toLowerCase();

  // Canonical Calendar target first because this matches the clean URL the user
  // can visibly confirm in Wayback's Calendar UI.
  const calendarTargets=[...new Set([
    `wretch.cc/${type}/${lower}`,
    `wretch.cc/${type}/${raw}`,
    `www.wretch.cc/${type}/${lower}`,
    `www.wretch.cc/${type}/${raw}`
  ])];

  // CDX / availability fallbacks retain scheme variants.
  const archiveTargets=[...new Set([
    ...calendarTargets,
    `http://wretch.cc/${type}/${lower}`,
    `http://www.wretch.cc/${type}/${lower}`,
    `http://wretch.cc/${type}/${raw}`,
    `http://www.wretch.cc/${type}/${raw}`
  ])];

  const cfg=redisConfig();
  const cacheKey=`ytm:core28:v1:${lower}:${type}:${year}:${part}`;

  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true&&Array.isArray(cached.days)&&cached.days.length){
    return res.status(200).json({...cached,serverCache:true});
  }

  async function timedFetch(url,timeout=7000,accept="application/json"){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{
        headers:{
          "Accept":accept,
          "User-Agent":"YouthTimeMachine/core-28"
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

  function normalizeCalendarDay(item){
    if(item==null)return null;

    // Known Wayback Calendar payloads have changed shape over time.
    // Accept arrays, scalar day values, and object fields.
    let v=null;
    if(Array.isArray(item))v=item[0];
    else if(typeof item==="object"){
      v=item.day??item.date??item.timestamp??item.ts??item[0];
    }else v=item;

    const s=String(v??"").replace(/\D/g,"");

    // MMDD
    if(s.length===4)return s;
    // YYYYMMDD or YYYYMMDDHHMMSS
    if(s.length>=8&&s.slice(0,4)===String(year))return s.slice(4,8);
    return null;
  }

  function calendarItems(payload){
    if(Array.isArray(payload))return payload;
    if(Array.isArray(payload?.items))return payload.items;
    if(Array.isArray(payload?.captures))return payload.captures;
    if(Array.isArray(payload?.results))return payload.results;
    return [];
  }

  async function calendarYear(target){
    const url="https://web.archive.org/__wb/calendarcaptures/2?url="+
      encodeURIComponent(target)+
      "&date="+encodeURIComponent(String(year))+
      "&groupby=day";

    const r=await timedFetch(url,7500);
    if(!r?.ok)return [];

    try{
      const payload=await r.json();
      const out=[];
      for(const item of calendarItems(payload)){
        const mmdd=normalizeCalendarDay(item);
        if(!mmdd)continue;
        const month=Number(mmdd.slice(0,2));
        if(allowedMonths.has(month))out.push(mmdd);
      }
      return [...new Set(out)];
    }catch{return []}
  }

  function normalizeTimeItem(item){
    if(item==null)return null;
    let value=null;

    if(Array.isArray(item))value=item[0];
    else if(typeof item==="object"){
      value=item.timestamp??item.ts??item.time??item.datetime??item[0];
    }else value=item;

    const s=String(value??"").replace(/\D/g,"");

    if(s.length===14&&s.startsWith(String(year)))return s;
    if(s.length===6)return s; // HHMMSS
    return null;
  }

  async function calendarDayTimestamp(target,mmdd){
    const ymd=String(year)+mmdd;
    const url="https://web.archive.org/__wb/calendarcaptures/2?url="+
      encodeURIComponent(target)+
      "&date="+encodeURIComponent(ymd);

    const r=await timedFetch(url,5500);
    if(!r?.ok)return null;

    try{
      const payload=await r.json();
      const items=calendarItems(payload);

      for(const item of items){
        const t=normalizeTimeItem(item);
        if(!t)continue;
        if(t.length===14)return t;
        if(t.length===6)return ymd+t;
      }
      return null;
    }catch{return null}
  }

  // ---- Strategy A: same Calendar data family used by Wayback's Calendar UI ----
  const calendarGroups=await Promise.all(
    calendarTargets.map(async target=>({
      target,
      days:await calendarYear(target)
    }))
  );

  const calendarDayMap=new Map();
  for(const g of calendarGroups){
    for(const mmdd of g.days){
      if(!calendarDayMap.has(mmdd))calendarDayMap.set(mmdd,g.target);
    }
  }

  const rows=[];

  if(calendarDayMap.size){
    const entries=[...calendarDayMap.entries()];

    for(let i=0;i<entries.length;i+=6){
      const batch=entries.slice(i,i+6);
      const resolved=await Promise.all(batch.map(async ([mmdd,target])=>{
        const ts=await calendarDayTimestamp(target,mmdd);

        // Calendar has already confirmed the DAY even if exact timestamp endpoint
        // is temporarily unavailable. Keep the date rather than falsely returning 0.
        return {
          ts:ts||(`${year}${mmdd}000000`),
          original:target,
          calendarOnly:!ts
        };
      }));
      rows.push(...resolved);
    }
  }

  // ---- Strategy B: CDX fallback ----
  if(!rows.length){
    async function cdx(target){
      const range={
        "1":["0101","0331"],
        "2":["0401","0630"],
        "3":["0701","0930"],
        "4":["1001","1231"]
      }[String(part)];

      const url="https://web.archive.org/cdx/search/cdx?url="+
        encodeURIComponent(target)+
        "&from="+year+range[0]+
        "&to="+year+range[1]+
        "&output=json"+
        "&fl=timestamp,original"+
        "&collapse=timestamp:8"+
        "&limit=220"+
        "&gzip=false";

      const r=await timedFetch(url,7000);
      if(!r?.ok)return [];

      try{
        const data=JSON.parse(await r.text());
        if(!Array.isArray(data)||data.length<=1)return [];
        return data.slice(1).map(x=>({
          ts:String(x?.[0]||""),
          original:cleanOriginalUrl(String(x?.[1]||target)),
          calendarOnly:false
        })).filter(x=>x.ts.length>=8);
      }catch{return []}
    }

    rows.push(...(await Promise.all(archiveTargets.map(cdx))).flat());
  }

  // ---- Strategy C: monthly Availability fallback ----
  if(!rows.length){
    async function availability(target,month){
      const mm=String(month).padStart(2,"0");
      const stamp=`${year}${mm}15`;

      const url="https://archive.org/wayback/available?url="+
        encodeURIComponent(target)+
        "&timestamp="+stamp;

      const r=await timedFetch(url,4500);
      if(!r?.ok)return null;

      try{
        const d=await r.json();
        const hit=d?.archived_snapshots?.closest;
        if(!hit?.available||!hit.timestamp)return null;

        const ts=String(hit.timestamp);
        if(!ts.startsWith(String(year)))return null;

        return {
          ts,
          original:cleanOriginalUrl(target),
          calendarOnly:false
        };
      }catch{return null}
    }

    const hits=await Promise.all(
      archiveTargets.flatMap(target=>
        quarterMonths[String(part)].map(month=>availability(target,month))
      )
    );
    rows.push(...hits.filter(Boolean));
  }

  const seen=new Set();
  const days=[];

  for(const row of rows){
    const ts=String(row.ts||"");
    if(ts.length<8)continue;

    const date=ts.slice(0,8);
    const month=Number(date.slice(4,6));
    if(date.slice(0,4)!==String(year)||!allowedMonths.has(month)||seen.has(date))continue;

    seen.add(date);

    const cleanOriginal=cleanOriginalUrl(row.original||`wretch.cc/${type}/${lower}`);
    const link=row.calendarOnly
      ? `https://web.archive.org/web/${date}000000*/${cleanOriginal}`
      : `https://web.archive.org/web/${ts}/${cleanOriginal}`;

    days.push({
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:ts,
      url:link
    });
  }

  days.sort((a,b)=>a.date.localeCompare(b.date));

  const months={};
  for(const x of days){
    if(!months[x.month])months[x.month]=[];
    months[x.month].push(x);
  }

  const result={
    found:days.length>0,
    year:String(year),
    part:Number(part),
    days,
    months,
    source:calendarDayMap.size?"calendar":(days.length?"fallback":"none")
  };

  // Only real successful data is shared. Never freeze 0-result failures.
  if(result.found){
    await cacheSet(cfg,cacheKey,result,7776000); // 90 days
  }

  return res.status(200).json(result);
};