(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.RiskPolicy=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function decorate(input){
  const rows=input,closes=rows.map(r=>r.close);let priorRaw=0,stage=0,improving=0;
  return rows.map((r,i)=>{
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
}

function recommendation(rows,baseline,current,model='recovery'){
 const data=rows.at(-1)?.targets?rows:decorate(rows),last=data.at(-1);
 if(!last?.studyReady)throw new Error('MA200 暖機資料不足，暫不產生建議');
 const multiplier=last.targets[model]??last.targets.recovery;
 const stage=model==='legacy'?last.stage:model==='trend'?last.trendStage:last.recoveryStage;
 const ceiling=Math.round(baseline*multiplier*100)/100;
 const next=Math.round((current>ceiling?Math.max(ceiling,current-.1):Math.min(ceiling,current+.1))*100)/100;
 return {stage,multiplier,ceiling,next,date:last.date,model,repair:last.repair,reasons:model==='legacy'?last.reasons:last.trendReasons};
}
return {decorate,recommendation};
});
