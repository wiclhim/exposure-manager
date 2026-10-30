module.exports = async function handler(req, res) {
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  try {
    const response=await fetch('https://open.er-api.com/v6/latest/USD',{signal:AbortSignal.timeout(8000)});
    const data=await response.json();
    if(!response.ok || data.result!=='success' || !(data.rates?.TWD>0)) throw new Error('匯率服務目前無法使用');
    res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({rate:data.rates.TWD,date:new Date(data.time_last_update_unix*1000).toISOString().slice(0,10),source:'ExchangeRate-API',sourceUrl:'https://www.exchangerate-api.com'});
  } catch {res.status(502).json({error:'匯率更新失敗，請手動填入 USD/TWD 匯率'});}
};
