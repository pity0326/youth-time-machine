export default async function handler(req,res){
try{
const username=String(req.query.username||"").trim(),year=String(req.query.year||"2013").trim();
if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({ok:false,error:"帳號格式不正確"});
if(!/^\d{4}$/.test(year))return res.status(400).json({ok:false,error:"年份格式不正確"});
const albumUrl=`http://www.wretch.cc/album/${encodeURIComponent(username)}`;
const available=`https://archive.org/wayback/available?url=${encodeURIComponent(albumUrl)}&timestamp=${year}1231`;
const c=new AbortController(),tm=setTimeout(()=>c.abort(),8000);
const ar=await fetch(available,{headers:{"User-Agent":"Mozilla/5.0"},signal:c.signal});clearTimeout(tm);
if(!ar.ok)return res.status(502).json({ok:false,error:"Internet Archive 暫時無法查詢"});
const ad=await ar.json(),closest=ad?.archived_snapshots?.closest;
if(!closest?.available||!closest.timestamp||!closest.url)return res.status(200).json({ok:true,recoveredCount:0,total:0,photos:[]});
let original=closest.url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:id_)?\//,"");
if(!/^https?:\/\//i.test(original))original=albumUrl;
const snapshot=`https://web.archive.org/web/${closest.timestamp}id_/${original}`;
const pc=new AbortController(),pt=setTimeout(()=>pc.abort(),10000);
const page=await fetch(snapshot,{headers:{"User-Agent":"Mozilla/5.0"},redirect:"follow",signal:pc.signal});clearTimeout(pt);
if(!page.ok)return res.status(200).json({ok:true,recoveredCount:0,total:0,photos:[]});
const albumHtml=await page.text();
let thumbs=[...albumHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]).filter(u=>/wretch\.yimg\.com/i.test(u)&&/\/thumbs\//i.test(u)&&/\.(jpg|jpeg|png|gif)(?:\?|$)/i.test(u)).map(u=>u.startsWith("//")?"http:"+u:u);
thumbs=[...new Set(thumbs)].slice(0,30);
async function checkOne(imageUrl){const cc=new AbortController(),tt=setTimeout(()=>cc.abort(),6000);try{const q=`https://archive.org/wayback/available?url=${encodeURIComponent(imageUrl)}&timestamp=${closest.timestamp.slice(0,8)}`;const r=await fetch(q,{headers:{"User-Agent":"Mozilla/5.0"},signal:cc.signal});clearTimeout(tt);if(!r.ok)return null;const d=await r.json(),hit=d?.archived_snapshots?.closest;if(!hit?.available||!hit.timestamp)return null;return{imageUrl,timestamp:hit.timestamp}}catch{clearTimeout(tt);return null}}
const found=[];for(let i=0;i<thumbs.length;i+=6)found.push(...(await Promise.all(thumbs.slice(i,i+6).map(checkOne))).filter(Boolean));
const photos=found.map((x,i)=>({index:i+1,timestamp:x.timestamp,proxyUrl:"/api/photo-image?ts="+encodeURIComponent(x.timestamp)+"&url="+encodeURIComponent(x.imageUrl)}));
return res.status(200).json({ok:true,username,year,total:thumbs.length,recoveredCount:photos.length,photos});
}catch(e){return res.status(502).json({ok:false,error:e?.name==="AbortError"?"Internet Archive 回應較慢，請稍後再試":"照片搜尋失敗"})}
}