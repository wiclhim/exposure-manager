const {normalize,addOtcBalance}=require('../margin-data');
const {load:loadFinancingDay}=require('../financing-maintenance');
const financingHistory=require('../data/financing-maintenance-20261118.json');
const otcHistory=require('../data/otc-margin-20261117.json');
let cached=null,pending=null;
const HISTORY_ROWS=110; // 90 visible sessions plus the 20-session moving average warm-up.
const OTC_TREND='https://www.tpex.org.tw/www/zh-tw/dashboardOtc/marginTrend?lang=zh-tw&days=240';
const OTC_OVERVIEW='https://info.tpex.org.tw/api/mktInfo';
async function loadOtcTrend() {
  const response=await fetch(OTC_TREND,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('櫃買中心暫無融資資料');
  const body=await response.json();
  if(body.stat!=='ok'||!Array.isArray(body.trend)) {
    throw new Error('櫃買中心暫無融資資料');
  }
  return body.trend.filter(row=>/^\d{8}$/.test(row?.date)&&Number.isFinite(row.marginBalance)&&row.marginBalance>=0);
}
async function loadOtcOverview(listed) {
  const response=await fetch(OTC_OVERVIEW,{signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw new Error('櫃買中心市場看板暫無資料');
  const body=await response.json();
  if(!Array.isArray(body.marginPurchaseValue))throw new Error('櫃買中心市場看板格式異常');
  // The board supplies 30 trading days using month/day. Match against the same recent trading dates across New Year.
  const recentDates=new Map(listed.slice(-45).map(({date})=>{
    const [,month,day]=date.split('-');
    return [Number(month)+'/'+Number(day),date.replaceAll('-','')];
  }));
  return body.marginPurchaseValue.flatMap(({date,count})=>{
    const day=recentDates.get(date);
    const amount=String(count).replaceAll(',','');
    return day&&/^\d+$/.test(amount)?[{date:day,marginBalance:Number(amount)/100000}]:[];
  });
}
async function loadOtcDaily(date) {
  const day=date.replace(/^(....)(..)(..)$/, '$1/$2/$3');
  const url=new URL('https://www.tpex.org.tw/www/zh-tw/margin/balance');
  url.search=new URLSearchParams({response:'json',date:day});
  const response=await fetch(url.toString(),{signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw new Error('櫃買中心日報暫無資料');
  const body=await response.json();
  if(body.stat!=='ok'||body.date!==date)return [];
  const total=body.tables.flatMap(table=>table.summary||[]).find(row=>row[1]==='融資金(仟元)');
  const amount=String(total?.[6]).replaceAll(',','');
  return /^\d+$/.test(amount)?[{date,marginBalance:Number(amount)/100000}]:[];
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
    const day=new Date(`${first.slice(0,4)}-${first.slice(4,6)}-${first.slice(6,8)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()-1);
    try{
      const older=await fetchTrend(name,day.toISOString().slice(0,10).replaceAll('-',''));
      const merged=new Map([...older.data.filter(r=>String(r.date)<first),...data].map(row=>[row.date,row]));
      data=[...merged.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date))).slice(-HISTORY_ROWS);
    }catch{historyIncomplete=true;}
  }
  return {body:{...latest,data},historyIncomplete};
}
async function loadFinancingMaintenance(listed){
  const stored=new Map(financingHistory.map(row=>[row.date,row]));
  const missing=listed.filter(row=>!stored.has(row.date)).slice(-3);
  const results=await Promise.allSettled(missing.map(row=>loadFinancingDay(row.date)));
  for(const result of results){
    if(result.status==='fulfilled')stored.set(result.value.date,result.value);
  }
  return {
    data:stored,
    error:results.some(result=>result.status==='rejected')?'部分融資維持率日線暫時無法取得':null
  };
}
module.exports=async function(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  try{
    if(!cached||Date.now()-cached.at>=cached.ttl*1000){
      if(!pending)pending=(async()=>{
        const [balanceResult,otcResult]=await Promise.allSettled([loadTrend('MI_MARGN_TREND'),loadOtcTrend()]);
        if(balanceResult.status!=='fulfilled')throw balanceResult.reason;
        const listed=normalize(balanceResult.value.body);
        const financingRequest=loadFinancingMaintenance(listed);
        const recentOtc=otcResult.status==='fulfilled'?otcResult.value:[];
        const lastListedDate=listed.at(-1).date.replaceAll('-','');
        let fallbackOtc=[];
        if(!recentOtc.some(row=>row.date===lastListedDate)){
          const alternatives=await Promise.allSettled([loadOtcOverview(listed),loadOtcDaily(lastListedDate)]);
          fallbackOtc=alternatives.flatMap(result=>result.status==='fulfilled'?result.value:[]);
        }
        const balance=addOtcBalance(listed,[...otcHistory,...recentOtc,...fallbackOtc]);
        const financing=await financingRequest;
        const data=balance.map(row=>({...row,financingRate:financing.data.get(row.date)?.financingRate??null,unpriced:financing.data.get(row.date)?.unpriced??null}));
        const latest=data.findLast(row=>Number.isFinite(row.financingRate))||null;
        const maintenance={name:'台灣－上市櫃融資維持率（自算）',scope:'上市＋上櫃融資股票，含 ETF',unit:'%',source:'證交所、櫃買中心公開日報計算',latest,error:financing.error};
        const otcError=![...recentOtc,...fallbackOtc].some(row=>row.date===lastListedDate);
        const payload={version:4,source:'臺灣證券交易所、證券櫃檯買賣中心',scope:'上市＋上櫃融資餘額',unit:'億元',fetchedAt:new Date().toISOString(),historyIncomplete:balanceResult.value.historyIncomplete,otcError,maintenance,data};
        const ttl=financing.error||!latest||latest.date!==listed.at(-1).date||otcError||balance.at(-1).balance==null||payload.historyIncomplete?300:3600;
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
