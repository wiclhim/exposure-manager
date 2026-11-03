(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MarketQuotes=api;})(globalThis,()=>{
  'use strict';
  const INDEX='IX0001';
  const symbol=value=>String(value||'').trim().toUpperCase();
  const symbols=values=>[...new Set(values.map(symbol).filter(s=>/^[A-Z0-9.-]{1,12}$/.test(s)))];
  const marketPair=benchmark=>symbols([symbol(benchmark)||'0050',INDEX]);
  function subscriptions(holdings,benchmark){
    const pair=marketPair(benchmark),held=symbols(holdings);
    const preferred=['0050','00631L','00685L','009816'].filter(s=>held.includes(s));
    return symbols([...pair,...preferred,...held]).slice(0,5).map(s=>({symbol:s,channel:s===INDEX?'indices':'trades'}));
  }
  function restSymbols(all,streaming,benchmark){
    const pair=marketPair(benchmark),pairReady=pair.every(s=>streaming.has(s));
    return symbols(all).filter(s=>!streaming.has(s)||(!pairReady&&pair.includes(s)));
  }
  function timestamp(value){
    if(!value)return null;
    const n=Number(value);
    const ms=Number.isFinite(n)?(n>1e14?n/1000:n<1e11?n*1000:n):Date.parse(value);
    return Number.isFinite(new Date(ms).getTime())?ms:null;
  }
  function fromStream(msg){
    const d=msg?.data,s=symbol(d?.symbol);
    if(!s||!['snapshot','data'].includes(msg.event))return null;
    const price=Number(s===INDEX?d.index:d.price||d.lastPrice||d.closePrice);
    if(!Number.isFinite(price)||price<=0)return null;
    return {symbol:s,name:d.name||s,price,quoteTime:d.time||null,lastUpdated:d.time||Date.now(),source:'Fugle WebSocket',isClose:Boolean(d.isClose),isTrial:Boolean(d.isTrial)};
  }
  function gainToHigh(price,high){
    const p=Number(price),h=Number(high);
    return Number.isFinite(p)&&Number.isFinite(h)&&p>0&&h>0?Math.max(0,(h-p)/p*100):null;
  }
  return {INDEX,symbol,symbols,marketPair,subscriptions,restSymbols,timestamp,fromStream,gainToHigh};
});
