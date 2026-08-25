export default async function handler(req,res){
  try{
    const url=String(req.query.url||"");
    const date=String(req.query.date||"");
    if(!url||!/^\d{8}$/.test(date)) return res.status(400).end();

    let parsed;
    try{parsed=new URL(url)}catch{return res.status(400).end()}
    if(!/(^|\.)wretch\.yimg\.com$/i.test(parsed.hostname)) return res.status(403).end();

    const c1=new AbortController(),t1=setTimeout(()=>c1.abort(),5000);
    let av;
    try{
      av=await fetch("https://archive.org/wayback/available?url="+encodeURIComponent(url)+"&timestamp="+date,{
        headers:{"User-Agent":"YouthTimeMachine/1.3"},
        signal:c1.signal
      });
      clearTimeout(t1);
    }catch{clearTimeout(t1);return res.status(404).end()}

    if(!av.ok) return res.status(404).end();
    const ad=await av.json(),hit=ad?.archived_snapshots?.closest;
    if(!hit?.available||!hit.timestamp) return res.status(404).end();

    const archived=`https://web.archive.org/web/${hit.timestamp}id_/${url}`;
    const c2=new AbortController(),t2=setTimeout(()=>c2.abort(),6500);
    let r;
    try{
      r=await fetch(archived,{headers:{"User-Agent":"Mozilla/5.0"},redirect:"follow",signal:c2.signal});
      clearTimeout(t2);
    }catch{clearTimeout(t2);return res.status(404).end()}

    const ct=r.headers.get("content-type")||"";
    if(!r.ok||!ct.startsWith("image/")) return res.status(404).end();

    const buf=Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type",ct);
    res.setHeader("Cache-Control","public, max-age=86400, s-maxage=86400");
    return res.status(200).send(buf);
  }catch{return res.status(404).end()}
}