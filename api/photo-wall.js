export default async function handler(req, res) {
  try {
    const albumSnapshot="https://web.archive.org/web/20131227084024id_/http://www.wretch.cc/album/album.php?id=BaBy217&book=2";
    const albumRes=await fetch(albumSnapshot,{headers:{"User-Agent":"Mozilla/5.0"}});
    if(!albumRes.ok)return res.status(502).json({ok:false,error:"相簿頁讀取失敗",status:albumRes.status});
    const albumHtml=await albumRes.text();
    let thumbs=[...albumHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1])
      .filter(u=>/wretch\.yimg\.com/i.test(u)&&/\/thumbs\//i.test(u)&&/\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u))
      .map(u=>u.startsWith("//")?"http:"+u:u);
    thumbs=[...new Set(thumbs)].slice(0,30);

    async function checkOne(imageUrl){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
      try{
        const api="https://archive.org/wayback/available?url="+encodeURIComponent(imageUrl)+"&timestamp=20131227";
        const r=await fetch(api,{headers:{"User-Agent":"Mozilla/5.0"},signal:controller.signal});
        clearTimeout(timer);
        if(!r.ok)return {imageUrl,found:false};
        const data=await r.json(),closest=data?.archived_snapshots?.closest;
        if(!closest?.available||!closest.timestamp)return {imageUrl,found:false};
        return {imageUrl,found:true,timestamp:closest.timestamp};
      }catch{clearTimeout(timer);return {imageUrl,found:false}}
    }

    const results=[];
    for(let i=0;i<thumbs.length;i+=6)results.push(...await Promise.all(thumbs.slice(i,i+6).map(checkOne)));
    const recovered=results.filter(x=>x.found).map((x,i)=>({
      index:i+1,imageUrl:x.imageUrl,timestamp:x.timestamp,
      proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.timestamp)+"&url="+encodeURIComponent(x.imageUrl)
    }));
    return res.status(200).json({ok:true,album:"BaBy217 / 相簿 2",total:thumbs.length,recoveredCount:recovered.length,photos:recovered});
  } catch { return res.status(500).json({ok:false,error:"照片牆建立失敗"}); }
}