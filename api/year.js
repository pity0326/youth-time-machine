module.exports = async function handler(req,res){
 const {username,type,year}=req.query;
 if(!username||!/^[A-Za-z0-9._-]{1,80}$/.test(username)) return res.status(400).json({error:"帳號格式不正確"});
 if(!["album","blog","guestbook"].includes(type)) return res.status(400).json({error:"類型不正確"});
 if(!/^(200[0-9]|201[0-3])$/.test(year||"")) return res.status(400).json({error:"年份不正確"});
 const oldUrl=`http://www.wretch.cc/${type}/${username}`;
 const calendarUrl=`https://web.archive.org/web/*/${oldUrl}`;
 const q="https://web.archive.org/cdx/search/cdx?url="+encodeURIComponent(oldUrl)+
   "&from="+year+"0101&to="+year+"1231&output=json&fl=timestamp&filter=statuscode:200&collapse=timestamp:8&limit=500&gzip=false";
 try{
   const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),9000);
   const r=await fetch(q,{headers:{"Accept":"application/json","User-Agent":"YouthTimeMachine/1.0"},signal:controller.signal});
   clearTimeout(timer);
   if(!r.ok) return res.status(502).json({error:"Internet Archive 回應失敗",status:r.status,calendarUrl});
   const text=await r.text(); let data;
   try{data=JSON.parse(text)}catch{ return res.status(502).json({error:"Archive 沒有回傳可解析資料",calendarUrl}); }
   if(!Array.isArray(data)||data.length<=1) return res.status(200).json({found:false,days:[],months:{},calendarUrl});
   const seen=new Set(),days=[];
   for(let i=1;i<data.length;i++){
     const ts=data[i]&&data[i][0]; if(!ts||ts.length<8) continue;
     const key=ts.slice(0,8); if(seen.has(key)) continue; seen.add(key);
     days.push({date:key,month:key.slice(4,6),day:key.slice(6,8),timestamp:ts,url:`https://web.archive.org/web/${ts}/${oldUrl}`});
   }
   const months={}; for(const x of days){(months[x.month]??=[]).push(x)}
   return res.status(200).json({found:days.length>0,year,days,months,calendarUrl});
 }catch(e){
   return res.status(502).json({error:e?.name==="AbortError"?"查詢超過 9 秒，自動停止":"查詢發生錯誤",calendarUrl});
 }
};