'use strict';
const legacy=require('./risk-engine');
const {executionStep}=require('./risk-policy');
const MODELS=[{id:'constant',name:'固定 Beta 1.30'},{id:'legacy',name:'原始 KD／RSI／MACD 防守版'},{id:'trend',name:'MA60／MA200 趨勢版'},{id:'recovery',name:'趨勢防守＋低檔轉強回補'}];
function signals(candles){return require('./risk-policy').decorate(legacy.calculate(candles));}
function clean(data){return new Map(data.filter(r=>r.date&&Number(r.close)>0).map(r=>[r.date,Number(r.close)]));}
function align(index,core,lever){const a=clean(core),b=clean(lever);return signals(index).filter(r=>a.has(r.date)&&b.has(r.date)).map(r=>({...r,core:a.get(r.date),lever:b.get(r.date)}));}
function simulate(rows,id,start,end,baseline=1.3,costScale=1,execution='gradual',initialBeta=baseline){
  let nav=1,peak=1,maxDrawdown=0,core=0,lever=0,cash=1,lastTrade=-999,beta=0,trades=0,costs=0,turnover=0;const curve=[],tradeLog=[],months=new Map();
  for(let i=start;i<end;i++){
    const r=rows[i],p=rows[i-1];if(i>start){core*=r.core/p.core;lever*=r.lever/p.lever;nav=core+lever+cash;}
    // A signal from yesterday's completed candle is executed at today's close; it earns returns only tomorrow.
    const desired=Math.round(baseline*p.targets[id]*100)/100;
    const action=executionStep(beta,desired,execution,i-lastTrade);
    const request=i===start?initialBeta:id==='constant'?baseline:action.next;
    if((i===start||id==='constant'?i-lastTrade>=5:!action.cooldown) && (i===start||Math.abs((core+2*lever)/nav-request)>=.05)){
      const wl=Math.max(0,request-1),wc=Math.min(1,request),wcore=request>1?1-wl:wc,wcash=Math.max(0,1-wl-wcore);
      const dc=nav*wcore-core,dl=nav*wl-lever;
      const buy=Math.max(0,dc)+Math.max(0,dl),sell=Math.max(0,-dc)+Math.max(0,-dl);
      const fee=costScale*(buy*.001925+sell*.002925);nav=Math.max(0,nav-fee);costs+=fee;turnover+=buy+sell;
      tradeLog.push({date:r.date,signalDate:p.date,target:request,previousTarget:beta,daysSinceLast:i-lastTrade});
      core=nav*wcore;lever=nav*wl;cash=nav*wcash;beta=request;lastTrade=i;trades++;
    }
    peak=Math.max(peak,nav);maxDrawdown=Math.max(maxDrawdown,1-nav/peak);curve.push({date:r.date,value:nav});
    const key=r.date.slice(0,7);if(!months.has(key))months.set(key,{first:curve.length>1?curve[curve.length-2].value:1,last:nav});else months.get(key).last=nav;
  }
  const days=(Date.parse(rows[end-1].date)-Date.parse(rows[start].date))/86400000;
  const cagr=days>0?Math.pow(nav,365.25/days)-1:0;
  const fullMonths=[...months.values()].slice(1,-1);const positive=fullMonths.filter(m=>m.last>m.first).length;
  return {id,name:id==='recoveryHeat'?'趨勢修復＋高檔轉弱防守':MODELS.find(m=>m.id===id).name,execution,initialBeta,from:rows[start].date,to:rows[end-1].date,totalReturn:nav-1,cagr,maxDrawdown,calmar:cagr/Math.max(.01,maxDrawdown),positiveMonths:positive,monthCount:fullMonths.length,positiveMonthRate:fullMonths.length?positive/fullMonths.length:null,rebalances:trades,costPerInitialCapital:costs,turnover,curve,tradeLog};
}
function compareOverheat(index,core,lever){
 const rows=align(index,core,lever),start=rows.findIndex((r,i)=>i>0&&rows[i-1].studyReady),end=rows.length;
 if(start<0||end-start<500)throw new Error('共同有效資料不足');
 const split=start+Math.floor((end-start)*.6);
 const run=(from,to,cost=1)=>['gradual','fastDown'].flatMap(execution=>['recovery','recoveryHeat'].map(id=>simulate(rows,id,from,to,1.3,cost,execution)));
 return {policyVersion:require('./risk-policy').POLICY_VERSION,baseline:1.3,train:run(start,split),test:run(split,end),stress:run(split,end,2),observations:end-start,splitDate:rows[split].date,asOf:rows.at(-1).date,
 methodology:'門檻於計算前固定，沒有搜尋或重選參數。同一批加權指數／0050／00631L 日 K、基準 1.30、同初始配置、同成本；前 60% 與後 40% 分開比較，另列雙倍成本。昨日訊號、今日收盤執行、隔日起計損益。雙向分段與快降方式分別比較。',
 limitations:'使用已看過的歷史資料，屬回溯開發檢查，並非全新盲測；新防守規則按需求啟用，不代表通過報酬或回撤勝出門檻。可能提前減碼而錯過強勢行情，亦不能保證降低最大回撤。採分數股與 Beta 1／2 的 ETF 配置近似，非使用者真實持倉績效；未計現金利息、個人稅負與整股限制。'};
}
function compareExecution(index,core,lever){
 const rows=align(index,core,lever),start=rows.findIndex((r,i)=>i>0&&rows[i-1].studyReady),end=rows.length;
 if(start<0||end-start<500)throw new Error('共同有效資料不足');
 const split=start+Math.floor((end-start)*.6);
 const modes=['gradual','fastDown'];
 const run=(from,to,cost=1,initial=1.3)=>modes.map(execution=>({...simulate(rows,'recovery',from,to,1.3,cost,execution,initial),id:execution,name:execution==='fastDown'?'確認後快降、分段回補':'雙向每次 0.10'}));
 const train=run(start,split),test=run(split,end),stress=run(split,end,2),initial160=run(split,end,1,1.6);
 // Fixed before viewing results: require a meaningful drawdown gain without a large return penalty.
 const qualifies=(a,b)=>b.maxDrawdown<=a.maxDrawdown*.95&&b.cagr>=a.cagr-.02;
 const trainingQualified=qualifies(train[0],train[1]);
 const validationPassed=qualifies(test[0],test[1])&&qualifies(stress[0],stress[1]);
 const selectedExecution=trainingQualified&&validationPassed?'fastDown':'gradual';
 return {baseline:1.3,model:'recovery',selectedExecution,trainingQualified,validationPassed,train,test,stress,initial160,observations:end-start,splitDate:rows[split].date,asOf:rows.at(-1).date,
 selectionRule:'快速版須在前 60% 資料將最大回撤相對減少至少 5%，且年化報酬不低於緩調版超過 2 個百分點；後 40% 與雙倍交易成本也須通過同一門檻才採用，否則保留緩調。門檻於計算前固定。',
 methodology:'相同趨勢修復訊號、基準 Beta 1.30、0050／00631L／現金；昨日訊號於今日收盤執行，隔日起計損益；雙方以相同部位起跑並計入建倉成本。緩調版雙向每次最多 0.10、相隔 5 日；快速版向下直接到兩位小數規則值，可略過 5 日冷卻；向上每次 0.10、相隔 5 日。共同保留實際 Beta 與本次目標差距至少 0.05 的交易門檻。',
 limitations:'同一段後期資料先前已看過，並非全新盲測；後段用於否決部署，仍屬回溯開發驗證。不是最優參數搜尋，不代表未來績效。0050／00631L 還原日收盤配置近似不等於實際所有持倉；未計整股限制、現金利息與個人股利稅負，人工採用與實際成交也會改變結果。初始 Beta 1.60 僅為敏感度檢查，不用來選規則。',latest:rows.at(-1)};
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
module.exports={MODELS,signals,align,simulate,study,compareExecution,compareOverheat};
