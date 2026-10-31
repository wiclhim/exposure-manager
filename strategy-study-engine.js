'use strict';
const legacy=require('./risk-engine');
const MODELS=[{id:'constant',name:'固定 Beta 1.30'},{id:'legacy',name:'原始 KD／RSI／MACD 防守版'},{id:'trend',name:'MA60／MA200 趨勢版'},{id:'recovery',name:'趨勢防守＋低檔轉強回補'}];
function signals(candles){
  const rows=legacy.calculate(candles),closes=rows.map(r=>r.close);let priorRaw=0,stage=0,improving=0;
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
    const repair=!!(p&&p2&&r.k>r.d&&r.k>p.k&&r.rsi>p.rsi&&r.histogram>p.histogram&&p.histogram>p2.histogram&&r.close>ma20);
    const multipliers=[1,.85,.65,.5];
    // A rebound may restore one level, but never more than the baseline and never during a deep drawdown.
    const recoveryLevel=repair&&r.drawdown>-20?Math.max(0,stage-1):stage;
    return {...r,ma20,ma200,ma60Past,trendStage:stage,recoveryStage:recoveryLevel,trendReasons:reasons,lowCross,repair,studyReady:i>=199,targets:{constant:1,legacy:multipliers[r.stage??0],trend:multipliers[stage],recovery:multipliers[recoveryLevel]}};
  });
}
function clean(data){return new Map(data.filter(r=>r.date&&Number(r.close)>0).map(r=>[r.date,Number(r.close)]));}
function align(index,core,lever){const a=clean(core),b=clean(lever);return signals(index).filter(r=>a.has(r.date)&&b.has(r.date)).map(r=>({...r,core:a.get(r.date),lever:b.get(r.date)}));}
function simulate(rows,id,start,end,baseline=1.3,costScale=1){
  let nav=1,peak=1,maxDrawdown=0,core=0,lever=0,cash=1,lastTrade=-999,beta=0,trades=0,costs=0,turnover=0;const curve=[],months=new Map();
  for(let i=start;i<end;i++){
    const r=rows[i],p=rows[i-1];if(i>start){core*=r.core/p.core;lever*=r.lever/p.lever;nav=core+lever+cash;}
    // A signal from yesterday's completed candle is executed at today's close; it earns returns only tomorrow.
    const desired=baseline*p.targets[id],request=i===start||id==='constant'?baseline:Math.round((beta>desired?Math.max(desired,beta-.1):Math.min(desired,beta+.1))*100)/100;
    if(i-lastTrade>=5 && (i===start||Math.abs((core+2*lever)/nav-request)>=.05)){
      const wl=Math.max(0,request-1),wc=Math.min(1,request),wcore=request>1?1-wl:wc,wcash=Math.max(0,1-wl-wcore);
      const dc=nav*wcore-core,dl=nav*wl-lever;
      const buy=Math.max(0,dc)+Math.max(0,dl),sell=Math.max(0,-dc)+Math.max(0,-dl);
      const fee=costScale*(buy*.001925+sell*.002925);nav=Math.max(0,nav-fee);costs+=fee;turnover+=buy+sell;
      core=nav*wcore;lever=nav*wl;cash=nav*wcash;beta=request;lastTrade=i;trades++;
    }
    peak=Math.max(peak,nav);maxDrawdown=Math.max(maxDrawdown,1-nav/peak);curve.push({date:r.date,value:nav});
    const key=r.date.slice(0,7);if(!months.has(key))months.set(key,{first:curve.length>1?curve[curve.length-2].value:1,last:nav});else months.get(key).last=nav;
  }
  const days=(Date.parse(rows[end-1].date)-Date.parse(rows[start].date))/86400000;
  const cagr=days>0?Math.pow(nav,365.25/days)-1:0;
  const fullMonths=[...months.values()].slice(1,-1);const positive=fullMonths.filter(m=>m.last>m.first).length;
  return {id,name:MODELS.find(m=>m.id===id).name,from:rows[start].date,to:rows[end-1].date,totalReturn:nav-1,cagr,maxDrawdown,calmar:cagr/Math.max(.01,maxDrawdown),positiveMonths:positive,monthCount:fullMonths.length,positiveMonthRate:fullMonths.length?positive/fullMonths.length:null,rebalances:trades,costPerInitialCapital:costs,turnover,curve};
}
function study(index,core,lever){
  const rows=align(index,core,lever),start=rows.findIndex((r,i)=>i>0&&rows[i-1].studyReady),end=rows.length;
  if(start<0||end-start<500)throw new Error('共同有效歷史不足：至少需要 MA200 暖機及 500 個回測交易日');
  const split=start+Math.floor((end-start)*.6);
  const train=MODELS.map(m=>simulate(rows,m.id,start,split));
  const benchmark=train[0];const candidates=train.slice(1).filter(r=>r.cagr>0&&r.maxDrawdown<=benchmark.maxDrawdown*.85);
  const selected=candidates.sort((a,b)=>b.calmar-a.calmar)[0]||train.find(r=>r.id==='recovery');
  const test=MODELS.map(m=>simulate(rows,m.id,split,end));const validation=test.find(r=>r.id===selected.id),reference=test[0];
  const passed=validation.cagr>0&&validation.maxDrawdown<=reference.maxDrawdown&&validation.calmar>=reference.calmar;
  return {baseline:1.3,selectionRule:'先取訓練期年化報酬正值且最大回撤至少比固定 Beta 減少 15% 的候選，再選 Calmar 較高者；無候選時以低檔修復版作觀察，不視為勝出。',trainingQualified:candidates.length>0,selectedId:selected.id,validationPassed:passed,train,test,stress:MODELS.map(m=>simulate(rows,m.id,split,end,1.3,2)),latest:rows.at(-1),observations:end-start,splitDate:rows[split].date,firstDate:rows[0].date,signalLag:'昨日訊號、今日收盤執行、明日起計損益；至少相隔 5 個交易日調整，每次 Beta 最多 0.1。',costs:'買入 0.1925%、賣出 0.2925%（手續費 0.1425%、賣出 ETF 稅 0.1%、單邊滑價 0.05%）；現金利息 0。成本以交易前 NAV 估算。',limitations:'0050／00631L 還原日收盤的近似投組；不是實際持股績效、不是券商成交回測。未計整股取整、現金股利稅及匯率，還原價以資料商定義為準。後段雖未用來挑規則，仍屬歷史驗證，未來可能失效。'};
}
module.exports={MODELS,signals,align,simulate,study};
