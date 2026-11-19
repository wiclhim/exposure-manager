const assert=require('node:assert/strict');
const {normalize,summary,addOtcBalance,normalizeMaintenance,combine,segments,mergeHistory}=require('../margin-data');
const financingSource=require('../financing-maintenance');
const financingFixture={as_of:'2026-11-18',series:{d:['2026-11-17','2026-11-18'],v:[1.5228,1.5441]}};
assert.deepEqual(financingSource.normalize(financingFixture),[
  {date:'2026-11-17',financingRate:152.28,financingSource:'FinLab'},
  {date:'2026-11-18',financingRate:154.41,financingSource:'FinLab'}
],'provider multiples convert to percentages');
for(const invalid of [
  {as_of:'2026-11-19'},
  {series:{d:['2026-11-18'],v:[0]}},
  {series:{d:['2026-11-18','2026-11-18'],v:[1.5,1.6]}},
  {series:{d:['2026-02-31','2026-11-18'],v:[1.5,1.6]}},
  {series:{d:['2026-11-18'],v:[]}}
])assert.throws(()=>financingSource.normalize({...financingFixture,...invalid}));
const migrated=mergeHistory([{date:'2026-11-18',listedBalance:5,otcBalance:1,keepRate:190}]);
assert.equal(migrated[0].financingRate,null,'whole-account rates must not become financing-only rates');
const updated=mergeHistory(migrated,[{date:'2026-11-18',financingRate:154.41,unpriced:13}]);
assert.equal(updated[0].keepRate,190);
assert.equal(updated[0].financingRate,154.41);
assert.equal(mergeHistory(updated,[{date:'2026-11-18',financingRate:null}])[0].financingRate,154.41,'temporary missing rates preserve saved history');
const finlabUpdated=mergeHistory(updated,financingSource.normalize(financingFixture));
assert.equal(finlabUpdated.at(-1).financingSource,'FinLab');
assert.equal(mergeHistory(finlabUpdated,[{date:'2026-11-18',financingRate:199}]).at(-1).financingRate,154.41,'old backup imports preserve the website series');
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
const dates=Array.from({length:120},(_,i)=>new Date(Date.UTC(2027,5,i+7)).toISOString().slice(0,10).replaceAll('-',''));
const balanceSource=dates.map((date,i)=>({date,marginAmt:600000000+i*100000}));
const otcSource=dates.slice(-39).map((date,i)=>({date,marginBalance:1400+i*2}));
const combinedBalance=addOtcBalance(normalize({stat:'OK',data:balanceSource.slice(-110)}),otcSource);
assert.equal(combinedBalance.at(-1).balance, 6119+1476);
assert.equal(combinedBalance.at(-39).change, null);
assert.equal(combinedBalance.at(-39).ma20, null);
assert.equal(summary(combinedBalance).dayChange, 3);
assert.equal(summary(combinedBalance).fiveChange, 15);
const incompleteBalance=addOtcBalance(normalize({stat:'OK',data:balanceSource}),otcSource.filter((_,i)=>i!==37));
assert.equal(summary(incompleteBalance).dayChange,null);
assert.equal(summary(incompleteBalance).fiveChange,null);
assert.equal(incompleteBalance.at(-1).ma20,null);
assert.equal(normalizeMaintenance({stat:'OK',data:[{date:dates[0],keepRate:null}]}).at(-1).keepRate,null);
for(const value of [0,-1,'190',NaN,Infinity])assert.throws(()=>normalizeMaintenance({stat:'OK',data:[{date:dates[0],keepRate:value}]}));
const hole=combine(rows,[{date:rows[0].date,keepRate:190},{date:rows[2].date,keepRate:189}]);
assert.equal(hole[1].keepRate,null);assert.equal(segments(hole,'keepRate').length,2,'missing dates split the ratio line');
assert.equal(hole[2].keepRate,189,'rates align by date, never by array offset');
function handler(){delete require.cache[require.resolve('../api/margin')];return require('../api/margin');}
function response(){return{headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};}
(async()=>{
  const original=global.fetch,originalLoad=financingSource.load;let count=0;
  const financingLoad=async()=>dates.slice(-3).map((day,i)=>({date:day.replace(/^(....)(..)(..)$/, '$1-$2-$3'),financingRate:186+i/10,financingSource:'FinLab'}));
  financingSource.load=financingLoad;
  const good=async url=>{
    count++;const u=new URL(url);
    if(u.hostname==='www.tpex.org.tw')return {ok:true,json:async()=>({stat:'ok',trend:otcSource})};
    const source=balanceSource,date=u.searchParams.get('date');
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
    assert.equal(count-before,3,'source requests shared by concurrent API requests');
    assert.equal(a.code,200);assert.equal(a.body.data.length,110,'90 visible rows plus moving-average warm-up');
    assert.equal(a.body.data.slice(-90).length,90);assert.equal(a.body.data.at(-1).ma20!=null,true);
    assert.deepEqual(a.body.data.map(({financingRate,financingSource,...row})=>row),combinedBalance);
    assert.equal(a.body.data.filter(r=>r.balance!=null).length,39,'leave missing OTC dates empty');
    assert.equal(a.body.data.filter(r=>r.financingRate!=null).length,3,'keep missing financing history empty');
    assert.equal(a.body.maintenance.latest.financingRate,186.2);assert.equal(a.body.unit,'億元');assert.equal(a.body.version,5);assert.deepEqual(a.body,b.body);
    const cachedCount=count;await main({method:'GET'},response());assert.equal(count,cachedCount,'hourly cache avoids extra upstream requests');
    financingSource.load=async()=>{throw Error('temporary outage');};
    const partial=handler();global.fetch=good;
    const c=response();await partial({method:'GET'},c);assert.equal(c.code,200);assert.equal(c.body.data.length,110);assert(c.body.maintenance.error);assert(c.body.data.every(r=>r.financingRate===null));assert(c.headers['Cache-Control'].includes('s-maxage=300'));
    financingSource.load=financingLoad;
    const backfill=handler();global.fetch=async url=>{if(url.includes('MI_MARGN_TREND')&&new URL(url).searchParams.has('date'))throw Error('older history unavailable');return good(url);};
    const d=response();await backfill({method:'GET'},d);assert.equal(d.code,200);assert.equal(d.body.data.length,60);assert.equal(d.body.historyIncomplete,true);assert(d.headers['Cache-Control'].includes('s-maxage=300'));
    const noOtc=handler();global.fetch=async url=>{if(new URL(url).hostname.endsWith('.tpex.org.tw'))throw Error('OTC offline');return good(url);};
    const e=response();await noOtc({method:'GET'},e);assert.equal(e.code,200);assert.equal(e.body.otcError,true);
    assert(e.body.data.every(row=>row.balance===null),'listed-only values must never appear as combined');
    assert.equal(e.body.maintenance.latest.financingRate,186.2);
    const fallback=handler();
    global.fetch=async url=>{
      const host=new URL(url).hostname;
      if(host==='www.tpex.org.tw')throw Error('OTC trend offline');
      if(host==='info.tpex.org.tw')return {ok:true,json:async()=>({marginPurchaseValue:[
        {date:'10/4',count:'147600000'}
      ]})};
      return good(url);
    };
    const f=response();await fallback({method:'GET'},f);
    assert.equal(f.body.data.at(-1).otcBalance,1476,'market board amount converts from thousands to hundred-million TWD');
    const daily=handler();
    global.fetch=async url=>{
      const {hostname,pathname,searchParams}=new URL(url);
      if(pathname.endsWith('/margin/balance')){
        assert.equal(searchParams.get('date'),'2027/10/04');
        return {ok:true,json:async()=>({date:'20271004',stat:'ok',tables:[{summary:[
          ['', '融資金(仟元)', '147,600,000', '', '', '', '147,900,231'],
        ]}]})};
      }
      if(hostname.endsWith('.tpex.org.tw'))throw Error('OTC dashboard offline');
      return good(url);
    };
    const g=response();await daily({method:'GET'},g);
    assert.equal(g.body.otcError,false);
    assert.equal(g.body.data.at(-1).otcBalance,1479.00231,'daily report uses current balance in thousands');
  }finally{global.fetch=original;financingSource.load=originalLoad;}
  console.log('PASS: margin/ratio units, date alignment, genuine 90-session history, warm-up, missing-data gaps, pagination, concurrent caching and partial outages');
})().catch(error=>{console.error(error);process.exitCode=1;});
