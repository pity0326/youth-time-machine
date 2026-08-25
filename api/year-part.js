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
  const isOlder=Number(year)<=2011;

  const roots=[
    `http://wretch.cc/${type}/${raw}`,
    `http://www.wretch.cc/${type}/${raw}`,
    `http://wretch.cc/${type}/${lower}`,
    `http://www.wretch.cc/${type}/${lower}`
  ];

  // 2011 以前常見的是動態頁面被保存，而使用者首頁本身未必有 capture。
  // 所以舊年份另外掃 Wretch 的舊式 PHP 路徑。
  const legacy=[];
  if(isOlder){
    if(type==="album"){
      legacy.push(
        `http://www.wretch.cc/album/album.php?id=${raw}`,
        `http://www.wretch.cc/album/album.php?id=${lower}`,
        `http://wretch.cc/album/album.php?id=${raw}`,
        `http://wretch.cc/album/album.php?id=${lower}`
      );
    }else if(type==="blog"){
      legacy.push(
        `http://www.wretch.cc/blog/blog.php?id=${raw}`,
        `http://www.wretch.cc/blog/blog.php?id=${lower}`,
        `http://wretch.cc/blog/blog.php?id=${raw}`,
        `http://wretch.cc/blog/blog.php?id=${lower}`
      );
    }else if(type==="guestbook"){
      legacy.push(
        `http://www.wretch.cc/guestbook/index.php?id=${raw}`,
        `http://www.wretch.cc/guestbook/index.php?id=${lower}`,
        `http://wretch.cc/guestbook/index.php?id=${raw}`,
        `http://wretch.cc/guestbook/index.php?id=${lower}`
      );
    }
  }

  const targets=[...new Set([...roots,...legacy])];

  const cfg=redisConfig();
  const cacheKey=`ytm:legacywide:v1:${lower}:${type}:${year}:${part}`;
  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true){
    return res.status(200).json({...cached,serverCache:true});
  }

  async function timedFetch(url,timeout=8000){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{
        headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/legacy-wide-1.0"},
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

  async function cdx(target){
    // legacy PHP URLs need prefix because query strings/book/page params can follow id=...
    const usePrefix=isOlder && /\.php\?id=/i.test(target);
    const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(target)+
      (usePrefix?"&matchType=prefix":"")+
      "&from="+year+from+
      "&to="+year+to+
      "&output=json"+
      "&fl=timestamp,original"+
      "&collapse=timestamp:8"+
      "&limit="+(isOlder?"300":"120")+
      "&gzip=false";

    const r=await timedFetch(q,isOlder?10000:7000);
    if(!r?.ok)return [];

    try{
      const data=JSON.parse(await r.text());
      if(!Array.isArray(data)||data.length<=1)return [];
      return data.slice(1).map(row=>({
        ts:String(row?.[0]||""),
        original:String(row?.[1]||target)
      })).filter(x=>x.ts.length>=8);
    }catch{return []}
  }

  // All route variants run in parallel.
  let rows=(await Promise.all(targets.map(cdx))).flat();

  // Older years: if CDX is empty, try monthly availability on root URLs and legacy routes.
  if(!rows.length && isOlder){
    const quarterMonths={
      "1":[1,2,3],
      "2":[4,5,6],
      "3":[7,8,9],
      "4":[10,11,12]
    }[String(part)];

    async function available(target,month){
      const mm=String(month).padStart(2,"0");
      const stamp=`${year}${mm}15`;
      const api="https://archive.org/wayback/available?url="+
        encodeURIComponent(target)+"&timestamp="+stamp;

      const r=await timedFetch(api,4500);
      if(!r?.ok)return null;

      try{
        const d=await r.json();
        const h=d?.archived_snapshots?.closest;
        if(!h?.available||!h.timestamp)return null;
        const ts=String(h.timestamp);
        if(!ts.startsWith(String(year)))return null;
        return {ts,original:target};
      }catch{return null}
    }

    rows=(await Promise.all(
      targets.flatMap(target=>quarterMonths.map(m=>available(target,m)))
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
    months,
    legacyMode:isOlder,
    searchedTargets:targets.length
  };

  // 只存成功結果，0 筆永遠不快取。
  if(result.found){
    await cacheSet(cfg,cacheKey,result,7776000);
  }

  return res.status(200).json(result);
};