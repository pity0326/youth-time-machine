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

  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  async function fetchCDX(attempt){
    const controller=new AbortController();
    // 第一次不要等太久；重試時再多給一點時間
    const timeout=attempt===1 ? 8500 : 11000;
    const timer=setTimeout(()=>controller.abort(),timeout);

    try{
      const r=await fetch(q,{
        headers:{
          "Accept":"application/json",
          "User-Agent":"YouthTimeMachine/1.1"
        },
        signal:controller.signal
      });
      clearTimeout(timer);

      // 這幾種通常是 Archive 暫時忙，值得重試
      if([429,500,502,503,504].includes(r.status)){
        return {retry:true,status:r.status};
      }

      if(!r.ok){
        return {ok:false,status:r.status};
      }

      const text=await r.text();
      try{
        return {ok:true,data:JSON.parse(text)};
      }catch{
        return {retry:true,status:"parse"};
      }
    }catch(e){
      clearTimeout(timer);
      if(e?.name==="AbortError"){
        return {retry:true,status:"timeout"};
      }
      return {retry:true,status:"network"};
    }
  }

  try{
    let result=await fetchCDX(1);

    if(result.retry){
      // 短暫停一下再試一次，避免第一次 503/timeout 就直接判定卡住
      await sleep(650);
      result=await fetchCDX(2);
    }

    if(!result.ok){
      return res.status(502).json({
        error:"Internet Archive 暫時無法完成查詢",
        status:result.status,
        temporary:true,
        calendarUrl
      });
    }

    const data=result.data;

    if(!Array.isArray(data)||data.length<=1){
      return res.status(200).json({
        found:false,
        year,
        days:[],
        months:{},
        calendarUrl
      });
    }

    const seen=new Set();
    const days=[];

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

    // 讓 Vercel/CDN 暫存成功結果 10 分鐘，減少同一查詢一直打 Archive
    res.setHeader("Cache-Control","s-maxage=600, stale-while-revalidate=3600");

    return res.status(200).json({
      found:days.length>0,
      year,
      days,
      months,
      calendarUrl
    });

  }catch(e){
    return res.status(502).json({
      error:"Internet Archive 暫時無法完成查詢",
      temporary:true,
      calendarUrl
    });
  }
};