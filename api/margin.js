const {normalize,normalizeMaintenance,combine,addOtcBalance}=require('../margin-data');
let cached=null,pending=null;
const HISTORY_ROWS=110; // 90 visible sessions plus the 20-session moving average warm-up.
const OTC_TREND='https://www.tpex.org.tw/www/zh-tw/dashboardOtc/marginTrend?lang=zh-tw&days=240';
async function loadOtcTrend() {
  const response=await fetch(OTC_TREND,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('櫃買中心暫無融資資料');
  const body=await response.json();
  if(body.stat!=='ok'||!Array.isArray(body.trend)||!body.trend.some(row=>Number.isFinite(row?.marginBalance))) {
    throw new Error('櫃買中心暫無融資資料');
  }
  return body.trend;
}
async function fetchTrend(name,date){
  const params=new URLSearchParams({response:'json',days:'60'});if(date)params.set('date',date);
  const response=await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/${name}?${params}`,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('證交所服務暫時無法連線');
  const body=await response.json();
  if(body.stat!=='OK'||!Array.isArray(body.data))throw new Error('證交所暫無完整資料');
  return body;
}
async function loadTrend(name){
  const latest=await fetchTrend(name);
  let data=latest.data,historyIncomplete=false;
  // TWSE caps each response at 60; anchor the next page before the earliest date.
  if(data.length>=60){
    const first=data.map(row=>String(row.date)).sort()[0];
    if(!/^\d{8}$/.test(first))throw Error('Invalid trend date');
    if(name==='BFIJ3U_TREND'&&first<='20260803')return {body:latest,historyIncomplete:false};
    const day=new Date(`${first.slice(0,4)}-${first.slice(4,6)}-${first.slice(6,8)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()-1);
    try{
      const older=await fetchTrend(name,day.toISOString().slice(0,10).replaceAll('-',''));
      const merged=new Map([...older.data.filter(r=>String(r.date)<first),...data].map(row=>[row.date,row]));
      data=[...merged.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date))).slice(-HISTORY_ROWS);
    }catch{historyIncomplete=true;}
  }
  return {body:{...latest,data},historyIncomplete};
}
module.exports=async function(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  try{
    if(!cached||Date.now()-cached.at>=cached.ttl*1000){
      if(!pending)pending=(async()=>{
        const [balanceResult,maintenanceResult,otcResult]=await Promise.allSettled([loadTrend('MI_MARGN_TREND'),loadTrend('BFIJ3U_TREND'),loadOtcTrend()]);
        if(balanceResult.status!=='fulfilled')throw balanceResult.reason;
        const listed=normalize(balanceResult.value.body);
        const balance=addOtcBalance(listed,otcResult.status==='fulfilled'?otcResult.value:[]);
        let rates=[],maintenanceError=null;
        try{if(maintenanceResult.status!=='fulfilled')throw maintenanceResult.reason;rates=normalizeMaintenance(maintenanceResult.value.body);}catch{maintenanceError='維持率暫時無法取得';}
        const maintenance={name:'全市場整戶擔保維持率',scope:'上市＋上櫃，融資＋融券合併',unit:'%',availableFrom:'2026-08-03',latest:rates.filter(r=>Number.isFinite(r.keepRate)).at(-1)||null,error:maintenanceError,historyIncomplete:maintenanceResult.status==='fulfilled'&&maintenanceResult.value.historyIncomplete};
        const otcError=otcResult.status!=='fulfilled';
        const payload={version:3,source:'臺灣證券交易所、證券櫃檯買賣中心',scope:'上市＋上櫃融資餘額',unit:'億元',fetchedAt:new Date().toISOString(),historyIncomplete:balanceResult.value.historyIncomplete,otcError,maintenance,data:combine(balance,rates)};
        const ttl=maintenanceError||otcError||balance.at(-1).balance==null||payload.historyIncomplete||maintenance.historyIncomplete?300:3600;
        cached={at:Date.now(),payload,ttl};
      })().finally(()=>{pending=null;});
      await pending;
    }
    res.setHeader('Cache-Control',`s-maxage=${cached.ttl}, stale-while-revalidate=3600`);
    return res.status(200).json(cached.payload);
  }catch{
    res.setHeader('Cache-Control','no-store');
    return res.status(502).json({error:'融資資料暫時無法取得，請稍後重試。'});
  }
};
