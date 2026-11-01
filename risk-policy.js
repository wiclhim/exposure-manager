(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.RiskPolicy=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const POLICY_VERSION='overheat-v1';
function heatSignals(input){
 const normalized=input.map(r=>Number.isFinite(r.dif)&&r.close>0?r.dif/r.close*100:null);
 let level=0,priorRaw=0,improving=0,lastHotDate=null,levelSince=null;const hotHistory=[];
 return input.map((r,i)=>{
  const p=input[i-1],p2=input[i-2];
  // Use earlier observations only; DIF/close is scale-adjusted MACD, not a fixed index-point threshold.
  const history=normalized.slice(Math.max(0,i-120),i).filter(Number.isFinite).sort((a,b)=>a-b);
  const threshold=history.length>=60?history[Math.ceil(history.length*.9)-1]:null;
  const macdHot=threshold!=null&&normalized[i]>0&&normalized[i]>threshold;
  const hotReasons=[];
  if(r.k!=null&&r.k>=80)hotReasons.push('K ≥ 80');
  if(r.rsi!=null&&r.rsi>=70)hotReasons.push('RSI ≥ 70');
  if(macdHot)hotReasons.push('標準化 MACD 高於先前最多 120 日的第 90 百分位');
  hotHistory.push(hotReasons.length>0);
  if(hotReasons.length)lastHotDate=r.date;
  const recentHot=hotHistory.slice(-10).some(Boolean),weakReasons=[];
  if(p&&r.k!=null&&r.d!=null&&p.k!=null&&r.k<r.d&&r.k<p.k)weakReasons.push('K 低於 D 且下降');
  if(p&&r.rsi!=null&&p.rsi!=null&&r.rsi<p.rsi)weakReasons.push('RSI 下降');
  if(p&&p2&&[r.histogram,p.histogram,p2.histogram].every(Number.isFinite)&&r.histogram<p.histogram&&p.histogram<p2.histogram)weakReasons.push('MACD 柱連續兩日下降');
  const armed=recentHot||level>0;
  let raw=armed&&weakReasons.length>=2?1:0;
  if(armed&&r.ma20!=null&&r.close<r.ma20&&r.histogram!=null&&r.histogram<0&&weakReasons.length>=1)raw=2;
  const healthy=!!(p&&r.ma20!=null&&r.close>r.ma20&&r.k!=null&&r.d!=null&&r.k>r.d&&Number.isFinite(r.histogram)&&Number.isFinite(p.histogram)&&r.histogram>p.histogram);
  const before=level;
  if(i>=199){
   if(raw>level){if(priorRaw>=raw)level=raw;improving=0;}
   else if(raw<level&&healthy){if(++improving>=3){level--;improving=0;}}
   else improving=0;
  }
  if(level!==before)levelSince=level?r.date:null;
  priorRaw=raw;
  return {hot:hotReasons.length>0,hotReasons,recentHot,lastHotDate,levelSince,weakReasons,raw,level,improving,healthy,normalizedMacd:normalized[i],macdThreshold:threshold,macdHistory:history.length,multiplier:[1,.9,.8][level]};
 });
}
function decorate(input){
  const rows=input,closes=rows.map(r=>r.close);let priorRaw=0,stage=0,improving=0;
  const decorated=rows.map((r,i)=>{
    const average=n=>i>=n-1?closes.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n:null;
    const ma20=average(20),ma200=average(200),ma60Past=i>=64?closes.slice(i-64,i-4).reduce((a,b)=>a+b,0)/60:null;
    let raw=0;const reasons=[];
    if(r.close<r.ma60){raw=1;reasons.push('收盤低於 MA60');}
    if(ma200&&r.close<ma200){raw=2;reasons.push('收盤低於 MA200');}
    if(ma200&&r.close<ma200&&r.ma60<ma60Past){raw=3;reasons.push('低於 MA200 且 MA60 下彎');}
    if(r.drawdown<=-20){raw=3;reasons.push('近一年收盤回檔超過 20%');}
    if(i>=199){if(raw>stage){if(priorRaw>=raw)stage=raw;improving=0;}else if(raw<stage){improving++;if(improving>=3){stage--;improving=0;}}else improving=0;}
    priorRaw=raw;
    const p=rows[i-1],p2=rows[i-2];
    const lowCross=!!(p&&p.k<=p.d&&r.k>r.d&&Math.min(p.k,p.d)<30);
    const repair=!!(p&&p2&&rows.slice(Math.max(0,i-9),i+1).some(row=>row.k!=null&&row.k<30)&&r.k>r.d&&r.k>p.k&&r.rsi>p.rsi&&r.histogram>p.histogram&&p.histogram>p2.histogram&&r.close>ma20);
    const multipliers=[1,.85,.65,.5];
    // A rebound may restore one level, but never more than the baseline and never during a deep drawdown.
    const recoveryLevel=repair&&r.drawdown>-20?Math.max(0,stage-1):stage;
    return {...r,ma20,ma200,ma60Past,trendRaw:raw,trendStage:stage,recoveryStage:recoveryLevel,trendReasons:reasons,lowCross,repair,studyReady:i>=199,targets:{constant:1,legacy:multipliers[r.stage??0],trend:multipliers[stage],recovery:multipliers[recoveryLevel]}};
  });
  const heat=heatSignals(decorated);
  return decorated.map((r,i)=>({...r,heat:heat[i],targets:{...r.targets,recoveryHeat:Math.min(r.targets.recovery,heat[i].multiplier)}}));
}

function executionStep(current,ceiling,execution='gradual',daysSinceApplied=Infinity){
 const direction=current>ceiling+.005?'decrease':current<ceiling-.005?'increase':'hold';
 const next=Math.round((direction==='decrease'?(execution==='fastDown'?ceiling:Math.max(ceiling,current-.1)):direction==='increase'?Math.min(ceiling,current+.1):current)*100)/100;
 const cooldown=daysSinceApplied===0||(daysSinceApplied<5&&!(execution==='fastDown'&&direction==='decrease'));
 return {next,direction,cooldown,canApply:direction!=='hold'&&!cooldown,execution};
}
function recommendation(rows,baseline,current,model='recovery',execution='gradual',daysSinceApplied=Infinity,overheatEnabled=true){
 const data=rows.at(-1)?.heat?rows:decorate(rows),last=data.at(-1);
 if(!last?.studyReady)throw new Error('MA200 暖機資料不足，暫不產生建議');
 const baseMultiplier=last.targets[model]??last.targets.recovery;
 const multiplier=overheatEnabled?Math.min(baseMultiplier,last.heat.multiplier):baseMultiplier;
 const stage=model==='legacy'?last.stage:model==='trend'?last.trendStage:last.recoveryStage;
 const ceiling=Math.round(baseline*multiplier*100)/100;
 const reasons=[...(model==='legacy'?last.reasons:last.trendReasons)];
 if(overheatEnabled&&last.heat.level>0)reasons.push(`高檔轉弱防守第 ${last.heat.level} 級（${(last.heat.multiplier*100).toFixed(0)}% 上限）`);
 return {stage,multiplier,baseMultiplier,overheatEnabled,heat:last.heat,policyVersion:POLICY_VERSION,ceiling,...executionStep(current,ceiling,execution,daysSinceApplied),date:last.date,model,repair:last.repair,reasons};
}
return {decorate,recommendation,executionStep,heatSignals,POLICY_VERSION};
});
