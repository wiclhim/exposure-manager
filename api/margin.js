const {normalize}=require('../margin-data');
let cached=null,pending=null;
module.exports=async function(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
  try{
    if(!cached||Date.now()-cached.at>=3600000){
      if(!pending)pending=(async()=>{
        const response=await fetch('https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN_TREND?response=json&days=60',{signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw new Error('證交所融資服務暫時無法連線');
        const data=normalize(await response.json());
        const payload={source:'臺灣證券交易所',scope:'上市市場（不含上櫃）',unit:'億元',fetchedAt:new Date().toISOString(),data};
        cached={at:Date.now(),payload};
      })().finally(()=>{pending=null;});
      await pending;
    }
    res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=3600');
    return res.status(200).json(cached.payload);
  }catch{
    res.setHeader('Cache-Control','no-store');
    return res.status(502).json({error:'融資資料暫時無法取得，請稍後重試。'});
  }
};
