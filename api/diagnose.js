function cleanAccount(input){
  return String(input||"").trim().split("?")[0].split("#")[0].replace(/\/+$/,"");
}

module.exports=async function handler(req,res){
  const username=cleanAccount(req.query.username);
  const type=String(req.query.type||"album");
  const year=String(req.query.year||"2011");

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[3-9]|201[0-4])$/.test(year))
    return res.status(400).json({error:"年份不正確"});

  async function probe(name,url,timeout=9000){
    const c=new AbortController();
    const tm=setTimeout(()=>c.abort(),timeout);
    const started=Date.now();
    try{
      const r=await fetch(url,{
        headers:{
          "Accept":"application/json,text/plain,*/*",
          "User-Agent":"YouthTimeMachine/diagnose-29"
        },
        signal:c.signal,
        cache:"no-store"
      });
      const text=await r.text();
      clearTimeout(tm);
      return {
        name,
        ok:r.ok,
        status:r.status,
        ms:Date.now()-started,
        contentType:r.headers.get("content-type")||"",
        bytes:text.length,
        preview:text.slice(0,500)
      };
    }catch(e){
      clearTimeout(tm);
      return {
        name,
        ok:false,
        error:e?.name||String(e),
        ms:Date.now()-started
      };
    }
  }

  const account=username.toLowerCase();
  const targets=[
    `wretch.cc/${type}/${account}`,
    `www.wretch.cc/${type}/${account}`,
    `http://wretch.cc/${type}/${account}`,
    `http://www.wretch.cc/${type}/${account}`
  ];

  const jobs=[];

  for(const target of targets){
    jobs.push(probe(
      `Calendar: ${target}`,
      "https://web.archive.org/__wb/calendarcaptures/2?url="+
      encodeURIComponent(target)+"&date="+year+"&groupby=day"
    ));

    jobs.push(probe(
      `CDX: ${target}`,
      "https://web.archive.org/cdx/search/cdx?url="+
      encodeURIComponent(target)+
      "&from="+year+"0101&to="+year+"1231"+
      "&output=json&fl=timestamp,original,statuscode&collapse=timestamp:8&limit=20&gzip=false"
    ));

    jobs.push(probe(
      `Availability: ${target}`,
      "https://archive.org/wayback/available?url="+
      encodeURIComponent(target)+"&timestamp="+year+"0615",
      6000
    ));
  }

  const results=await Promise.all(jobs);

  const summary={
    total:results.length,
    ok:results.filter(x=>x.ok).length,
    calendarOk:results.filter(x=>x.name.startsWith("Calendar")&&x.ok).length,
    cdxOk:results.filter(x=>x.name.startsWith("CDX")&&x.ok).length,
    availabilityOk:results.filter(x=>x.name.startsWith("Availability")&&x.ok).length,
    statuses:[...new Set(results.map(x=>x.status).filter(Boolean))]
  };

  return res.status(200).json({
    username,
    type,
    year,
    summary,
    results
  });
};