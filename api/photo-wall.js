
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
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();
    let ts=String(req.query.ts||"").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({ok:false,error:"帳號格式不正確"});
    if(!/^\d{4}$/.test(year))return res.status(400).json({ok:false,error:"年份格式不正確"});
    if(ts&&!/^\d{14}$/.test(ts))ts="";

    const cfg=redisConfig();
    const cacheKey=`ytm:photos:v1:${username.toLowerCase()}:${year}`;

    // 1. Return previously recovered photo list immediately.
    const cached=await cacheGet(cfg,cacheKey);
    if(cached?.ok===true&&Array.isArray(cached.photos)&&cached.photos.length){
      return res.status(200).json({...cached,serverCache:true});
    }

    async function fetchText(url,timeout=8500){
      const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"},redirect:"follow",signal:c.signal});
        clearTimeout(tm);if(!r.ok)return null;return await r.text();
      }catch{clearTimeout(tm);return null}
    }

    const rootUrl=`http://www.wretch.cc/album/${encodeURIComponent(username)}`;

    if(!ts){
      const c=new AbortController(),tm=setTimeout(()=>c.abort(),6500);
      let r;
      try{
        r=await fetch("https://archive.org/wayback/available?url="+encodeURIComponent(rootUrl)+"&timestamp="+year+"1231",
          {headers:{"User-Agent":"Mozilla/5.0"},signal:c.signal});
        clearTimeout(tm);
      }catch{clearTimeout(tm);return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"})}
      if(!r.ok)return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});
      const d=await r.json(),hit=d?.archived_snapshots?.closest;
      if(!hit?.available||!hit.timestamp)return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[]});
      ts=String(hit.timestamp);
    }

    const account=encodeURIComponent(username);
    const urls=[
      rootUrl,
      ...Array.from({length:20},(_,i)=>`http://www.wretch.cc/album/album.php?id=${account}&book=${i+1}`)
    ];

    const pages=[];
    for(let i=0;i<urls.length;i+=4){
      const batch=await Promise.all(urls.slice(i,i+4).map(u=>fetchText(`https://web.archive.org/web/${ts}id_/${u}`)));
      pages.push(...batch.filter(Boolean));
    }

    let thumbs=[...pages.join("\n").matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>/wretch\.yimg\.com/i.test(u)&&/\/thumbs\//i.test(u)&&/\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u))
      .map(u=>u.startsWith("//")?"http:"+u:u);

    thumbs=[...new Set(thumbs)].slice(0,120);

    async function checkOne(imageUrl){
      const c=new AbortController(),tm=setTimeout(()=>c.abort(),5000);
      try{
        const q="https://archive.org/wayback/available?url="+encodeURIComponent(imageUrl)+"&timestamp="+ts.slice(0,8);
        const r=await fetch(q,{headers:{"User-Agent":"Mozilla/5.0"},signal:c.signal});
        clearTimeout(tm);if(!r.ok)return null;
        const d=await r.json(),hit=d?.archived_snapshots?.closest;
        if(!hit?.available||!hit.timestamp)return null;
        return {imageUrl,timestamp:String(hit.timestamp)};
      }catch{clearTimeout(tm);return null}
    }

    const found=[];
    for(let i=0;i<thumbs.length;i+=10){
      found.push(...(await Promise.all(thumbs.slice(i,i+10).map(checkOne))).filter(Boolean));
    }

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.timestamp,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.timestamp)+"&url="+encodeURIComponent(x.imageUrl)
    }));

    const result={ok:true,username,year,snapshotTimestamp:ts,albumPages:pages.length,total:thumbs.length,recoveredCount:photos.length,photos};

    // 2. Never cache zero-photo failures. A later retry can recover them.
    if(photos.length){
      await cacheSet(cfg,cacheKey,result,2592000); // 30 days
    }

    return res.status(200).json(result);
  }catch{
    return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});
  }
};