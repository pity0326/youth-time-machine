function redisConfig(){
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  if(!redisUrl||!redisToken)return null;
  return {baseUrl:redisUrl.replace(/\/$/,""),token:redisToken};
}
async function redisCall(cfg,path){
  const r=await fetch(cfg.baseUrl+path,{
    headers:{Authorization:`Bearer ${cfg.token}`},
    cache:"no-store"
  });
  if(!r.ok)throw new Error(`Redis HTTP ${r.status}`);
  return r.json();
}
async function getJson(cfg,key){
  try{
    const d=await redisCall(cfg,`/get/${encodeURIComponent(key)}`);
    return d?.result?JSON.parse(d.result):null;
  }catch{return null}
}
async function setJson(cfg,key,value,ttl){
  try{
    const raw=JSON.stringify(value);
    await redisCall(cfg,`/set/${encodeURIComponent(key)}/${encodeURIComponent(raw)}`);
    await redisCall(cfg,`/expire/${encodeURIComponent(key)}/${ttl}`);
    return true;
  }catch{return false}
}

module.exports=async function handler(req,res){
  const cfg=redisConfig();
  if(!cfg)return res.status(503).json({error:"Upstash 尚未設定"});

  if(req.method==="GET"){
    const {username,type,year}=req.query;
    if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({error:"帳號格式不正確"});
    if(!["album","blog","guestbook"].includes(type))return res.status(400).json({error:"類型不正確"});
    if(!/^(200[3-9]|201[0-4])$/.test(String(year||"")))return res.status(400).json({error:"年份不正確"});

    const key=`ytm:yearcloud:v1:${String(username).toLowerCase()}:${type}:${year}`;
    const data=await getJson(cfg,key);

    if(!data?.found||!Array.isArray(data.days)||!data.days.length){
      return res.status(200).json({found:false,days:[],months:{}});
    }
    return res.status(200).json({...data,serverCache:true});
  }

  if(req.method==="POST"){
    const {username,type,year,data}=req.body||{};
    if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))return res.status(400).json({error:"帳號格式不正確"});
    if(!["album","blog","guestbook"].includes(type))return res.status(400).json({error:"類型不正確"});
    if(!/^(200[3-9]|201[0-4])$/.test(String(year||"")))return res.status(400).json({error:"年份不正確"});
    if(!data?.found||!Array.isArray(data.days)||!data.days.length){
      return res.status(400).json({error:"沒有成功紀錄可寫入"});
    }

    const key=`ytm:yearcloud:v1:${String(username).toLowerCase()}:${type}:${year}`;
    const old=await getJson(cfg,key);

    const map=new Map();
    for(const x of old?.days||[])if(x?.date)map.set(x.date,x);
    for(const x of data.days||[])if(x?.date)map.set(x.date,x);

    const days=[...map.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    const months={};
    for(const x of days){
      if(!months[x.month])months[x.month]=[];
      months[x.month].push(x);
    }

    const merged={
      found:true,
      year:String(year),
      days,
      months,
      calendarUrl:data.calendarUrl||old?.calendarUrl||"",
      updatedAt:Date.now()
    };

    const ok=await setJson(cfg,key,merged,7776000);
    return res.status(ok?200:503).json(ok?{ok:true,count:days.length}:{error:"Redis 寫入失敗"});
  }

  res.setHeader("Allow","GET, POST");
  return res.status(405).json({error:"Method not allowed"});
};