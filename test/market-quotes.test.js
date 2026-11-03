const assert=require('node:assert/strict');
const q=require('../market-quotes');
const plan=q.subscriptions(['0050','00631L','00685L','009816','2330','2330'],'0050');
assert.equal(plan.length,5);
assert.deepEqual(plan.slice(0,2),[{symbol:'0050',channel:'trades'},{symbol:'IX0001',channel:'indices'}]);
assert.equal(q.subscriptions(['0050','2330'],'006208')[0].symbol,'006208');
const all=['0050','IX0001','0050','2330'];
assert.deepEqual(q.restSymbols(all,new Set(['0050','2330']),'0050'),['0050','IX0001'],'both market cards stay on the same REST cycle if either lacks a stream');
assert.deepEqual(q.restSymbols(all,new Set(['0050','IX0001']),'0050'),['2330']);
assert.equal(q.fromStream({event:'data',data:{symbol:'IX0001',index:43307.54,time:1793683800000000}}).price,43307.54);
assert.equal(q.fromStream({event:'snapshot',data:{symbol:'0050',price:80}}).price,80);
assert.equal(q.fromStream({event:'data',data:{symbol:'IX0001',index:0}}),null);
assert.equal(q.timestamp(1793683800000000),1793683800000);
assert.equal(q.gainToHigh(80,100),25);
assert.equal(q.gainToHigh(101,100),0);
assert.equal(q.gainToHigh(100,100),0);
assert.equal(q.gainToHigh(0,100),null);
assert.equal(q.gainToHigh(100,null),null);

(async()=>{
 const original=global.fetch;
 const env={...process.env};
 const handler=require('../api/history');
 let requests=0;
 try{
  process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='fixture';process.env.FUGLE_API_KEY='fixture';
  global.fetch=async url=>{
   if(url.startsWith('https://redis.test/'))return {ok:true,json:async()=>[{result:[1,1,0]}]};
   requests++;
   const p=new URL(url).searchParams;
   assert.equal(p.get('adjusted'),'true');assert.equal(p.get('fields'),'high,close');
   return {ok:true,json:async()=>({data:[{date:p.get('from'),high:125,close:80},{date:p.get('to'),high:115,close:110},{date:'2000-01-01',high:999,close:999},{date:'2099-01-01',high:888,close:888}]})};
  };
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};
  await handler({method:'GET',query:{symbol:'0050'}},res);
  assert.equal(res.code,200);assert.equal(res.body.highPrice,125);assert.equal(res.body.highPriceDate,res.body.from);
  assert.equal(res.body.highClose,110,'new 52-week highest price does not alter benchmark highest close');
  assert.equal(res.body.data.length,2);assert.equal(requests,1);
 }finally{global.fetch=original;for(const k of ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','FUGLE_API_KEY']){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}}
 console.log('PASS: paired quote transport, valid index stream, recovery gain and adjusted 52-week high vs highest close');
})().catch(e=>{console.error(e);process.exitCode=1;});
