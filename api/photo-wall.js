export default async function handler(req,res){
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();
    let ts=String(req.query.ts||"").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username)){
      return res.status(400).json({ok:false,error:"帳號格式不正確"});
    }
    if(!/^\d{4}$/.test(year)){
      return res.status(400).json({ok:false,error:"年份格式不正確"});
    }
    if(ts && !/^\d{14}$/.test(ts)) ts="";

    async function fetchText(url,timeout=8500){
      const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{
          headers:{"User-Agent":"Mozilla/5.0"},
          redirect:"follow",
          signal:c.signal
        });
        clearTimeout(t);
        if(!r.ok)return null;
        return await r.text();
      }catch{
        clearTimeout(t);
        return null;
      }
    }

    // If the year search already found a real snapshot, reuse that exact timestamp.
    // Otherwise fall back to availability.
    if(!ts){
      const rootUrl=`http://www.wretch.cc/album/${encodeURIComponent(username)}`;
      const c=new AbortController(),t=setTimeout(()=>c.abort(),6500);
      let r;
      try{
        r=await fetch(
          "https://archive.org/wayback/available?url="+encodeURIComponent(rootUrl)+"&timestamp="+year+"1231",
          {headers:{"User-Agent":"Mozilla/5.0"},signal:c.signal}
        );
        clearTimeout(t);
      }catch{
        clearTimeout(t);
        return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});
      }
      if(!r.ok)return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});
      const d=await r.json(),hit=d?.archived_snapshots?.closest;
      if(!hit?.available||!hit.timestamp){
        return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[],albumPages:0});
      }
      ts=String(hit.timestamp);
    }

    // Scan the account album home plus book=1..16.
    // This avoids relying on the archive homepage to expose every book link.
    const account=encodeURIComponent(username);
    const urls=[
      `http://www.wretch.cc/album/${account}`,
      ...Array.from({length:16},(_,i)=>`http://www.wretch.cc/album/album.php?id=${account}&book=${i+1}`)
    ];

    const pages=[];
    for(let i=0;i<urls.length;i+=4){
      const batch=urls.slice(i,i+4);
      const htmls=await Promise.all(
        batch.map(u=>fetchText(`https://web.archive.org/web/${ts}id_/${u}`))
      );
      pages.push(...htmls.filter(Boolean));
    }

    if(!pages.length){
      return res.status(200).json({
        ok:true,total:0,recoveredCount:0,photos:[],albumPages:0,snapshotTimestamp:ts
      });
    }

    const allHtml=pages.join("\n");

    let thumbs=[...allHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>
        /wretch\.yimg\.com/i.test(u) &&
        /\/thumbs\//i.test(u) &&
        /\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u)
      )
      .map(u=>u.startsWith("//")?"http:"+u:u);

    thumbs=[...new Set(thumbs)].slice(0,100);

    async function checkOne(imageUrl){
      const c=new AbortController(),t=setTimeout(()=>c.abort(),5000);
      try{
        const q="https://archive.org/wayback/available?url="+
          encodeURIComponent(imageUrl)+"&timestamp="+ts.slice(0,8);
        const r=await fetch(q,{
          headers:{"User-Agent":"Mozilla/5.0"},
          signal:c.signal
        });
        clearTimeout(t);
        if(!r.ok)return null;

        const d=await r.json(),hit=d?.archived_snapshots?.closest;
        if(!hit?.available||!hit.timestamp)return null;

        return {imageUrl,timestamp:String(hit.timestamp)};
      }catch{
        clearTimeout(t);
        return null;
      }
    }

    // Verify thumbnails in controlled batches.
    const found=[];
    for(let i=0;i<thumbs.length;i+=10){
      found.push(...(await Promise.all(thumbs.slice(i,i+10).map(checkOne))).filter(Boolean));
    }

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.timestamp,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.timestamp)+
        "&url="+encodeURIComponent(x.imageUrl)
    }));

    res.setHeader("Cache-Control","s-maxage=1800, stale-while-revalidate=7200");

    return res.status(200).json({
      ok:true,
      username,
      year,
      snapshotTimestamp:ts,
      albumPages:pages.length,
      total:thumbs.length,
      recoveredCount:photos.length,
      photos
    });

  }catch{
    return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});
  }
}