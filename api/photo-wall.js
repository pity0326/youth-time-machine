module.exports=async function handler(req,res){
  const diagnostic={stage:"start",entryPages:0,bookCount:0,albumPages:0,thumbCount:0,recoveredCount:0};
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();
    let ts=String(req.query.ts||"").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))
      return res.status(400).json({ok:false,error:"帳號格式不正確",diagnostic});
    if(!/^\d{4}$/.test(year))
      return res.status(400).json({ok:false,error:"年份格式不正確",diagnostic});
    if(ts&&!/^\d{14}$/.test(ts))ts="";

    async function timedFetch(url,timeout=8000,accept="*/*"){
      const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{
          headers:{"User-Agent":"YouthTimeMachine/direct-album-1.0","Accept":accept},
          redirect:"follow",signal:c.signal,cache:"no-store"
        });
        clearTimeout(tm);return r;
      }catch{clearTimeout(tm);return null}
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

    async function archivedHtml(url,stamp){
      let useTs=stamp;
      if(!useTs)useTs=await availability(url,`${year}1231`);
      if(!useTs)return null;
      const r=await timedFetch(`https://web.archive.org/web/${useTs}id_/${url}`,8000,"text/html,*/*");
      if(!r?.ok)return null;
      try{return {html:await r.text(),ts:useTs,url}}catch{return null}
    }

    const id=encodeURIComponent(username);

    // IMPORTANT: Do not depend on /album/{username} root anymore.
    // Start from actual Wretch album.php pages, which are the pages we previously proved can contain thumbnails.
    diagnostic.stage="entry_album_pages";
    const entryCandidates=[];
    for(let book=1;book<=20;book++){
      entryCandidates.push(`http://www.wretch.cc/album/album.php?id=${id}&book=${book}`);
    }

    const entryPages=[];
    for(let i=0;i<entryCandidates.length;i+=4){
      const batch=entryCandidates.slice(i,i+4);
      const got=await Promise.all(batch.map(async url=>{
        // First try the exact timestamp already found by year search.
        let page=null;
        if(ts)page=await archivedHtml(url,ts);
        // If that book wasn't saved at the exact same moment, ask Wayback for its nearest snapshot.
        if(!page){
          const ownTs=await availability(url,`${year}1231`);
          if(ownTs)page=await archivedHtml(url,ownTs);
        }
        return page;
      }));
      entryPages.push(...got.filter(Boolean));
    }
    diagnostic.entryPages=entryPages.length;

    if(!entryPages.length){
      diagnostic.stage="album_php_unavailable";
      return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[],reason:diagnostic.stage,diagnostic});
    }

    // Discover additional book links from pages that actually loaded.
    diagnostic.stage="discover_books";
    const books=new Set();
    for(const p of entryPages){
      for(const m of p.html.matchAll(/album\.php\?[^"'<>]*\bid=([^&"'<>]+)[^"'<>]*\bbook=(\d{1,3})/gi)){
        const n=Number(m[2]); if(n>=1&&n<=100)books.add(n);
      }
      for(const m of p.html.matchAll(/[?&]book=(\d{1,3})/gi)){
        const n=Number(m[1]); if(n>=1&&n<=100)books.add(n);
      }
    }
    diagnostic.bookCount=books.size||entryPages.length;
    diagnostic.albumPages=entryPages.length;

    // Extract thumbnails directly from these known-good album.php pages.
    diagnostic.stage="extract_thumbnails";
    let thumbs=[...entryPages.map(p=>p.html).join("\n").matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>/wretch\.yimg\.com/i.test(u)&&/\/thumbs\//i.test(u)&&/\.(?:jpg|jpeg|png|gif)(?:\?|$)/i.test(u))
      .map(u=>u.startsWith("//")?"http:"+u:u);
    thumbs=[...new Set(thumbs)].slice(0,160);
    diagnostic.thumbCount=thumbs.length;

    if(!thumbs.length){
      diagnostic.stage="album_pages_loaded_but_no_thumbs";
      return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[],reason:diagnostic.stage,diagnostic});
    }

    // Verify image snapshots and build proxy URLs.
    diagnostic.stage="verify_images";
    async function verify(imageUrl){
      const its=await availability(imageUrl,`${year}1231`);
      return its?{imageUrl,ts:its}:null;
    }

    const found=[];
    for(let i=0;i<thumbs.length;i+=10){
      found.push(...(await Promise.all(thumbs.slice(i,i+10).map(verify))).filter(Boolean));
    }
    diagnostic.recoveredCount=found.length;
    diagnostic.stage=found.length?"success":"thumbnail_snapshots_unavailable";

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.ts,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.ts)+"&url="+encodeURIComponent(x.imageUrl)
    }));

    return res.status(200).json({
      ok:true,username,year,total:thumbs.length,recoveredCount:photos.length,photos,diagnostic
    });
  }catch{
    diagnostic.stage="unexpected_error";
    return res.status(503).json({ok:false,error:"照片診斷暫時無法完成",diagnostic});
  }
};