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

  const ranges={"1":[1,2,3],"2":[4,5,6],"3":[7,8,9],"4":[10,11,12]};
  const monthsWanted=ranges[String(part)];

  const raw=String(username);
  const lower=raw.toLowerCase();

  const bases=[...new Set([
    `http://wretch.cc/${type}/${raw}`,
    `http://www.wretch.cc/${type}/${raw}`,
    `https://wretch.cc/${type}/${raw}`,
    `https://www.wretch.cc/${type}/${raw}`,
    `http://wretch.cc/${type}/${lower}`,
    `http://www.wretch.cc/${type}/${lower}`,
    `wretch.cc/${type}/${lower}`,
    `www.wretch.cc/${type}/${lower}`
  ])];

  const cfg=redisConfig();
  const cacheKey=`ytm:autoindex:v1:${lower}:${type}:${year}:${part}`;

  const cached=await cacheGet(cfg,cacheKey);
  if(cached?.found===true){
    return res.status(200).json({...cached,serverCache:true});
  }

  async function timedFetch(url,timeout=5500,accept="application/json"){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{
        headers:{"Accept":accept,"User-Agent":"YouthTimeMachine/auto-index-1.0"},
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

  async function cdx(base,month){
    const mm=String(month).padStart(2,"0");
    const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(base)+
      "&from="+year+mm+"01"+
      "&to="+year+mm+"31"+
      "&output=json&fl=timestamp,original&collapse=timestamp:8&limit=40&gzip=false";

    const r=await timedFetch(q,5000);
    if(!r?.ok)return [];

    try{
      const data=JSON.parse(await r.text());
      if(!Array.isArray(data)||data.length<=1)return [];
      return data.slice(1).map(x=>({
        ts:String(x?.[0]||""),
        original:String(x?.[1]||base)
      })).filter(x=>x.ts.length>=8);
    }catch{return []}
  }

  async function available(base,month){
    const mm=String(month).padStart(2,"0");
    const stamp=`${year}${mm}15`;
    const u="https://archive.org/wayback/available?url="+encodeURIComponent(base)+"&timestamp="+stamp;
    const r=await timedFetch(u,4500);
    if(!r?.ok)return null;

    try{
      const d=await r.json();
      const h=d?.archived_snapshots?.closest;
      if(!h?.available||!h.timestamp)return null;
      const ts=String(h.timestamp);
      if(!ts.startsWith(year))return null;
      return {ts,original:base};
    }catch{return null}
  }

  const rows=[];

  // 每個季度逐月自動嘗試：
  // 先 CDX；該月 CDX 沒資料，再用 availability。
  // 任何成功結果都會寫入 Upstash，供其他裝置/使用者共用。
  for(const month of monthsWanted){
    let monthRows=[];

    const cdxGroups=await Promise.all(bases.map(base=>cdx(base,month)));
    monthRows=cdxGroups.flat();

    if(!monthRows.length){
      const hits=(await Promise.all(bases.map(base=>available(base,month)))).filter(Boolean);
      monthRows=hits;
    }

    rows.push(...monthRows);
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
    source:"auto-index"
  };

  // 只保存成功資料，失敗或 0 筆永遠不鎖死。
  if(result.found){
    await cacheSet(cfg,cacheKey,result,7776000); // 90 days
  }

  return res.status(200).json(result);
};