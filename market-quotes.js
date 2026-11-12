(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MarketQuotes=api;})(globalThis,()=>{
  'use strict';
  const INDEX='IX0001';
  const symbol=value=>String(value||'').trim().toUpperCase();
  const symbols=values=>[...new Set(values.map(symbol).filter(s=>/^[A-Z0-9.-]{1,12}$/.test(s)))];
  const marketPair=benchmark=>symbols([symbol(benchmark)||'0050',INDEX]);
  function privateOrigin(value) {
    try {
      const url = new URL(String(value || '').trim());
      const tailscaleHost = /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/;
      if (url.protocol !== 'https:' || !tailscaleHost.test(url.hostname) || url.port ||
          url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
      return url.origin;
    } catch { return null; }
  }
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
  function shioajiIndexBar(quote, now = Date.now()) {
    if (quote?.source !== '永豐 Shioaji') return null;
    const { price, high, low } = quote;
    if (![price, high, low].every(Number.isFinite) || low <= 0 || price < low || price > high) return null;
    const quoteTime = timestamp(quote.quoteTime);
    if (!quoteTime || quoteTime > now) return null;
    const taipei = new Date(quoteTime + 8 * 3600000);
    const date = taipei.toISOString().slice(0, 10);
    if (quote.date !== date) return null;
    // Delayed closing auctions can change the index through 13:33.
    const closed = taipei.getUTCHours() * 60 + taipei.getUTCMinutes() >= 13 * 60 + 33;
    return { date, high, low, close: price, quoteTime, closed };
  }
  function gainToHigh(price,high){
    const p=Number(price),h=Number(high);
    return Number.isFinite(p)&&Number.isFinite(h)&&p>0&&h>0?Math.max(0,(h-p)/p*100):null;
  }
  return {INDEX,symbol,symbols,marketPair,privateOrigin,timestamp,localBatch,shioajiIndexBar,gainToHigh};
});
