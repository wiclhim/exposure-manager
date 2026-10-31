const {reserveFugleCalls,rateLimitResponse}=require('../lib/fugle-rate-limit');
const {calculate}=require('../risk-engine');
module.exports=async function(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  if(!process.env.FUGLE_API_KEY)return res.status(503).json({error:'Fugle API 尚未設定'});
  const reservation=await reserveFugleCalls(res,1);if(!reservation.allowed)return rateLimitResponse(res,reservation);
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const value=type=>parts.find(p=>p.type===type).value;
    const today=`${value('year')}-${value('month')}-${value('day')}`;
    const end=new Date(`${today}T00:00:00Z`);if(Number(value('hour'))<17)end.setUTCDate(end.getUTCDate()-1);
    const start=new Date(end);start.setUTCDate(start.getUTCDate()-364);
    const to=end.toISOString().slice(0,10),from=start.toISOString().slice(0,10);
    const params=new URLSearchParams({from,to,timeframe:'D',fields:'high,low,close',sort:'asc'});
    const response=await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/IX0001?${params}`,{headers:{'X-API-KEY':process.env.FUGLE_API_KEY},signal:AbortSignal.timeout(10000)});
    const body=await response.json();if(!response.ok)return res.status(response.status).json({error:body.message||'加權指數資料讀取失敗'});
    const data=calculate((body.data||[]).filter(row=>row.date<=to));
    res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=3600');
    res.status(200).json({symbol:'IX0001',name:'臺灣加權指數',source:'Fugle 日K',fetchedAt:new Date().toISOString(),data});
  }catch(error){res.status(502).json({error:error.message||'指標計算失敗'});}
};
