const {reserveFugleCalls,rateLimitResponse}=require('../lib/fugle-rate-limit');
const {study}=require('../strategy-study-engine');
module.exports=async(req,res)=>{
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  if(!process.env.FUGLE_API_KEY)return res.status(503).json({error:'Fugle API 尚未設定'});
  const guard=await reserveFugleCalls(res,15);if(!guard.allowed)return rateLimitResponse(res,guard);
  try{
    const dateText=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    let end=new Date(dateText+'T00:00:00Z');end.setUTCDate(end.getUTCDate()-1);const windows=[];
    for(let i=0;i<5;i++){const start=new Date(end);start.setUTCDate(start.getUTCDate()-364);windows.push({from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)});end=new Date(start);end.setUTCDate(end.getUTCDate()-1);}
    const symbols=['IX0001','0050','00631L'];const result={};
    // One atomic quota reservation covers all fifteen upstream calls, including failed requests.
    for(const symbol of symbols){const chunks=await Promise.all(windows.map(async window=>{
      const p=new URLSearchParams({...window,timeframe:'D',adjusted:symbol==='IX0001'?'false':'true',fields:'high,low,close',sort:'asc'});
      const response=await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${symbol}?${p}`,{headers:{'X-API-KEY':process.env.FUGLE_API_KEY},signal:AbortSignal.timeout(9000)});
      const body=await response.json();if(!response.ok)throw new Error(`${symbol} ${window.from}: ${body.message||response.status}`);return body.data||[];
    }));result[symbol]=chunks.flat();}
    const report=study(result.IX0001,result['0050'],result['00631L']);
    res.setHeader('Cache-Control','s-maxage=86400, stale-while-revalidate=3600');res.status(200).json({...report,dataset:result,generatedAt:new Date().toISOString(),source:'Fugle 歷史還原日 K'});
  }catch(e){res.status(502).json({error:e.message});}
};
