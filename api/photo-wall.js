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
    const hintTs=String(req.query.ts||"").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username)){
      return res.status(400).json({ok:false,error:"帳號格式不正確"});
    }
    if(!/^\d{4}$/.test(year)){
      return res.status(400).json({ok:false,error:"年份格式不正確"});
    }

    const cfg=redisConfig();
    const cacheKey=`ytm:photos:v2:${username.toLowerCase()}:${year}`;

    // 成功挖過就直接回雲端快取，不再碰 Wayback。
    const cached=await cacheGet(cfg,cacheKey);
    if(cached?.ok===true&&Array.isArray(cached.photos)&&cached.photos.length){
      return res.status(200).json({...cached,serverCache:true});
    }

    async function timedFetch(url,timeout=7000,accept="*/*"){
      const c=new AbortController();
      const t=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{
          headers:{"User-Agent":"YouthTimeMachine/2.2","Accept":accept},
          redirect:"follow",
          signal:c.signal,
          cache:"no-store"
        });
        clearTimeout(t);
        return r;
      }catch(e){
        clearTimeout(t);
        return null;
      }
    }

    async function availability(url,stamp){
      const api="https://archive.org/wayback/available?url="+
        encodeURIComponent(url)+"&timestamp="+encodeURIComponent(stamp);
      const r=await timedFetch(api,5500,"application/json");
      if(!r?.ok)return null;
      try{
        const d=await r.json(),hit=d?.archived_snapshots?.closest;
        if(!hit?.available||!hit.timestamp)return null;
        return {timestamp:String(hit.timestamp),url:String(hit.url||"")};
      }catch{return null}
    }

    async function rawHtml(url,ts){
      if(!ts)return null;
      const r=await timedFetch(`https://web.archive.org/web/${ts}id_/${url}`,7500,"text/html,*/*");
      if(!r?.ok)return null;
      const ct=(r.headers.get("content-type")||"").toLowerCase();
      if(ct && !ct.includes("text") && !ct.includes("html"))return null;
      try{return await r.text()}catch{return null}
    }

    const account=encodeURIComponent(username);
    const rootUrls=[
      `http://www.wretch.cc/album/${account}`,
      `http://www.wretch.cc/album/index.php?id=${account}`
    ];

    // 先收集可用的首頁快照，不再假設一個 timestamp 能套用所有 book。
    const rootPages=[];
    for(const rootUrl of rootUrls){
      const candidates=[];
      if(/^\d{14}$/.test(hintTs))candidates.push(hintTs);

      const hit=await availability(rootUrl,`${year}1231`);
      if(hit?.timestamp)candidates.push(hit.timestamp);

      for(const ts of [...new Set(candidates)]){
        const h=await rawHtml(rootUrl,ts);
        if(h){
          rootPages.push({url:rootUrl,ts,html:h});
          break;
        }
      }
    }

    // 從首頁抓 book 編號；抓不到時仍嘗試 1~20。
    const bookNums=new Set();
    for(const p of rootPages){
      for(const m of p.html.matchAll(/(?:book=|\/album\/)(\d{1,3})(?:[&"'<>]|$)/gi)){
        const n=Number(m[1]);
        if(n>=1&&n<=100)bookNums.add(n);
      }
      for(const m of p.html.matchAll(/album\.php\?[^"'<>]*book=(\d{1,3})/gi)){
        const n=Number(m[1]);
        if(n>=1&&n<=100)bookNums.add(n);
      }
    }
    if(!bookNums.size){
      for(let i=1;i<=20;i++)bookNums.add(i);
    }

    // 每一本相簿「各自找自己的 Wayback timestamp」。
    // 這是修正重點：之前用同一個 ts 套全部 book，常會得到 0 張。
    const bookUrls=[...bookNums].slice(0,30).map(n=>
      `http://www.wretch.cc/album/album.php?id=${account}&book=${n}`
    );

    const albumPages=[...rootPages.map(x=>x.html)];

    for(let i=0;i<bookUrls.length;i+=5){
      const batch=bookUrls.slice(i,i+5);

      const htmls=await Promise.all(batch.map(async url=>{
        const hit=await availability(url,`${year}1231`);
        if(!hit?.timestamp)return null;
        return await rawHtml(url,hit.timestamp);
      }));

      albumPages.push(...htmls.filter(Boolean));
    }

    if(!albumPages.length){
      return res.status(200).json({
        ok:true,
        total:0,
        recoveredCount:0,
        photos:[],
        reason:"no_album_pages"
      });
    }

    let thumbs=[...albumPages.join("\n").matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>
        /wretch\.yimg\.com/i.test(u) &&
        /\/thumbs\//i.test(u) &&
        /\.(?:jpg|jpeg|png|gif)(?:\?|$)/i.test(u)
      )
      .map(u=>u.startsWith("//")?"http:"+u:u);

    thumbs=[...new Set(thumbs)].slice(0,150);

    if(!thumbs.length){
      return res.status(200).json({
        ok:true,
        total:0,
        recoveredCount:0,
        photos:[],
        albumPages:albumPages.length,
        reason:"no_thumbs"
      });
    }

    async function verifyImage(imageUrl){
      const hit=await availability(imageUrl,`${year}1231`);
      if(!hit?.timestamp)return null;
      return {
        imageUrl,
        timestamp:hit.timestamp
      };
    }

    const found=[];
    for(let i=0;i<thumbs.length;i+=10){
      const batch=thumbs.slice(i,i+10);
      found.push(...(await Promise.all(batch.map(verifyImage))).filter(Boolean));
    }

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.timestamp,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.timestamp)+
        "&url="+encodeURIComponent(x.imageUrl)
    }));

    const result={
      ok:true,
      username,
      year,
      albumPages:albumPages.length,
      total:thumbs.length,
      recoveredCount:photos.length,
      photos
    };

    // 只有真的挖到照片才快取 30 天。
    if(photos.length){
      await cacheSet(cfg,cacheKey,result,2592000);
    }

    return res.status(200).json(result);

  }catch{
    return res.status(503).json({
      ok:false,
      error:"照片時光機暫時忙碌"
    });
  }
};