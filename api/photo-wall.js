function redisConfig(){
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  if(!redisUrl||!redisToken)return null;
  return {baseUrl:redisUrl.replace(/\/$/,""),token:redisToken};
}
async function redisCall(cfg,path){
  const r=await fetch(cfg.baseUrl+path,{headers:{Authorization:`Bearer ${cfg.token}`},cache:"no-store"});
  if(!r.ok)throw new Error(`Redis HTTP ${r.status}`);
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
  const diagnostic={
    stage:"start",rootPages:0,bookCount:0,albumPages:0,thumbCount:0,recoveredCount:0
  };
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();
    const hintTs=String(req.query.ts||"").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))
      return res.status(400).json({ok:false,error:"帳號格式不正確",diagnostic});
    if(!/^\d{4}$/.test(year))
      return res.status(400).json({ok:false,error:"年份格式不正確",diagnostic});

    const cfg=redisConfig();
    const cacheKey=`ytm:photos:v3:${username.toLowerCase()}:${year}`;

    const cached=await cacheGet(cfg,cacheKey);
    if(cached?.ok===true&&Array.isArray(cached.photos)&&cached.photos.length){
      return res.status(200).json({...cached,serverCache:true});
    }

    async function timedFetch(url,timeout=7000,accept="*/*"){
      const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{
          headers:{"User-Agent":"YouthTimeMachine/diag-1.0","Accept":accept},
          redirect:"follow",signal:c.signal,cache:"no-store"
        });
        clearTimeout(t);return r;
      }catch{clearTimeout(t);return null}
    }

    async function availability(url,stamp){
      const api="https://archive.org/wayback/available?url="+encodeURIComponent(url)+"&timestamp="+encodeURIComponent(stamp);
      const r=await timedFetch(api,5500,"application/json");
      if(!r?.ok)return null;
      try{
        const d=await r.json(),h=d?.archived_snapshots?.closest;
        return h?.available&&h.timestamp?String(h.timestamp):null;
      }catch{return null}
    }

    async function rawHtml(url,ts){
      if(!ts)return null;
      const r=await timedFetch(`https://web.archive.org/web/${ts}id_/${url}`,7500,"text/html,*/*");
      if(!r?.ok)return null;
      try{return await r.text()}catch{return null}
    }

    const account=encodeURIComponent(username);
    const roots=[
      `http://www.wretch.cc/album/${account}`,
      `http://www.wretch.cc/album/index.php?id=${account}`
    ];

    diagnostic.stage="root";
    const rootPages=[];
    for(const url of roots){
      const candidates=[];
      if(/^\d{14}$/.test(hintTs))candidates.push(hintTs);
      const ats=await availability(url,`${year}1231`);
      if(ats)candidates.push(ats);
      for(const ts of [...new Set(candidates)]){
        const body=await rawHtml(url,ts);
        if(body){rootPages.push({url,ts,html:body});break}
      }
    }
    diagnostic.rootPages=rootPages.length;

    diagnostic.stage="books";
    const books=new Set();
    for(const p of rootPages){
      for(const m of p.html.matchAll(/album\.php\?[^"'<>]*book=(\d{1,3})/gi)){
        const n=Number(m[1]);if(n>=1&&n<=100)books.add(n);
      }
      for(const m of p.html.matchAll(/[?&]book=(\d{1,3})/gi)){
        const n=Number(m[1]);if(n>=1&&n<=100)books.add(n);
      }
    }
    if(!books.size)for(let i=1;i<=20;i++)books.add(i);
    diagnostic.bookCount=books.size;

    diagnostic.stage="album_pages";
    const pages=[...rootPages.map(x=>x.html)];
    const bookUrls=[...books].slice(0,30).map(n=>`http://www.wretch.cc/album/album.php?id=${account}&book=${n}`);
    let successfulBookPages=0;
    for(let i=0;i<bookUrls.length;i+=5){
      const batch=await Promise.all(bookUrls.slice(i,i+5).map(async url=>{
        const ts=await availability(url,`${year}1231`);
        if(!ts)return null;
        const body=await rawHtml(url,ts);
        if(body)successfulBookPages++;
        return body;
      }));
      pages.push(...batch.filter(Boolean));
    }
    diagnostic.albumPages=successfulBookPages;

    diagnostic.stage="thumbnails";
    let thumbs=[...pages.join("\n").matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>/wretch\.yimg\.com/i.test(u)&&/\/thumbs\//i.test(u)&&/\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u))
      .map(u=>u.startsWith("//")?"http:"+u:u);
    thumbs=[...new Set(thumbs)].slice(0,150);
    diagnostic.thumbCount=thumbs.length;

    if(!thumbs.length){
      diagnostic.stage=diagnostic.rootPages===0?"root_unavailable":
        diagnostic.albumPages===0?"album_pages_unavailable":"no_thumbnail_urls";
      return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[],reason:diagnostic.stage,diagnostic});
    }

    diagnostic.stage="verify_images";
    async function verify(url){
      const ts=await availability(url,`${year}1231`);
      return ts?{url,ts}:null;
    }

    const found=[];
    for(let i=0;i<thumbs.length;i+=10){
      found.push(...(await Promise.all(thumbs.slice(i,i+10).map(verify))).filter(Boolean));
    }
    diagnostic.recoveredCount=found.length;
    diagnostic.stage=found.length?"success":"images_unavailable";

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.ts,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.ts)+"&url="+encodeURIComponent(x.url)
    }));

    const result={
      ok:true,username,year,total:thumbs.length,recoveredCount:photos.length,photos,diagnostic
    };

    if(photos.length)await cacheSet(cfg,cacheKey,result,2592000);
    return res.status(200).json(result);

  }catch(e){
    diagnostic.stage="unexpected_error";
    return res.status(503).json({ok:false,error:"照片診斷暫時無法完成",diagnostic});
  }
};