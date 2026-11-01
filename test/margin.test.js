const assert=require('node:assert/strict');
const {normalize,summary}=require('../margin-data');
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
const handler=require('../api/margin');
function response(){return{headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};}
(async()=>{
  const original=global.fetch;let count=0;
  try{
    const method=response();await handler({method:'POST'},method);assert.equal(method.code,405);
    global.fetch=async()=>{count++;return{ok:true,json:async()=>({stat:'error'})};};
    const bad=response();await handler({method:'GET'},bad);assert.equal(bad.code,502);assert.equal(bad.headers['Cache-Control'],'no-store');assert.equal(bad.body.data,undefined);
    global.fetch=async url=>{assert.ok(url.startsWith('https://www.twse.com.tw/'));count++;return{ok:true,json:async()=>body};};
    const a=response(),b=response();await Promise.all([handler({method:'GET'},a),handler({method:'GET'},b)]);
    assert.equal(count,2,'concurrent requests share one upstream call after failed attempt');assert.equal(a.code,200);assert.deepEqual(a.body.data,rows);assert.equal(a.body.unit,'億元');assert.deepEqual(a.body,b.body);
    await handler({method:'GET'},response());assert.equal(count,2,'hourly cache avoids extra upstream requests');
  }finally{global.fetch=original;}
  console.log('Margin data units, changes, averages, validation, failure and API caching tests passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
