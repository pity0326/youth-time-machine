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

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-3])$/.test(year||""))
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

  const userRaw=String(username);
  const userLower=userRaw.toLowerCase();

  // Prefix search: Wayback may have saved trailing slash, query strings,
  // album subpaths, redirects, or different host variants.
  const prefixes=[
    `http://wretch.cc/${type}/${userRaw}*`,
    `http://www.wretch.cc/${type}/${userRaw}*`,
    `https://wretch.cc/${type}/${userRaw}*`,
    `https://www.wretch.cc/${type}/${userRaw}*`,
    `http://wretch.cc/${type}/${userLower}*`,
    `http://www.wretch.cc/${type}/${userLower}*`
  ];

  const cfg=redisConfig();
  const cacheKey=`ytm:yearpart:v3:${userLower}:${type}:${year}:${part}`;

  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true){
    return res.status(200).json({...cached,serverCache:true});
  }

  async function queryPrefix(pattern){
    const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(pattern)+
      "&matchType=prefix"+
      "&from="+year+from+
      "&to="+year+to+
      "&output=json"+
      "&fl=timestamp,original,statuscode"+
      "&collapse=timestamp:8"+
      "&limit=300"+
      "&gzip=false";

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),7000);

    try{
      const r=await fetch(q,{
        headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/prefix-1.0"},
        signal:controller.signal
      });
      clearTimeout(timer);

      if(!r.ok)return [];

      const text=await r.text();
      let data;
      try{data=JSON.parse(text)}catch{return []}

      if(!Array.isArray(data)||data.length<=1)return [];

      const rows=[];
      for(let i=1;i<data.length;i++){
        const ts=data[i]?.[0];
        const original=data[i]?.[1];
        const status=data[i]?.[2];
        if(ts&&original&&String(ts).length>=8){
          rows.push({ts:String(ts),original:String(original),status:String(status||"")});
        }
      }
      return rows;
    }catch{
      clearTimeout(timer);
      return [];
    }
  }

  const groups=await Promise.all(prefixes.map(queryPrefix));
  const rows=groups.flat();

  const seen=new Set();
  const days=[];

  for(const row of rows){
    const date=row.ts.slice(0,8);
    if(seen.has(date))continue;
    seen.add(date);

    days.push({
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:row.ts,
      statuscode:row.status,
      original:row.original,
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
    searchedPrefixes:prefixes.length
  };

  // Only successful segments are cached.
  if(result.found){
    await cacheSet(cfg,cacheKey,result,2592000);
  }

  return res.status(200).json(result);
};