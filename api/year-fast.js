module.exports = async function handler(req,res){
  const {username,type,year}=req.query;
  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username)) return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type)) return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-3])$/.test(year||"")) return res.status(400).json({error:"年份不正確"});

  const oldUrl=`http://www.wretch.cc/${type}/${username}`;
  const calendarUrl=`https://web.archive.org/web/*/${oldUrl}`;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  res.setHeader("Cache-Control","s-maxage=21600, stale-while-revalidate=86400");

  function makeResult(timestamps,extra={}){
    const seen=new Set(),days=[];
    for(const raw of timestamps||[]){
      const ts=String(raw||""); if(ts.length<8) continue;
      const date=ts.slice(0,8); if(date.slice(0,4)!==String(year)||seen.has(date)) continue;
      seen.add(date);
      days.push({date,month:date.slice(4,6),day:date.slice(6,8),timestamp:ts,url:`https://web.archive.org/web/${ts}/${oldUrl}`});
    }
    days.sort((a,b)=>a.date.localeCompare(b.date));
    const months={}; for(const x of days){ if(!months[x.month]) months[x.month]=[]; months[x.month].push(x); }
    return {found:days.length>0,year,days,months,calendarUrl,...extra};
  }

  async function timedFetch(url,timeout){
    const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
    try{ const r=await fetch(url,{headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/1.2"},signal:c.signal}); clearTimeout(t); return r; }
    catch(e){ clearTimeout(t); throw e; }
  }

  async function cdx(){
    const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(oldUrl)+
      "&from="+year+"0101&to="+year+"1231&output=json&fl=timestamp&filter=statuscode:200&collapse=timestamp:8&limit=400&gzip=false";
    for(let n=1;n<=2;n++){
      try{
        const r=await timedFetch(q,n===1?6500:7500);
        if([429,500,502,503,504].includes(r.status)){ if(n===1){await sleep(450);continue;} return null; }
        if(!r.ok) return null;
        const text=await r.text(); let data;
        try{ data=JSON.parse(text); }catch{ if(n===1){await sleep(350);continue;} return null; }
        if(!Array.isArray(data)||data.length<=1) return makeResult([],{source:"cdx"});
        return makeResult(data.slice(1).map(x=>x&&x[0]).filter(Boolean),{source:"cdx"});
      }catch{ if(n===1){await sleep(450);continue;} return null; }
    }
    return null;
  }

  async function fallback(){
    const stamps=[`${year}0215`,`${year}0515`,`${year}0815`,`${year}1115`];
    const hits=(await Promise.all(stamps.map(async stamp=>{
      try{
        const u="https://archive.org/wayback/available?url="+encodeURIComponent(oldUrl)+"&timestamp="+stamp;
        const r=await timedFetch(u,5000); if(!r.ok) return null;
        const d=await r.json(),c=d?.archived_snapshots?.closest;
        return c?.available&&c.timestamp?String(c.timestamp):null;
      }catch{return null}
    }))).filter(Boolean);
    if(!hits.length) return null;
    return makeResult(hits,{source:"availability",partial:true,notice:"Internet Archive 目前較忙，先顯示快速找到的保存紀錄。"});
  }

  try{
    const a=await cdx(); if(a) return res.status(200).json(a);
    const b=await fallback(); if(b) return res.status(200).json(b);
    return res.status(200).json({found:false,temporary:true,year,days:[],months:{},calendarUrl,notice:"Internet Archive 目前連線較擁擠，請稍後再試。"});
  }catch{
    return res.status(200).json({found:false,temporary:true,year,days:[],months:{},calendarUrl,notice:"Internet Archive 目前連線較擁擠，請稍後再試。"});
  }
};