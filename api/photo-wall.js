export default async function handler(req,res){
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))
      return res.status(400).json({ok:false,error:"帳號格式不正確"});

    const rootUrl=`http://www.wretch.cc/album/${encodeURIComponent(username)}`;

    async function timedFetch(url,timeout=6500){
      const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"},redirect:"follow",signal:c.signal});
        clearTimeout(tm);
        return r;
      }catch(e){clearTimeout(tm);return null}
    }

    const av=`https://archive.org/wayback/available?url=${encodeURIComponent(rootUrl)}&timestamp=${year}1231`;
    const ar=await timedFetch(av,5500);
    if(!ar?.ok) return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});

    const ad=await ar.json();
    const hit=ad?.archived_snapshots?.closest;
    if(!hit?.available||!hit.timestamp)
      return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[]});

    const ts=hit.timestamp;
    const rootSnap=`https://web.archive.org/web/${ts}id_/${rootUrl}`;
    const rr=await timedFetch(rootSnap,7000);
    if(!rr?.ok) return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[]});
    const rootHtml=await rr.text();

    let bookLinks=[...rootHtml.matchAll(/href=["']([^"']*book=\d+[^"']*)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"));

    function normalize(link){
      try{
        link=link.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[^/]*\//i,"");
        return new URL(link,"http://www.wretch.cc/album/").href;
      }catch{return null}
    }

    let books=[...new Set(bookLinks.map(normalize).filter(Boolean))]
      .filter(u=>/album\.php/i.test(u))
      .slice(0,10);

    if(!books.length) books=[rootUrl];

    const pages=[rootHtml];
    for(let i=0;i<books.length;i+=4){
      const batch=await Promise.all(books.slice(i,i+4).map(async u=>{
        const r=await timedFetch(`https://web.archive.org/web/${ts}id_/${u}`,6500);
        return r?.ok ? await r.text() : "";
      }));
      pages.push(...batch.filter(Boolean));
    }

    let thumbs=[...pages.join("\n").matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>/wretch\.yimg\.com/i.test(u)&&/\/thumbs\//i.test(u)&&/\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u))
      .map(u=>u.startsWith("//")?"http:"+u:u);

    thumbs=[...new Set(thumbs)].slice(0,60);

    // Return immediately. /api/photo-image will resolve each thumbnail independently.
    const photos=thumbs.map((url,i)=>({
      index:i+1,
      proxyUrl:"/api/photo-image?date="+encodeURIComponent(ts.slice(0,8))+"&url="+encodeURIComponent(url)
    }));

    res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=21600");
    return res.status(200).json({
      ok:true,
      total:photos.length,
      recoveredCount:photos.length,
      photos
    });
  }catch{
    return res.status(503).json({ok:false,error:"照片時光機暫時忙碌"});
  }
}