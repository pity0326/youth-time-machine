module.exports=async function handler(req,res){
  try{
    const ts=String(req.query.ts||"").trim();
    const raw=String(req.query.url||"").trim();

    if(!/^\d{14}$/.test(ts))
      return res.status(400).send("Bad timestamp");
    if(!/^https?:\/\/[^/]*wretch\.yimg\.com\//i.test(raw))
      return res.status(400).send("Bad image URL");

    const variants=[
      `https://web.archive.org/web/${ts}id_/${raw}`,
      `https://web.archive.org/web/${ts}im_/${raw}`,
      `https://web.archive.org/web/${ts}/${raw}`
    ];

    for(const target of variants){
      const c=new AbortController();
      const tm=setTimeout(()=>c.abort(),8000);
      try{
        const r=await fetch(target,{
          headers:{"User-Agent":"YouthTimeMachine/photo-proxy-2.0","Accept":"image/avif,image/webp,image/*,*/*"},
          redirect:"follow",signal:c.signal,cache:"no-store"
        });
        clearTimeout(tm);
        if(!r.ok)continue;
        const type=(r.headers.get("content-type")||"").toLowerCase();
        if(!type.startsWith("image/"))continue;
        const buf=Buffer.from(await r.arrayBuffer());
        if(buf.length<100)continue;

        res.setHeader("Content-Type",type.split(";")[0]||"image/jpeg");
        res.setHeader("Cache-Control","public, max-age=86400, s-maxage=604800");
        return res.status(200).send(buf);
      }catch(e){
        clearTimeout(tm);
      }
    }

    return res.status(404).send("Archived image unavailable");
  }catch{
    return res.status(502).send("Photo proxy unavailable");
  }
};