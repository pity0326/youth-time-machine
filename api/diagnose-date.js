function cleanAccount(v){
  return String(v||"").trim().split("?")[0].split("#")[0].replace(/\/+$/,"");
}
async function probe(url,timeout=6500){
  const c=new AbortController();
  const tm=setTimeout(()=>c.abort(),timeout);
  const started=Date.now();
  try{
    const r=await fetch(url,{
      headers:{"Accept":"application/json,text/plain,*/*","User-Agent":"YouthTimeMachine/v31-date-diagnose"},
      signal:c.signal,cache:"no-store"
    });
    const text=await r.text();
    clearTimeout(tm);
    let json=null;
    try{json=JSON.parse(text)}catch{}
    return {ok:r.ok,status:r.status,ms:Date.now()-started,bytes:text.length,json,preview:text.slice(0,700)};
  }catch(e){
    clearTimeout(tm);
    return {ok:false,error:e?.name||String(e),ms:Date.now()-started};
  }
}
function closestInfo(d){
  const h=d?.json?.archived_snapshots?.closest;
  if(!h)return {available:false};
  return {
    available:!!h.available,
    timestamp:String(h.timestamp||""),
    url:String(h.url||""),
    sameDate:String(h.timestamp||"").slice(0,8)===String(d.requestedDate||"")
  };
}

module.exports=async function handler(req,res){
  const username=cleanAccount(req.query.username||"baby217");
  const type=String(req.query.type||"album");
  const date=String(req.query.date||"20110315").replace(/\D/g,"");

  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^\d{8}$/.test(date))
    return res.status(400).json({error:"日期請用 YYYYMMDD"});

  // Include exact case/port clue discovered in V29 plus generic variants.
  const names=[username,username.toLowerCase()];
  if(username.toLowerCase()==="baby217")names.push("BaBy217");

  const hosts=[
    "wretch.cc",
    "www.wretch.cc",
    "wretch.cc:80",
    "www.wretch.cc:80"
  ];

  const targets=[];
  for(const host of hosts){
    for(const name of names){
      targets.push(`http://${host}/${type}/${name}`);
    }
  }

  const unique=[...new Set(targets)];
  const results=[];

  for(let i=0;i<unique.length;i+=6){
    const batch=unique.slice(i,i+6);
    const group=await Promise.all(batch.map(async target=>{
      const url="https://archive.org/wayback/available?url="+encodeURIComponent(target)+"&timestamp="+date;
      const d=await probe(url);
      d.requestedDate=date;
      return {target,...d,closest:closestInfo(d)};
    }));
    results.push(...group);
  }

  const exact=results.filter(x=>x.closest?.sameDate);
  const sameYear=results.filter(x=>x.closest?.timestamp?.slice(0,4)===date.slice(0,4));

  return res.status(200).json({
    username,type,date,
    summary:{
      tested:results.length,
      http200:results.filter(x=>x.status===200).length,
      exactDateMatches:exact.length,
      sameYearMatches:sameYear.length
    },
    exactMatches:exact.map(x=>({target:x.target,...x.closest})),
    sameYearMatches:sameYear.map(x=>({target:x.target,...x.closest})),
    results
  });
};