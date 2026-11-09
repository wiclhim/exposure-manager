(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MarketQuotes=api;})(globalThis,()=>{
  'use strict';
  const INDEX='IX0001';
  const symbol=value=>String(value||'').trim().toUpperCase();
  const symbols=values=>[...new Set(values.map(symbol).filter(s=>/^[A-Z0-9.-]{1,12}$/.test(s)))];
  const marketPair=benchmark=>symbols([symbol(benchmark)||'0050',INDEX]);
  function timestamp(value){
    if(!value)return null;
    const n=Number(value);
    const ms=Number.isFinite(n)?(n>1e14?n/1000:n<1e11?n*1000:n):Date.parse(value);
    return Number.isFinite(new Date(ms).getTime())?ms:null;
  }
  function localBatch(quotes, requested){
    const wanted = new Set(requested);
    return (Array.isArray(quotes) ? quotes : []).filter(q =>
      wanted.has(q?.symbol) && Number.isFinite(q.price) && q.price > 0 && timestamp(q.quoteTime));
  }
  function gainToHigh(price,high){
    const p=Number(price),h=Number(high);
    return Number.isFinite(p)&&Number.isFinite(h)&&p>0&&h>0?Math.max(0,(h-p)/p*100):null;
  }
  return {INDEX,symbol,symbols,marketPair,timestamp,localBatch,gainToHigh};
});
