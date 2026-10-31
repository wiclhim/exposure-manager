const assert=require('node:assert/strict');
const {executionStep,recommendation}=require('../risk-policy');
const {signals,simulate,compareExecution}=require('../strategy-study-engine');
let r=executionStep(1.6,1.11,'gradual',1);assert.equal(r.next,1.5);assert.equal(r.canApply,false);
r=executionStep(1.6,1.11,'fastDown',1);assert.equal(r.next,1.11);assert.equal(r.canApply,true);
assert.equal(executionStep(1.6,1.11,'fastDown',0).canApply,false,'same candle cannot be adopted twice');
assert.equal(executionStep(1,1.3,'fastDown',4).canApply,false,'recovery keeps the five-day cooldown');
assert.equal(executionStep(1,1.3,'fastDown',5).next,1.1);
assert.equal(executionStep(1.11,1.11,'fastDown',9).canApply,false);
const candles=Array.from({length:1100},(_,i)=>({date:new Date(Date.UTC(2021,0,i+1)).toISOString().slice(0,10),close:150+i*.08+25*Math.sin(i/70),high:152+i*.08+25*Math.sin(i/70),low:148+i*.08+25*Math.sin(i/70)}));
const rows=signals(candles).map(r=>({...r,core:r.close,lever:r.close}));
for(const execution of ['gradual','fastDown']){
 const full=simulate(rows,'recovery',300,1000,1.3,1,execution);
 const prefix=simulate(rows.slice(0,800),'recovery',300,800,1.3,1,execution);
 assert.deepEqual(prefix.curve,full.curve.slice(0,500),'future data cannot affect prior trades or NAV');
 const changed=structuredClone(rows);changed[300].targets.recovery=0;
 assert.equal(simulate(changed,'recovery',300,301,1.3,1,execution).totalReturn,simulate(rows,'recovery',300,301,1.3,1,execution).totalReturn,'no same-close signal trading');
 for(const [i,trade] of full.tradeLog.entries()){
   assert.ok(trade.signalDate<trade.date);
   if(!i)continue;
   const increase=trade.target>trade.previousTarget+.005;
   if(execution==='gradual'||increase)assert.ok(trade.daysSinceLast>=5);
   if(execution==='gradual'||increase)assert.ok(Math.abs(trade.target-trade.previousTarget)<=.100001);
 }
}
const shock=structuredClone(rows);for(const row of shock)row.targets.recovery=1;
shock[300].targets.recovery=.5;
const fast=simulate(shock,'recovery',300,303,1.3,1,'fastDown');
const slow=simulate(shock,'recovery',300,303,1.3,1,'gradual');
assert.equal(fast.tradeLog[1].date,shock[301].date);assert.equal(fast.tradeLog[1].target,.65);assert.equal(fast.tradeLog[1].daysSinceLast,1);
assert.equal(slow.tradeLog.length,1,'gradual waits after initial purchase');
const report=compareExecution(candles,candles,candles);
assert(report.train.every(r=>r.to<report.splitDate));assert(report.test.every(r=>r.from===report.splitDate));
assert.equal(report.train[0].curve[0].value,report.train[1].curve[0].value,'same initial holdings and entry costs');
assert.equal(report.selectedExecution==='fastDown',report.trainingQualified&&report.validationPassed,'selection must follow the fixed gate');
const advice=recommendation(rows,1.3,1.6,'recovery','fastDown',1);
assert.equal(advice.next,advice.ceiling);assert.equal(advice.cooldown,false);
console.log('PASS: shared live/backtest execution, fast cuts, slow recovery, cooldown, signal lag, prefix invariance and fixed selection gate');
