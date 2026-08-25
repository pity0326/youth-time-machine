module.exports = async function handler(req,res){
  const {username,type,year}=req.query;

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-3])$/.test(year||""))
    return res.status(400).json({error:"年份不正確"});

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

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  async function run(timeout){
    const c=new AbortController();
    const tm=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(q,{
        headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/1.3"},
        signal:c.signal
      });
      clearTimeout(tm);
      if(!r.ok) return {ok:false,status:r.status};
      const text=await r.text();
      try{return {ok:true,data:JSON.parse(text)}}catch{return {ok:false,status:"parse"}}
    }catch(e){
      clearTimeout(tm);
      return {ok:false,status:e?.name==="AbortError"?"timeout":"network"};
    }
  }

  let result=await run(7000);
  if(!result.ok && [429,500,502,503,504,"timeout","network","parse"].includes(result.status)){
    await sleep(350);
    result=await run(7000);
  }

  if(!result.ok){
    return res.status(503).json({
      error:"Internet Archive 暫時忙碌",
      temporary:true,
      status:result.status,
      calendarUrl
    });
  }

  const data=result.data;
  if(!Array.isArray(data)||data.length<=1){
    return res.status(200).json({found:false,year,days:[],months:{},calendarUrl});
  }

  const seen=new Set(),days=[];
  for(let i=1;i<data.length;i++){
    const ts=data[i]&&data[i][0];
    if(!ts||ts.length<8) continue;
    const date=ts.slice(0,8);
    if(seen.has(date)) continue;
    seen.add(date);
    days.push({
      date,
      month:date.slice(4,6),
      day:date.slice(6,8),
      timestamp:ts,
      url:`https://web.archive.org/web/${ts}/${oldUrl}`
    });
  }

  const months={};
  for(const x of days){
    if(!months[x.month]) months[x.month]=[];
    months[x.month].push(x);
  }

  res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=21600");
  return res.status(200).json({found:days.length>0,year,days,months,calendarUrl});
};