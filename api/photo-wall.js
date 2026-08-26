module.exports=async function handler(req,res){
  const diagnostic={stage:"start",htmlPages:0,htmlCandidates:0,cdxCandidates:0,recoveredCount:0};
  try{
    const username=String(req.query.username||"").trim();
    const year=String(req.query.year||"2013").trim();
    let ts=String(req.query.ts||"").trim();

    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))
      return res.status(400).json({ok:false,error:"帳號格式不正確",diagnostic});
    if(!/^(200[3-9]|201[0-4])$/.test(year))
      return res.status(400).json({ok:false,error:"年份格式不正確",diagnostic});
    if(ts&&!/^\d{14}$/.test(ts))ts="";

    res.setHeader("Cache-Control","no-store, max-age=0");

    async function timedFetch(url,timeout=7000,accept="*/*"){
      const c=new AbortController(),tm=setTimeout(()=>c.abort(),timeout);
      try{
        const r=await fetch(url,{
          headers:{"User-Agent":"YouthTimeMachine/photo-rescue-2.0","Accept":accept},
          redirect:"follow",signal:c.signal,cache:"no-store"
        });
        clearTimeout(tm); return r;
      }catch(e){clearTimeout(tm); return null}
    }

    async function available(url,stamp){
      const q="https://archive.org/wayback/available?url="+encodeURIComponent(url)+"&timestamp="+encodeURIComponent(stamp);
      const r=await timedFetch(q,5000,"application/json");
      if(!r?.ok)return null;
      try{
        const d=await r.json(),h=d?.archived_snapshots?.closest;
        return h?.available&&h.timestamp?{timestamp:String(h.timestamp),url:String(h.url||"")}:null;
      }catch{return null}
    }

    async function archivedHtml(url,stamp){
      const a=await available(url,stamp||`${year}1231`);
      if(!a)return null;
      const r=await timedFetch(`https://web.archive.org/web/${a.timestamp}id_/${url}`,7000,"text/html,*/*");
      if(!r?.ok)return null;
      try{return {html:await r.text(),timestamp:a.timestamp,url}}catch{return null}
    }

    function normalizeUrl(u){
      if(!u)return "";
      u=String(u).replace(/&amp;/g,"&").trim();
      if(u.startsWith("//"))u="http:"+u;
      if(u.startsWith("/"))return "";
      return u;
    }

    function looksLikeWretchImage(u){
      return /(?:^|\/\/)[^/]*wretch\.yimg\.com\//i.test(u) &&
             /\.(?:jpe?g|png|gif)(?:[?#]|$)/i.test(u);
    }

    const candidates=new Map();
    function addCandidate(url,timestamp="",source="html"){
      url=normalizeUrl(url);
      if(!looksLikeWretchImage(url))return;
      // Prefer thumbnail/image URLs belonging to this account.
      if(!new RegExp("/"+username.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"/","i").test(url))return;
      const cleanKey=url.replace(/^https:/i,"http:").replace(/[?#].*$/,"");
      const prev=candidates.get(cleanKey);
      if(!prev || (source==="cdx"&&prev.source!=="cdx"))
        candidates.set(cleanKey,{imageUrl:url,timestamp,source});
    }

    // Route A: inspect archived album.php pages.
    diagnostic.stage="album_html";
    const id=encodeURIComponent(username);
    const pageUrls=[];
    for(let book=1;book<=12;book++)
      pageUrls.push(`http://www.wretch.cc/album/album.php?id=${id}&book=${book}`);

    for(let i=0;i<pageUrls.length;i+=4){
      const pages=await Promise.all(pageUrls.slice(i,i+4).map(u=>archivedHtml(u,ts||`${year}1231`)));
      for(const p of pages.filter(Boolean)){
        diagnostic.htmlPages++;
        for(const m of p.html.matchAll(/(?:src|href)=["']([^"']+)["']/gi))
          addCandidate(m[1],p.timestamp,"html");
      }
    }
    diagnostic.htmlCandidates=candidates.size;

    // Route B: query Internet Archive CDX image index directly.
    // This can recover image records even when the saved album HTML is incomplete.
    diagnostic.stage="cdx_images";
    const cdxTargets=[
      `*.wretch.yimg.com/${username}/*`,
      `wretch.yimg.com/${username}/*`
    ];

    for(const target of cdxTargets){
      const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(target)+
        "&from="+year+"0101&to="+year+"1231"+
        "&output=json&fl=timestamp,original,mimetype,statuscode"+
        "&filter=statuscode:200&filter=mimetype:image/.*"+
        "&collapse=urlkey&limit=300&gzip=false";
      const r=await timedFetch(q,8000,"application/json,text/plain,*/*");
      if(!r?.ok)continue;
      let data=null;
      try{
        const text=await r.text();
        data=JSON.parse(text);
      }catch{continue}
      if(!Array.isArray(data)||data.length<2)continue;
      for(let i=1;i<data.length;i++){
        const row=data[i]||[];
        const stamp=String(row[0]||"");
        const original=String(row[1]||"");
        addCandidate(original,stamp,"cdx");
      }
    }
    diagnostic.cdxCandidates=[...candidates.values()].filter(x=>x.source==="cdx").length;

    if(!candidates.size){
      diagnostic.stage="no_image_records";
      return res.status(200).json({ok:true,username,year,total:0,recoveredCount:0,photos:[],source:"none",diagnostic});
    }

    // Prefer candidates that already have a CDX timestamp. Verify HTML-only URLs through availability.
    diagnostic.stage="verify";
    const all=[...candidates.values()].slice(0,180);
    const found=[];

    for(let i=0;i<all.length;i+=12){
      const batch=all.slice(i,i+12);
      const checked=await Promise.all(batch.map(async x=>{
        if(/^\d{14}$/.test(x.timestamp))
          return x;
        const a=await available(x.imageUrl,`${year}1231`);
        return a?{...x,timestamp:a.timestamp}:null;
      }));
      for(const x of checked.filter(Boolean)){
        found.push(x);
        if(found.length>=80)break;
      }
      if(found.length>=80)break;
    }

    diagnostic.recoveredCount=found.length;
    diagnostic.stage=found.length?"success":"records_not_retrievable";

    const sources=new Set(found.map(x=>x.source));
    const source=sources.size>1?"mixed":(sources.values().next().value||"none");

    const photos=found.map((x,i)=>({
      index:i+1,
      timestamp:x.timestamp,
      source:x.source,
      originalUrl:x.imageUrl,
      proxyUrl:"/api/photo-proxy?ts="+encodeURIComponent(x.timestamp)+"&url="+encodeURIComponent(x.imageUrl)
    }));

    return res.status(200).json({
      ok:true,username,year,total:candidates.size,recoveredCount:photos.length,photos,source,diagnostic
    });
  }catch(e){
    diagnostic.stage="unexpected_error";
    return res.status(503).json({ok:false,error:"照片搜尋暫時無法完成",diagnostic});
  }
};