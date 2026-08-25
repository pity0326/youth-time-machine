export default async function handler(req,res){
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username)){
      return res.status(400).json({ok:false,error:"帳號格式不正確"});
    }
    if(!/^\d{4}$/.test(year)){
      return res.status(400).json({ok:false,error:"年份格式不正確"});
    }

    const rootUrl=`http://www.wretch.cc/album/${encodeURIComponent(username)}`;

    async function fetchJson(url, timeout=8000){
      const c=new AbortController();
      const t=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"},signal:c.signal});
        clearTimeout(t);
        return r;
      }catch(e){
        clearTimeout(t);
        throw e;
      }
    }

    async function fetchText(url, timeout=10000){
      const c=new AbortController();
      const t=setTimeout(()=>c.abort(),timeout);
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

    // 先找該年份最接近的相簿首頁快照
    const available=`https://archive.org/wayback/available?url=${encodeURIComponent(rootUrl)}&timestamp=${year}1231`;
    const ar=await fetchJson(available);
    if(!ar.ok){
      return res.status(502).json({ok:false,error:"Internet Archive 暫時無法查詢"});
    }
    const ad=await ar.json();
    const closest=ad?.archived_snapshots?.closest;

    if(!closest?.available||!closest.timestamp){
      return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[],albumPages:0});
    }

    const ts=closest.timestamp;

    // 讀相簿首頁原始 HTML
    const rootSnapshot=`https://web.archive.org/web/${ts}id_/${rootUrl}`;
    const rootHtml=await fetchText(rootSnapshot);
    if(!rootHtml){
      return res.status(200).json({ok:true,total:0,recoveredCount:0,photos:[],albumPages:0});
    }

    // 找真正的相簿內頁 book=，不是只抓首頁封面
    let bookLinks=[
      ...rootHtml.matchAll(/href=["']([^"']*album\.php\?[^"']*book=\d+[^"']*)["']/gi)
    ].map(m=>m[1]);

    // 某些頁面只寫相對連結 ./album.php?...
    bookLinks.push(...[
      ...rootHtml.matchAll(/href=["']([^"']*book=\d+[^"']*)["']/gi)
    ].map(m=>m[1]));

    function normalizeBookLink(link){
      try{
        let cleaned=link.replace(/&amp;/g,"&");
        if(/^https?:\/\/web\.archive\.org\/web\/\d+[^/]*\//i.test(cleaned)){
          cleaned=cleaned.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[^/]*\//i,"");
        }
        return new URL(cleaned,"http://www.wretch.cc/album/").href;
      }catch{
        return null;
      }
    }

    let books=[...new Set(bookLinks.map(normalizeBookLink).filter(Boolean))]
      .filter(u=>/\/album\/album\.php\?/i.test(u)&&/book=\d+/i.test(u))
      .slice(0,12);

    // 若首頁沒列出 book，至少也掃首頁本身
    if(!books.length) books=[rootUrl];

    // 讀每一本相簿內頁，收集真正照片縮圖
    const albumHtmlPages=[];
    for(let i=0;i<books.length;i+=4){
      const batch=books.slice(i,i+4);
      const htmls=await Promise.all(batch.map(u=>
        fetchText(`https://web.archive.org/web/${ts}id_/${u}`)
      ));
      albumHtmlPages.push(...htmls.filter(Boolean));
    }

    const allHtml=[rootHtml,...albumHtmlPages].join("\n");

    let thumbs=[...allHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map(m=>m[1].replace(/&amp;/g,"&"))
      .filter(u=>
        /wretch\.yimg\.com/i.test(u) &&
        /\/thumbs\//i.test(u) &&
        /\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u)
      )
      .map(u=>u.startsWith("//")?"http:"+u:u);

    // 去重，最多先救 80 張，避免一次查太久
    thumbs=[...new Set(thumbs)].slice(0,80);

    async function checkOne(imageUrl){
      const c=new AbortController();
      const t=setTimeout(()=>c.abort(),5500);
      try{
        const q=`https://archive.org/wayback/available?url=${encodeURIComponent(imageUrl)}&timestamp=${ts.slice(0,8)}`;
        const r=await fetch(q,{headers:{"User-Agent":"Mozilla/5.0"},signal:c.signal});
        clearTimeout(t);
        if(!r.ok)return null;
        const d=await r.json();
        const hit=d?.archived_snapshots?.closest;
        if(!hit?.available||!hit.timestamp)return null;
        return {imageUrl,timestamp:hit.timestamp};
      }catch{
        clearTimeout(t);
        return null;
      }
    }

    const found=[];
    for(let i=0;i<thumbs.length;i+=8){
      const batch=thumbs.slice(i,i+8);
      found.push(...(await Promise.all(batch.map(checkOne))).filter(Boolean));
    }

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.timestamp,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.timestamp)+"&url="+encodeURIComponent(x.imageUrl)
    }));

    return res.status(200).json({
      ok:true,
      username,
      year,
      snapshotTimestamp:ts,
      albumPages:books.length,
      total:thumbs.length,
      recoveredCount:photos.length,
      photos
    });

  }catch(e){
    return res.status(502).json({
      ok:false,
      error:e?.name==="AbortError"
        ?"Internet Archive 回應較慢，請稍後再試"
        :"照片搜尋失敗"
    });
  }
}