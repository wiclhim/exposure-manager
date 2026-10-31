const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace('  init();','globalThis.api={set:s=>state=s,get:()=>state,preview:cashAdjustmentPreview,apply:applyCashAdjustment,portfolio:getPortfolio};');
const context={localStorage:{getItem:()=>null},window:{},document:{}};vm.createContext(context);vm.runInContext(source,context);const api=context.api;
const fixture=()=>({cash:1000,cashUsd:100,usdTwd:32,quoteCache:{},cashReason:'cost',holdings:[{symbol:'L',category:'lever',beta:2,quantity:100,manualPrice:200}],settings:{}});
api.set(fixture());let before=api.portfolio(),snapshot=JSON.stringify(api.get());let p=api.preview('TWD','-100');assert.equal(p.after,900);assert.equal(p.assetChangeTwd,-100);assert.equal(JSON.stringify(api.get()),snapshot,'preview never books a fee');
api.apply('TWD','-100');assert.equal(api.get().cash,900);assert.equal(api.get().cashUsd,100);assert.equal(api.portfolio().total,before.total-100);assert.ok(api.portfolio().beta>before.beta,'fee reduces denominator without changing positions');assert.equal(api.get().cashChanges.length,1);assert.equal(api.get().cashChanges[0].reason,'cost');assert.equal(api.get().cashChanges[0].delta,-100);
api.set(fixture());before=api.portfolio();api.apply('USD','-0.50');assert.equal(api.get().cashUsd,99.5);assert.equal(api.get().cash,1000);assert.equal(api.portfolio().total,before.total-16);assert.equal(api.get().cashChanges[0].currency,'USD');
api.set(fixture());api.apply('TWD','200','flow');assert.equal(api.get().cash,1200);api.apply('TWD','-150','flow');assert.equal(api.get().cash,1050);api.apply('TWD','-50','correction');assert.equal(api.get().cash,1000);
for(const [currency,amount,reason] of [['TWD','100','cost'],['TWD','','cost'],['TWD',' ','cost'],['TWD','0','cost'],['TWD','-1000.01','cost'],['TWD','-0.001','cost'],['TWD','NaN','cost'],['TWD','-Infinity','cost'],['EUR','-1','cost'],['TWD','-1','invalid']]){
 api.set(fixture());snapshot=JSON.stringify(api.get());assert.throws(()=>api.apply(currency,amount,reason));assert.equal(JSON.stringify(api.get()),snapshot,'invalid input must not change balances or log');
}
for(const fx of [0,NaN,Infinity]){const s=fixture();s.usdTwd=fx;api.set(s);assert.throws(()=>api.apply('USD','-1'));assert.equal(api.get().cashUsd,100);}
const cents=fixture();cents.cash=1;api.set(cents);for(let i=0;i<100;i++)api.apply('TWD','-0.01');assert.equal(api.get().cash,0);assert.equal(api.get().cashChanges.length,100);assert.throws(()=>api.apply('TWD','-0.01'));
const imported=fixture();imported.cash=100.123;api.set(imported);assert.throws(()=>api.apply('TWD','-1'));assert.equal(api.get().cash,100.123,'do not silently round existing balances');
console.log('PASS: signed cash changes, exact fee deduction, total assets/Beta, USD conversion, audit log, preview-only, cent precision and rejected inputs');
