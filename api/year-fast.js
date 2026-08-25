module.exports = async function handler(req,res){
  const {username,type,year}=req.query;

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username)){
    return res.status(400).json({error:"帳號格式不正確"});
  }
  if(!["album","blog","guestbook"].includes(type)){
    return res.status(400).json({error:"類型不正確"});
  }
  if(!/^(200[0-9]|201[0-3])$/.test(year||"")){
    return res.status(400).json({error:"年份不正確"});
  }

  const oldUrl=`http://www.wretch.cc/${type}/${username}`;
  const calendarUrl=`https://web.archive.org/web/*/${oldUrl}`;

  const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(oldUrl)+
    "&from="+year+"0101"+
    "&to="+year+"1231"+
    "&output=json"+
    "&fl=timestamp"+
    "&filter=statuscode:200"+
    "&collapse=timestamp:8"+
    "&limit=400"+
    "&gzip=false";

  function build(timestamps,extra={}){
    const seen=new Set(),days=[];
    for(const raw of timestamps||[]){
      const ts=String(raw||"");
      if(ts.length<8)continue;
      const date=ts.slice(0,8);
      if(date.slice(0,4)!==String(year)||seen.has(date))continue;
      seen.add(date);
      days.push({
        date,
        month:date.slice(4,6),
        day:date.slice(6,8),
        timestamp:ts,
        url:`https://web.archive.org/web/${ts}/${oldUrl}`
      });
    }
    days.sort((a,b)=>a.date.localeCompare(b.date));
    const months={};
    for(const x of days){
      if(!months[x.month])months[x.month]=[];
      months[x.month].push(x);
    }
    return {found:days.length>0,year,days,months,calendarUrl,...extra};
  }

  async function timedFetch(url,timeout){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const r=await fetch(url,{
        headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/1.5"},
        signal:controller.signal
      });
      clearTimeout(timer);
      return r;
    }catch(e){
      clearTimeout(timer);
      throw e;
    }
  }

  async function availability(){
    // 查一年中的 4 個位置。只要任何一個落在該年，就不要誤判為不存在。
    const points=[`${year}0215`,`${year}0515`,`${year}0815`,`${year}1115`];
    const hits=(await Promise.all(points.map(async stamp=>{
      try{
        const url="https://archive.org/wayback/available?url="+encodeURIComponent(oldUrl)+"&timestamp="+stamp;
        const r=await timedFetch(url,5000);
        if(!r.ok)return null;
        const d=await r.json();
        const c=d?.archived_snapshots?.closest;
        return c?.available&&c.timestamp&&String(c.timestamp).startsWith(year)?String(c.timestamp):null;
      }catch{return null}
    }))).filter(Boolean);
    return [...new Set(hits)];
  }

  try{
    let data=null;
    try{
      const r=await timedFetch(q,12000);
      if(r.ok){
        const text=await r.text();
        try{data=JSON.parse(text)}catch{}
      }
    }catch{}

    if(Array.isArray(data)&&data.length>1){
      const result=build(data.slice(1).map(row=>row&&row[0]).filter(Boolean));
      res.setHeader("Cache-Control","s-maxage=1800, stale-while-revalidate=7200");
      return res.status(200).json(result);
    }

    // CDX 若很快回空資料，不立刻說沒有；再做一次較輕量確認。
    const hits=await availability();
    if(hits.length){
      return res.status(200).json(build(hits,{
        partial:true,
        notice:"先找到部分保存紀錄，Internet Archive 稍後可能能列出更多日期。"
      }));
    }

    return res.status(200).json(build([]));

  }catch(e){
    return res.status(502).json({
      error:"Internet Archive 目前回應較慢",
      calendarUrl
    });
  }
};