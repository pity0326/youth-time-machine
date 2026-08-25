module.exports = async function handler(req,res){
  const rawUrl=String(req.query.url||"").trim();
  const requestedTs=String(req.query.ts||"").trim();

  if(!rawUrl){
    return res.status(400).json({error:"缺少圖片網址"});
  }

  let parsed;
  try{
    parsed=new URL(rawUrl);
  }catch{
    return res.status(400).json({error:"圖片網址不正確"});
  }

  const host=parsed.hostname.toLowerCase();
  if(!/(^|\.)wretch\.yimg\.com$/.test(host)){
    return res.status(403).json({error:"不允許的圖片來源"});
  }

  const ua={"User-Agent":"Mozilla/5.0","Accept":"image/avif,image/webp,image/apng,image/*,*/*;q=0.8"};

  async function fetchImage(archivedUrl,timeout=7000){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(archivedUrl,{
        headers:ua,
        redirect:"follow",
        signal:c.signal,
        cache:"no-store"
      });
      clearTimeout(timer);

      const ct=(r.headers.get("content-type")||"").toLowerCase();
      if(!r.ok||!ct.startsWith("image/")) return null;

      const buf=Buffer.from(await r.arrayBuffer());
      if(!buf.length) return null;

      return {buf,ct,finalUrl:r.url};
    }catch{
      clearTimeout(timer);
      return null;
    }
  }

  async function nearestTimestamp(url,date){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),5000);
    try{
      const api="https://archive.org/wayback/available?url="+
        encodeURIComponent(url)+"&timestamp="+encodeURIComponent(date);
      const r=await fetch(api,{
        headers:{"User-Agent":"YouthTimeMachine/2.1","Accept":"application/json"},
        signal:c.signal,
        cache:"no-store"
      });
      clearTimeout(timer);
      if(!r.ok) return null;

      const d=await r.json();
      const hit=d?.archived_snapshots?.closest;
      return hit?.available&&hit.timestamp ? String(hit.timestamp) : null;
    }catch{
      clearTimeout(timer);
      return null;
    }
  }

  function archiveUrl(ts,url){
    return `https://web.archive.org/web/${ts}id_/${url}`;
  }

  try{
    const attempts=[];
    const add=(ts,url)=>{
      if(!ts||!/^\d{14}$/.test(ts)||!url)return;
      const key=ts+"|"+url;
      if(!attempts.some(x=>x.key===key)) attempts.push({key,ts,url});
    };

    // 1. Exact timestamp that photo-wall previously confirmed.
    if(/^\d{14}$/.test(requestedTs)){
      add(requestedTs,rawUrl);
    }

    // 2. Try the same URL with http/https swapped.
    const alt=new URL(rawUrl);
    alt.protocol=alt.protocol==="http:"?"https:":"http:";
    if(/^\d{14}$/.test(requestedTs)){
      add(requestedTs,alt.href);
    }

    // First pass: exact archive timestamp.
    for(const a of attempts){
      const hit=await fetchImage(archiveUrl(a.ts,a.url));
      if(hit){
        res.setHeader("Content-Type",hit.ct);
        res.setHeader("Cache-Control","public, max-age=604800, s-maxage=604800, stale-while-revalidate=2592000");
        res.setHeader("X-YTM-Photo-Source","exact");
        return res.status(200).send(hit.buf);
      }
    }

    // 3. If exact snapshot temporarily fails, ask availability for a nearby image snapshot.
    const date=/^\d{14}$/.test(requestedTs)?requestedTs.slice(0,8):"20131227";
    const urls=[rawUrl,alt.href];

    for(const u of urls){
      const nearest=await nearestTimestamp(u,date);
      if(!nearest) continue;

      const hit=await fetchImage(archiveUrl(nearest,u));
      if(hit){
        res.setHeader("Content-Type",hit.ct);
        res.setHeader("Cache-Control","public, max-age=604800, s-maxage=604800, stale-while-revalidate=2592000");
        res.setHeader("X-YTM-Photo-Source","nearest");
        return res.status(200).send(hit.buf);
      }
    }

    // Returning 404 means the frontend can simply remove this one image,
    // without breaking the rest of the photo wall.
    return res.status(404).json({
      error:"這張照片目前無法從 Internet Archive 讀取"
    });

  }catch{
    return res.status(404).json({
      error:"照片暫時無法讀取"
    });
  }
};