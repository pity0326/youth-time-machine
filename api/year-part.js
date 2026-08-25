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
  const oldUrl=`http://www.wretch.cc/${type}/${username}`;
  const cacheKey=`ytm:yearpart:v1:${username.toLowerCase()}:${type}:${year}:${part}`;
  const cfg=redisConfig();

  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true){
    return res.status(200).json({...cached,serverCache:true});
  }

  const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(oldUrl)+
    "&from="+year+from+
    "&to="+year+to+
    "&output=json"+
    "&fl=timestamp"+
    "&filter=statuscode:200"+
    "&collapse=timestamp:8"+
    "&limit=120"+
    "&gzip=false";

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),7000);

  try{
    const r=await fetch(q,{
      headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/quarter-1.0"},
      signal:controller.signal
    });
    clearTimeout(timer);

    if(!r.ok){
      return res.status(503).json({error:"Archive 暫時忙碌",temporary:true});
    }

    const text=await r.text();
    let data;
    try{data=JSON.parse(text)}catch{
      return res.status(503).json({error:"Archive 回傳異常",temporary:true});
    }

    const seen=new Set(),days=[];
    if(Array.isArray(data)){
      for(let i=1;i<data.length;i++){
        const ts=data[i]&&data[i][0];
        if(!ts||ts.length<8)continue;
        const date=ts.slice(0,8);
        if(seen.has(date))continue;
        seen.add(date);
        days.push({
          date,
          month:date.slice(4,6),
          day:date.slice(6,8),
          timestamp:ts,
          url:`https://web.archive.org/web/${ts}/${oldUrl}`
        });
      }
    }

    const months={};
    for(const x of days){
      if(!months[x.month])months[x.month]=[];
      months[x.month].push(x);
    }

    const result={found:days.length>0,year,part:Number(part),days,months};

    // Only successful segments are cached. Empty/failed segments are not frozen.
    if(result.found){
      await cacheSet(cfg,cacheKey,result,2592000);
    }

    return res.status(200).json(result);

  }catch(e){
    clearTimeout(timer);
    return res.status(503).json({error:"Archive 暫時忙碌",temporary:true});
  }
};