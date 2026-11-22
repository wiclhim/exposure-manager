const {normalize,addOtcBalance}=require('../margin-data');
const {load:loadFinancingHistory}=require('../financing-maintenance');
const financingHistory=require('../data/financing-maintenance-20261118.json');
const otcHistory=require('../data/otc-margin-year-20261120.json');
let cached=null,pending=null;
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
  const last=data.map(row=>String(row.date)).sort().at(-1);
  if(!/^\d{8}$/.test(last))throw Error('Invalid trend date');
  const cutoff=new Date(`${last.slice(0,4)}-${last.slice(4,6)}-${last.slice(6,8)}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate()-364);
  const from=cutoff.toISOString().slice(0,10),rawFrom=from.replaceAll('-','');
  // TWSE caps each response at 60. Continue until the full calendar year is covered.
  while(data.map(row=>String(row.date)).sort()[0]>rawFrom){
    const first=data.map(row=>String(row.date)).sort()[0];
    if(!/^\d{8}$/.test(first))throw Error('Invalid trend date');
    const day=new Date(`${first.slice(0,4)}-${first.slice(4,6)}-${first.slice(6,8)}T00:00:00Z`);day.setUTCDate(day.getUTCDate()-1);
    try{
      const older=await fetchTrend(name,day.toISOString().slice(0,10).replaceAll('-',''));
      if(!older.data.some(row=>String(row.date)<first))throw Error('History did not advance');
      const merged=new Map([...older.data.filter(r=>String(r.date)<first),...data].map(row=>[row.date,row]));
      data=[...merged.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    }catch{historyIncomplete=true;break;}
  }
  const sorted=data.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const firstInYear=sorted.findIndex(row=>String(row.date)>=rawFrom);
  data=sorted.slice(Math.max(0,firstInYear-1));
  const yearSessions=data.filter(row=>String(row.date)>=rawFrom).length;
  return {body:{...latest,data},historyIncomplete,from,yearSessions};
}
async function loadFinancingMaintenance(){
  const stored=new Map(financingHistory.map(row=>[row.date,row]));
  try {
    const rows=await loadFinancingHistory();
    for(const row of rows)stored.set(row.date,row);
    return {data:stored,error:null};
  } catch {
    return {data:stored,error:'FinLab 暫時無法更新，顯示已儲存的融資維持率'};
  }
}
module.exports=async function(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  try{
    if(!cached||Date.now()-cached.at>=cached.ttl*1000){
      if(!pending)pending=(async()=>{
        const [balanceResult,otcResult,financingResult]=await Promise.allSettled([loadTrend('MI_MARGN_TREND'),loadOtcTrend(),loadFinancingMaintenance()]);
        if(balanceResult.status!=='fulfilled')throw balanceResult.reason;
        const listed=normalize(balanceResult.value.body);
        const recentOtc=otcResult.status==='fulfilled'?otcResult.value:[];
        const lastListedDate=listed.at(-1).date.replaceAll('-','');
        let fallbackOtc=[];
        if(!recentOtc.some(row=>row.date===lastListedDate)){
          const alternatives=await Promise.allSettled([loadOtcOverview(listed),loadOtcDaily(lastListedDate)]);
          fallbackOtc=alternatives.flatMap(result=>result.status==='fulfilled'?result.value:[]);
        }
        const balance=addOtcBalance(listed,[...otcHistory,...recentOtc,...fallbackOtc]);
        if(financingResult.status!=='fulfilled')throw financingResult.reason;
        const financing=financingResult.value;
        const data=balance.map(row=>({...row,financingRate:financing.data.get(row.date)?.financingRate??null,financingSource:'FinLab'}));
        if(!balanceResult.value.historyIncomplete){
          Object.assign(data.at(-1),{yearStart:balanceResult.value.from,yearSessions:balanceResult.value.yearSessions});
        }
        const latest=data.findLast(row=>Number.isFinite(row.financingRate))||null;
        const maintenance={name:'台灣－上市櫃融資維持率（FinLab 估算）',scope:'上市＋上櫃融資股票',unit:'%',source:'FinLab',url:'https://finlab.finance/tools/margin-maintenance-ratio',latest,error:financing.error};
        const otcError=![...recentOtc,...fallbackOtc].some(row=>row.date===lastListedDate);
        const payload={version:6,source:'臺灣證券交易所、證券櫃檯買賣中心',scope:'上市＋上櫃融資餘額',unit:'億元',fetchedAt:new Date().toISOString(),historyIncomplete:balanceResult.value.historyIncomplete,otcError,maintenance,data};
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
