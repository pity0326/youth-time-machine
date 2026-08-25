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
async function cacheGet(cfg,key){
  if(!cfg)return null;
  try{
    const d=await redisCall(cfg,`/get/${encodeURIComponent(key)}`);
    return d?.result?JSON.parse(d.result):null;
  }catch{return null}
}
async function cacheSet(cfg,key,value,ttl){
  if(!cfg)return;
  try{
    const raw=JSON.stringify(value);
    await redisCall(cfg,`/set/${encodeURIComponent(key)}/${encodeURIComponent(raw)}`);
    if(ttl)await redisCall(cfg,`/expire/${encodeURIComponent(key)}/${ttl}`);
  }catch{}
}

module.exports=async function handler(req,res){
  const adminKey=process.env.YTM_ADMIN_KEY;
  const supplied=req.headers["x-admin-key"];

  if(!adminKey){
    return res.status(503).json({error:"尚未設定 YTM_ADMIN_KEY"});
  }
  if(!supplied||supplied!==adminKey){
    return res.status(401).json({error:"管理員密碼不正確"});
  }
  if(req.method!=="POST"){
    res.setHeader("Allow","POST");
    return res.status(405).json({error:"Method not allowed"});
  }

  const {username,type,year,calendarUrl}=req.body||{};
  if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username))
    return res.status(400).json({error:"帳號格式不正確"});
  if(!["album","blog","guestbook"].includes(type))
    return res.status(400).json({error:"類型不正確"});
  if(!/^(200[0-9]|201[0-4])$/.test(String(year||"")))
    return res.status(400).json({error:"年份不正確"});

  const cfg=redisConfig();
  if(!cfg)return res.status(503).json({error:"Upstash 尚未設定"});

  const key=`ytm:manualyear:v1:${String(username).toLowerCase()}:${type}:${year}`;
  const fallback=`https://web.archive.org/web/${year}0000000000*/wretch.cc/${type}/${String(username).toLowerCase()}`;
  const value={
    verified:true,
    username:String(username),
    type:String(type),
    year:String(year),
    calendarUrl:String(calendarUrl||fallback),
    savedAt:Date.now()
  };

  await cacheSet(cfg,key,value,31536000); // 1 year
  return res.status(200).json({ok:true,key,value});
};