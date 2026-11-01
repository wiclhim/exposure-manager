const assert=require('node:assert/strict');
const policy=require('../risk-policy');
const engine=require('../strategy-study-engine');
const neutral=i=>({date:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),close:100,ma20:95,k:60,d:50,rsi:60,histogram:1,dif:1});
const prefix=()=>Array.from({length:205},(_,i)=>neutral(i));
const hot={...neutral(205),k:85,d:80,rsi:75,histogram:10,dif:10};
const weak1={...neutral(206),k:78,d:80,rsi:72,histogram:8};
const weak2={...neutral(207),k:74,d:78,rsi:69,histogram:6};
let input=[...prefix(),hot,weak1,weak2],heat=policy.heatSignals(input);
assert.equal(heat.at(-3).hot,true);assert.equal(heat.at(-3).level,0,'high readings alone never cut Beta');
assert.equal(heat.at(-2).raw,1);assert.equal(heat.at(-2).level,0,'first weak day only warns');
assert.equal(heat.at(-1).level,1);assert.equal(heat.at(-1).multiplier,.9);
assert.equal(heat.at(-1).weakReasons.length,3);
const lower1={...neutral(208),close:90,k:70,d:76,rsi:65,histogram:-1,dif:-1};
const lower2={...neutral(209),close:89,k:66,d:74,rsi:62,histogram:-2,dif:-2};
input.push(lower1,lower2);heat=policy.heatSignals(input);
assert.equal(heat.at(-2).raw,2);assert.equal(heat.at(-2).level,1);
assert.equal(heat.at(-1).level,2);assert.equal(heat.at(-1).multiplier,.8);
// Waiting alone cannot clear an active defense when its original ten-day hot memory expires.
for(let i=0;i<12;i++)input.push({...neutral(210+i),close:90,k:45,d:50,rsi:45,histogram:-2,dif:-2});
heat=policy.heatSignals(input);assert.equal(heat.at(-1).recentHot,false);assert.equal(heat.at(-1).level,2);
for(let i=0;i<6;i++)input.push({...neutral(222+i),k:60,d:50,histogram:i+1});
heat=policy.heatSignals(input);
assert.equal(heat.at(-5).level,2);assert.equal(heat.at(-4).level,1,'three healthy days release one level');
assert.equal(heat.at(-2).level,1);assert.equal(heat.at(-1).level,0,'another three healthy days clear defense');
const interrupted=[...prefix(),hot,weak1,{...neutral(207),k:81,d:75,rsi:76,histogram:11},weak2];
assert.equal(policy.heatSignals(interrupted).at(-1).level,0,'non-consecutive weak signals do not confirm');
const cold=[...prefix(),weak1,weak2,lower1,lower2].map(r=>({...r,k:Math.min(r.k,70),rsi:Math.min(r.rsi,65),dif:0}));assert.equal(policy.heatSignals(cold).at(-1).level,0,'no heat and no active defense means no heat cut');
const rising=[...prefix(),...Array.from({length:20},(_,i)=>({...neutral(205+i),k:85,d:80,rsi:75,histogram:2+i,dif:10+i}))];
assert(policy.heatSignals(rising).every(r=>r.level===0),'strong overbought trend stays observation-only');
const scaled=input.map(r=>({...r,close:r.close*10,ma20:r.ma20*10,dif:r.dif*10,histogram:r.histogram*10}));
assert.deepEqual(policy.heatSignals(scaled).map(r=>[r.raw,r.level,r.hot]),heat.map(r=>[r.raw,r.level,r.hot]),'no arbitrary absolute MACD threshold');
const missing=prefix().map(r=>({...r,k:null,rsi:null,dif:null}));assert.equal(policy.heatSignals(missing).at(-1).hot,false);
assert.equal(policy.heatSignals(prefix().slice(0,59)).at(-1).macdThreshold,null);
assert.deepEqual(policy.heatSignals(input.slice(0,208)),policy.heatSignals(input).slice(0,208),'future candles cannot alter heat history');
// Shared live/backtest multiplier, no stacked reductions, and disabled opt-out restores original advice.
const candles=Array.from({length:1100},(_,i)=>{let close=150+i*.08+25*Math.sin(i/70);return{date:new Date(Date.UTC(2021,0,i+1)).toISOString().slice(0,10),close,high:close+2,low:close-2};});
const decorated=engine.signals(candles);
for(let i=199;i<decorated.length;i++){
 const rows=decorated.slice(0,i+1),r=rows.at(-1),advice=policy.recommendation(rows,1.3,1.3,'recovery','fastDown',5,true);
 assert.equal(advice.multiplier,r.targets.recoveryHeat);
 assert(advice.multiplier<=r.targets.recovery);
 assert.equal(policy.recommendation(rows,1.3,1.3,'recovery','fastDown',5,false).multiplier,r.targets.recovery);
}
const sample=structuredClone(decorated);sample.at(-1).heat.multiplier=.9;sample.at(-1).heat.level=1;sample.at(-1).targets.recovery=.65;
assert.equal(policy.recommendation(sample,1.3,1.3).multiplier,.65,'take stricter defense, not .65 times .90');
const aligned=decorated.map(r=>({...r,core:r.close,lever:r.close}));
for(const mode of ['gradual','fastDown']){
 const report=engine.simulate(aligned,'recoveryHeat',300,1000,1.3,1,mode),short=engine.simulate(aligned.slice(0,800),'recoveryHeat',300,800,1.3,1,mode);
 assert.deepEqual(short.curve,report.curve.slice(0,500));
 assert(report.tradeLog.every(t=>t.signalDate<t.date),'new overlay also trades with one-day signal lag');
 const changed=structuredClone(aligned);changed[300].targets.recoveryHeat=0;
 assert.equal(engine.simulate(changed,'recoveryHeat',300,301,1.3,1,mode).totalReturn,engine.simulate(aligned,'recoveryHeat',300,301,1.3,1,mode).totalReturn);
}
console.log('PASS: heat-only watch, two-day cuts, three-day staged release, latch/expiry, normalized MACD, prefix invariance, live/backtest parity and opt-out');
