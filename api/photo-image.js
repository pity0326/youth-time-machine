export default async function handler(req,res){
  try{
    const {url,ts}=req.query;
    if(!url||!ts)return res.status(400).json({error:"缺少圖片參數"});
    if(!/^\d{14}$/.test(String(ts)))return res.status(400).json({error:"時間格式不正確"});
    let parsed;try{parsed=new URL(String(url))}catch{return res.status(400).json({error:"圖片網址不正確"})}
    const host=parsed.hostname.toLowerCase();
    if(!/(^|\.)wretch\.yimg\.com$/.test(host))return res.status(403).json({error:"不允許的圖片來源"});
    const archived=`https://web.archive.org/web/${ts}id_/${url}`;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    const r=await fetch(archived,{headers:{"User-Agent":"Mozilla/5.0"},redirect:"follow",signal:controller.signal});
    clearTimeout(timer);
    const ct=r.headers.get("content-type")||"";
    if(!r.ok||!ct.startsWith("image/"))return res.status(404).json({error:"這張照片目前無法讀取"});
    const buffer=Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type",ct);res.setHeader("Cache-Control","public,max-age=86400");
    return res.status(200).send(buffer);
  }catch(e){return res.status(502).json({error:e?.name==="AbortError"?"照片讀取逾時":"照片讀取失敗"})}
}