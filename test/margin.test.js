const assert=require('node:assert/strict');
const {normalize,summary,normalizeMaintenance,combine,segments}=require('../margin-data');
const body={stat:'OK',data:Array.from({length:25},(_,i)=>({date:new Date(Date.UTC(2026,9,i+1)).toISOString().slice(0,10).replaceAll('-',''),marginAmt:600000000+i*100000}))};
const rows=normalize({...body,data:[...body.data].reverse()});
assert.equal(rows[0].balance,6000,'thousands to hundred-million TWD');
assert.equal(rows.at(-1).balance,6024);
assert.equal(rows[0].change,null,'no invented previous balance');
assert.equal(rows[1].change,1);
assert.equal(rows[18].ma20,null);
assert.equal(rows[19].ma20,6009.5);
assert.equal(summary(rows).dayChange,1);
assert.equal(summary(rows).fiveChange,5,'five changes require six observations');
assert.equal(summary(rows.slice(0,5)).fiveChange,null);
assert.equal(summary(rows).fivePercent,(6024/6019-1)*100);
const falling=normalize({stat:'OK',data:[{date:'20261029',marginAmt:633910848},{date:'20261030',marginAmt:623467886}]});
assert.equal(falling.at(-1).balance,6234.67886);
assert.ok(Math.abs(summary(falling).dayChange-(-104.42962))<1e-9);
for(const patch of [{date:'20260230'},{date:'not-date'},{marginAmt:null},{marginAmt:''},{marginAmt:-1},{marginAmt:Infinity}]){
  const invalid=structuredClone(body);Object.assign(invalid.data[0],patch);assert.throws(()=>normalize(invalid));
}
assert.throws(()=>normalize({stat:'OK',data:[body.data[0],body.data[0]]}));
assert.throws(()=>normalize({stat:'no data',data:body.data}));
assert.throws(()=>normalize({stat:'OK',data:[]}));
assert.equal(summary([{balance:0},{balance:1}]).dayPercent,null);
const dates=Array.from({length:120},(_,i)=>new Date(Date.UTC(2026,5,i+7)).toISOString().slice(0,10).replaceAll('-',''));
const balanceSource=dates.map((date,i)=>({date,marginAmt:600000000+i*100000}));
const rateSource=dates.slice(-63).map((date,i)=>({date,keepRate:180+i*.1}));
assert.equal(normalizeMaintenance({stat:'OK',data:[{date:dates[0],keepRate:null}]}).at(-1).keepRate,null);
for(const value of [0,-1,'190',NaN,Infinity])assert.throws(()=>normalizeMaintenance({stat:'OK',data:[{date:dates[0],keepRate:value}]}));
const hole=combine(rows,[{date:rows[0].date,keepRate:190},{date:rows[2].date,keepRate:189}]);
assert.equal(hole[1].keepRate,null);assert.equal(segments(hole,'keepRate').length,2,'missing dates split the ratio line');
assert.equal(hole[2].keepRate,189,'rates align by date, never by array offset');
function handler(){delete require.cache[require.resolve('../api/margin')];return require('../api/margin');}
function response(){return{headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};}
(async()=>{
  const original=global.fetch;let count=0;
  const good=async url=>{
    count++;const u=new URL(url),rate=u.pathname.endsWith('BFIJ3U_TREND'),source=rate?rateSource:balanceSource,date=u.searchParams.get('date');
    assert.equal(u.searchParams.get('days'),'60');assert.equal(u.hostname,'www.twse.com.tw');
    if(date)assert.equal(date,new Date(Date.parse(dates.at(-60).replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')+'T00:00:00Z')-86400000).toISOString().slice(0,10).replaceAll('-',''));
    return {ok:true,json:async()=>({stat:'OK',data:(date?source.filter(r=>r.date<=date):source).slice(-60)})};
  };
  try{
    const main=handler(),method=response();await main({method:'POST'},method);assert.equal(method.code,405);
    global.fetch=async()=>{count++;return{ok:true,json:async()=>({stat:'error'})};};
    const bad=response();await main({method:'GET'},bad);assert.equal(bad.code,502);assert.equal(bad.headers['Cache-Control'],'no-store');assert.equal(bad.body.data,undefined);
    const before=count;global.fetch=good;
    const a=response(),b=response();await Promise.all([main({method:'GET'},a),main({method:'GET'},b)]);
    assert.equal(count-before,4,'two pages for each source, shared by concurrent API requests');
    assert.equal(a.code,200);assert.equal(a.body.data.length,110,'90 visible rows plus moving-average warm-up');
    assert.equal(a.body.data.slice(-90).length,90);assert.equal(a.body.data.slice(-90)[0].ma20!=null,true);
    assert.deepEqual(a.body.data,combine(normalize({stat:'OK',data:balanceSource.slice(-110)}),normalizeMaintenance({stat:'OK',data:rateSource})));
    assert.equal(a.body.data.filter(r=>r.keepRate!=null).length,63,'do not fabricate 90 days of ratio history');
    assert.equal(a.body.maintenance.latest.keepRate,186.2);assert.equal(a.body.unit,'億元');assert.equal(a.body.version,2);assert.deepEqual(a.body,b.body);
    const cachedCount=count;await main({method:'GET'},response());assert.equal(count,cachedCount,'hourly cache avoids extra upstream requests');
    const partial=handler();global.fetch=async url=>{if(new URL(url).pathname.endsWith('BFIJ3U_TREND'))throw Error('temporary outage');return good(url);};
    const c=response();await partial({method:'GET'},c);assert.equal(c.code,200);assert.equal(c.body.data.length,110);assert(c.body.maintenance.error);assert(c.body.data.every(r=>r.keepRate===null));assert(c.headers['Cache-Control'].includes('s-maxage=300'));
    const backfill=handler();global.fetch=async url=>{if(url.includes('MI_MARGN_TREND')&&new URL(url).searchParams.has('date'))throw Error('older history unavailable');return good(url);};
    const d=response();await backfill({method:'GET'},d);assert.equal(d.code,200);assert.equal(d.body.data.length,60);assert.equal(d.body.historyIncomplete,true);assert(d.headers['Cache-Control'].includes('s-maxage=300'));
  }finally{global.fetch=original;}
  console.log('PASS: margin/ratio units, date alignment, genuine 90-session history, warm-up, missing-data gaps, pagination, concurrent caching and partial outages');
})().catch(error=>{console.error(error);process.exitCode=1;});
