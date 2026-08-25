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
  if(!/^(200[3-9]|201[0-4])$/.test(year||""))
    return res.status(400).json({error:"年份不正確"});
  if(!/^[1-4]$/.test(String(part||"")))
    return res.status(400).json({error:"分段不正確"});

  const ranges={
    "1":["0101","0331"],
    "2":["0401","0630"],
    "3":["0701","0930"],
    "4":["1001","1231"]
  };
  const [from,to]=ranges[String(part)];
  const raw=String(username);
  const lower=raw.toLowerCase();

  // 2009~2011 常見舊網址保存形式較分散。
  // 新年份維持精簡查詢；2011 以前額外加入 HTTPS、尾斜線與 prefix 候選。
  const isOlder=Number(year)<=2011;

  const urls=[...new Set([
    `http://wretch.cc/${type}/${raw}`,
    `http://www.wretch.cc/${type}/${raw}`,
    `http://wretch.cc/${type}/${lower}`,
    `http://www.wretch.cc/${type}/${lower}`,
    ...(isOlder ? [
      `https://wretch.cc/${type}/${raw}`,
      `https://www.wretch.cc/${type}/${raw}`,
      `http://wretch.cc/${type}/${raw}/`,
      `http://www.wretch.cc/${type}/${raw}/`,
      `http://wretch.cc/${type}/${lower}/`,
      `http://www.wretch.cc/${type}/${lower}/`
    ] : [])
  ])];

  const cfg=redisConfig();
  const cacheKey=`ytm:olderwide:v1:${lower}:${type}:${year}:${part}`;

  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true){
    return res.status(200).json({...cached,serverCache:true});
  }

  async function queryCDX(url){
    const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(url)+
      (isOlder ? "&matchType=prefix" : "")+
      "&from="+year+from+
      "&to="+year+to+
      "&output=json"+
      "&fl=timestamp,original"+
      "&collapse=timestamp:8"+
      "&limit="+(isOlder ? "250" : "120")+
      "&gzip=false";

    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),isOlder?10500:7000);

    try{
      const r=await fetch(q,{
        headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/fast-quarter-1.0"},
        signal:c.signal,
        cache:"no-store"
      });
      clearTimeout(timer);

      if(!r.ok)return [];

      const text=await r.text();
      let data;
      try{data=JSON.parse(text)}catch{return []}

      if(!Array.isArray(data)||data.length<=1)return [];

      return data.slice(1).map(row=>({
        ts:String(row?.[0]||""),
        original:String(row?.[1]||url)
      })).filter(x=>x.ts.length>=8);

    }catch{
      clearTimeout(timer);
      return [];
    }
  }

  // All useful URL variants run in parallel.
  const groups=await Promise.all(urls.map(queryCDX));
  let rows=groups.flat();

  // Lightweight fallback: if CDX returns nothing, check one point per month.
  if(!rows.length){
    const quarterMonths={
      "1":[1,2,3],"2":[4,5,6],"3":[7,8,9],"4":[10,11,12]
    }[String(part)];

    async function availability(url,month){
      const mm=String(month).padStart(2,"0");
      const api="https://archive.org/wayback/available?url="+
        encodeURIComponent(url)+"&timestamp="+year+mm+"15";

      const c=new AbortController();
      const timer=setTimeout(()=>c.abort(),3500);

      try{
        const r=await fetch(api,{
          headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/fast-quarter-1.0"},
          signal:c.signal,
          cache:"no-store"
        });
        clearTimeout(timer);

        if(!r.ok)return null;
        const d=await r.json();
        const hit=d?.archived_snapshots?.closest;
        if(!hit?.available||!hit.timestamp)return null;

        const ts=String(hit.timestamp);
        if(!ts.startsWith(year))return null;

        return {ts,original:url};
      }catch{
        clearTimeout(timer);
        return null;
      }
    }

    rows=(await Promise.all(
      urls.flatMap(url=>quarterMonths.map(month=>availability(url,month)))
    )).filter(Boolean);
  }

  const seen=new Set();
  const days=[];

  for(const row of rows){
    const date=row.ts.slice(0,8);
    if(date.slice(0,4)!==String(year)||seen.has(date))continue;
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

  const result={
    found:days.length>0,
    year,
    part:Number(part),
    days,
    months
  };

  if(result.found){
    await cacheSet(cfg,cacheKey,result,7776000);
  }

  return res.status(200).json(result);
};