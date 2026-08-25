
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
  if(!r.ok)throw new Error(`Redis HTTP ${r.status}`);
  return r.json();
}
async function cacheGet(cfg,key){
  if(!cfg)return null;
  try{
    const d=await redisCall(cfg,`/get/${encodeURIComponent(key)}`);
    if(!d?.result)return null;
    return JSON.parse(d.result);
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

module.exports = async function handler(req,res){
  const {username,type,year}=req.query;
  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-3])$/.test(year||""))return res.status(400).json({error:"年份不正確"});

  const normalized=username.toLowerCase();
  const cacheKey=`ytm:year:v1:${normalized}:${type}:${year}`;
  const cfg=redisConfig();

  // 1. Cloud cache first. Only successful searches are ever stored.
  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true&&Array.isArray(cached.days)&&cached.days.length){
    return res.status(200).json({...cached,serverCache:true});
  }

  const oldUrl=`http://www.wretch.cc/${type}/${username}`;
  const calendarUrl=`https://web.archive.org/web/*/${oldUrl}`;
  const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(oldUrl)+
    "&from="+year+"0101&to="+year+"1231&output=json&fl=timestamp"+
    "&filter=statuscode:200&collapse=timestamp:8&limit=400&gzip=false";

  function build(timestamps,extra={}){
    const seen=new Set(),days=[];
    for(const raw of timestamps||[]){
      const ts=String(raw||""); if(ts.length<8)continue;
      const date=ts.slice(0,8);
      if(date.slice(0,4)!==String(year)||seen.has(date))continue;
      seen.add(date);
      days.push({date,month:date.slice(4,6),day:date.slice(6,8),timestamp:ts,url:`https://web.archive.org/web/${ts}/${oldUrl}`});
    }
    days.sort((a,b)=>a.date.localeCompare(b.date));
    const months={};
    for(const x of days){if(!months[x.month])months[x.month]=[];months[x.month].push(x)}
    return {found:days.length>0,year,days,months,calendarUrl,...extra};
  }

  async function timedFetch(url,timeout){
    const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/2.0"},signal:c.signal});
      clearTimeout(tm);return r;
    }catch(e){clearTimeout(tm);throw e}
  }

  async function availability(){
    const points=[`${year}0215`,`${year}0515`,`${year}0815`,`${year}1115`];
    return (await Promise.all(points.map(async stamp=>{
      try{
        const u="https://archive.org/wayback/available?url="+encodeURIComponent(oldUrl)+"&timestamp="+stamp;
        const r=await timedFetch(u,5000);if(!r.ok)return null;
        const d=await r.json(),c=d?.archived_snapshots?.closest;
        return c?.available&&c.timestamp&&String(c.timestamp).startsWith(year)?String(c.timestamp):null;
      }catch{return null}
    }))).filter(Boolean);
  }

  try{
    let data=null;
    try{
      const r=await timedFetch(q,12000);
      if(r.ok){const text=await r.text();try{data=JSON.parse(text)}catch{}}
    }catch{}

    let result;
    if(Array.isArray(data)&&data.length>1){
      result=build(data.slice(1).map(row=>row&&row[0]).filter(Boolean));
    }else{
      const hits=[...new Set(await availability())];
      result=hits.length?build(hits,{partial:true}):build([]);
    }

    // 2. Critical rule: only found=true is stored in Redis.
    if(result.found===true){
      await cacheSet(cfg,cacheKey,result,2592000); // 30 days
    }

    return res.status(200).json(result);
  }catch{
    return res.status(502).json({error:"Internet Archive 目前回應較慢",calendarUrl});
  }
};