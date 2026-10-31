(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.IndexRisk=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function ema(values,period){let seed=[],previous=null;return values.map(value=>{if(value==null)return null;if(previous==null){seed.push(value);if(seed.length<period)return null;previous=seed.reduce((a,b)=>a+b,0)/period;}else previous=value*2/(period+1)+previous*(1-2/(period+1));return previous;});}
  function calculate(input){
    const seen=new Map();input.forEach(row=>{if(row.date&&[row.high,row.low,row.close].every(v=>Number.isFinite(Number(v))&&Number(v)>0)&&Number(row.high)>=Number(row.low))seen.set(row.date,{date:row.date,high:Number(row.high),low:Number(row.low),close:Number(row.close)});});
    const rows=[...seen.values()].sort((a,b)=>a.date.localeCompare(b.date));
    if(rows.length<70)throw new Error('加權指數有效日 K 不足 70 筆，暫不產生建議');
    const closes=rows.map(row=>row.close),fast=ema(closes,12),slow=ema(closes,26);
    const dif=closes.map((_,i)=>fast[i]!=null&&slow[i]!=null?fast[i]-slow[i]:null),signal=ema(dif,9);
    let k=50,d=50,gain=0,loss=0,stage=0,better=0,lastRaw=0;
    return rows.map((row,i)=>{
      if(i){const change=row.close-rows[i-1].close;if(i<=14){gain+=Math.max(0,change)/14;loss+=Math.max(0,-change)/14;}else{gain=(gain*13+Math.max(0,change))/14;loss=(loss*13+Math.max(0,-change))/14;}}
      const rsi=i<14?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss);
      let kd=null;if(i>=8){const window=rows.slice(i-8,i+1),hi=Math.max(...window.map(r=>r.high)),lo=Math.min(...window.map(r=>r.low));const rsv=hi===lo?50:(row.close-lo)/(hi-lo)*100;k=k*2/3+rsv/3;d=d*2/3+k/3;kd={k,d};}
      const histogram=signal[i]==null?null:dif[i]-signal[i];
      const ma60=i>=59?closes.slice(i-59,i+1).reduce((a,b)=>a+b,0)/60:null;
      const high=Math.max(...closes.slice(Math.max(0,i-251),i+1)),drawdown=(row.close/high-1)*100;
      const reasons=[];if(kd&&k<d&&k<50)reasons.push('KD：K < D 且 K < 50');if(rsi!=null&&rsi<45)reasons.push('RSI14 < 45');if(histogram!=null&&histogram<0&&dif[i]<0)reasons.push('MACD：DIF < 0 且柱狀值 < 0');
      let raw=reasons.length;if(ma60&&row.close<ma60){raw=Math.max(raw,2);reasons.push('收盤低於 60 日均線');}if(drawdown<=-20){raw=3;reasons.push('距近 252 筆最高收盤回檔達 20%');}
      const ready=i>=69;
      if(ready){
        if(raw>stage){if(lastRaw>=raw)stage=raw;better=0;}else if(raw<stage){better++;if(better>=3){stage--;better=0;}}else better=0;
      }
      lastRaw=raw;
      return {...row,k:kd?k:null,d:kd?d:null,rsi,dif:dif[i],signal:signal[i],histogram,ma60,drawdown,rawStage:raw,stage:ready?stage:null,reasons,ready};
    });
  }
  function recommendation(rows,baseline,current){const last=rows[rows.length-1];if(!last?.ready)throw new Error('資料不足');const multiplier=[1,.85,.65,.5][last.stage];const ceiling=Math.round(baseline*multiplier*100)/100;const next=Math.round((current>ceiling?Math.max(ceiling,current-.1):Math.min(ceiling,current+.1))*100)/100;return {stage:last.stage,multiplier,ceiling,next,date:last.date};}
  return {ema,calculate,recommendation};
});
