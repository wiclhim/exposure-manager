(()=>{
  'use strict';
  const KEY='exposureIndexRisk.v1';
  let config;try{config=JSON.parse(localStorage.getItem(KEY)||'{}');}catch{config={};}
  let payload=null,range=60;
  if(config.baselinePreset!=='1.30'){config.baseline=1.3;config.baselinePreset='1.30';localStorage.setItem(KEY,JSON.stringify(config));}
  const panel=document.createElement('article');panel.className='panel index-signals-panel';
  panel.innerHTML='<div class="panel-top"><div><div class="section-label">TAIEX · BETA GUIDE</div><h2>Beta 調整建議</h2></div><button class="secondary-button small" id="indexSignalsRefresh">更新日線</button></div><p id="indexSignalsStatus">正在取得已收盤日 K…</p><div id="indexSignalsContent"></div><details id="betaHistoryDetails" class="beta-fold"><summary>歷史驗證與比較</summary><p class="beta-note">試行規則可能增加交易成本、錯過漲幅，歷史結果不保證未來績效。</p><div id="betaHeatComparison"></div><div id="betaHistoryReports"></div></details>';
  document.querySelector('#page-overview .overview-grid').append(panel);
  const $=id=>document.getElementById(id),fmt=value=>value==null?'—':Number(value).toFixed(2),escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function save(){localStorage.setItem(KEY,JSON.stringify(config));}
  function chart(rows,keys,colors,limits){
    const valid=rows.flatMap(r=>keys.map(k=>r[k])).filter(v=>v!=null);if(!valid.length)return '';
    let min=limits?limits[0]:Math.min(...valid,0),max=limits?limits[1]:Math.max(...valid,0);const padding=(max-min||1)*.1;if(!limits){min-=padding;max+=padding;}
    const x=i=>45+i/Math.max(1,rows.length-1)*690,y=v=>18+(max-v)/(max-min||1)*140;
    let svg=[0,.5,1].map(f=>{const v=min+(max-min)*f;return `<line x1="45" x2="735" y1="${y(v)}" y2="${y(v)}" stroke="#e2e6dc"/><text x="40" y="${y(v)+4}" text-anchor="end">${v.toFixed(0)}</text>`;}).join('');
    keys.forEach((key,j)=>{if(key==='histogram'){rows.forEach((r,i)=>{if(r[key]!=null)svg+=`<rect x="${x(i)-2}" y="${Math.min(y(0),y(r[key]))}" width="4" height="${Math.max(1,Math.abs(y(r[key])-y(0)))}" fill="${r[key]>=0?'#789b87':'#c38c84'}"/>`;});}else svg+=`<polyline points="${rows.map((r,i)=>r[key]==null?'':`${x(i)},${y(r[key])}`).filter(Boolean).join(' ')}" fill="none" stroke="${colors[j]}" stroke-width="2"/>`;});
    [0,rows.length-1].forEach(i=>svg+=`<text x="${x(i)}" y="181" text-anchor="${i?'end':'start'}">${rows[i].date}</text>`);
    return `<svg viewBox="0 0 760 190" role="img" aria-label="${keys.join('、')} 最近 ${rows.length} 個交易日走勢">${svg}</svg>`;
  }
  function render(){
    if(!payload)return;
    const openDetails=new Map([...panel.querySelectorAll('details[id]')].map(el=>[el.id,el.open]));
    const all=RiskPolicy.decorate(payload.data),last=all.at(-1),rows=all.slice(-range),current=Number(window.exposureRiskBridge?.getTarget()??1),base=Number(config.baseline??1.3);
    const appliedIndex=all.findIndex(row=>row.date===config.appliedDate),daysSinceApplied=appliedIndex>=0?all.length-1-appliedIndex:Infinity;
    const execution=config.execution==='fastDown'?'fastDown':'gradual',model=config.model||'recovery';
    const advice=RiskPolicy.recommendation(all,base,current,model,execution,daysSinceApplied,config.overheatEnabled!==false);
    const stale=(Date.now()-Date.parse(last.date+'T00:00:00+08:00'))/86400000>7,cooldown=advice.cooldown;
    const heat=advice.heat,heatActive=advice.overheatEnabled&&heat.level>0,repair=model==='recovery'&&last.repair&&last.drawdown>-20;
    const state=heatActive?'高檔轉弱防守':advice.multiplier<1?'趨勢防守中':repair?'低檔修復中':heat.hot||heat.raw?'過熱觀察中':'趨勢平穩';
    const action=advice.direction==='hold'?'維持目標':advice.direction==='decrease'?'建議降低目標':'建議提高目標';
    const actionText=advice.direction==='hold'?'目前目標已等於規則參考值。':advice.direction==='decrease'&&execution==='fastDown'?'向下直接到規則參考值；同一日線不重複採用。':`本次${advice.direction==='increase'?'增加':'降低'}最多 0.10，相隔至少 5 個交易日。`;
    const notice=stale?'日線資料已超過 7 天，暫停採用建議。':cooldown?(daysSinceApplied===0?'同一日線已採用，暫停重複調整。':'距上次採用不足 5 個交易日，暫停本次調整。'):'採用只更新目標 Beta；持倉請到再平衡頁確認。';
    const reasons=advice.reasons.length?advice.reasons.map(escape).join('；'):'目前未符合轉弱防守條件。';
    window.dispatchEvent(new CustomEvent('exposure-index-data',{detail:all}));
    $('indexSignalsStatus').textContent=`${last.date} 已收盤 · ${payload.name} ${fmt(last.close)} 點 · ${payload.source}`;
    $('indexSignalsContent').innerHTML=`
      <section class="beta-unified" aria-label="整合 Beta 建議">
        <div class="beta-unified-heading"><h3>${action}</h3><span class="beta-state ${advice.multiplier<1?'defensive':''}">${state}</span></div>
        <div class="beta-targets"><div><span>目前目標</span><strong>${fmt(current)}</strong></div><span class="beta-target-arrow" aria-hidden="true">→</span><div><span>本次建議</span><strong>${fmt(advice.next)}</strong></div></div>
        <p class="beta-reference">規則參考 <strong>${fmt(advice.ceiling)}</strong> ＝ 基準 ${fmt(base)} × ${(advice.multiplier*100).toFixed(0)}%</p>
        <p class="beta-reasons">${reasons}</p>
        <div class="beta-signal-states"><div><span>${model==='legacy'?'原始防守':'趨勢防守'}</span><strong>${advice.stage} / 3 級</strong></div><div><span>高檔防守</span><strong>${advice.overheatEnabled?heat.level+' / 2 級':'已關閉'}</strong></div><div><span>低檔修復</span><strong>${model!=='recovery'?'未啟用':repair?'條件符合':'等待轉強'}</strong></div></div>
        <p class="beta-action-note">${actionText}</p>
        <button class="primary-button" id="indexApplyBeta" ${stale||cooldown||Math.abs(current-advice.next)<.005?'disabled':''}>採用建議 Beta ${fmt(advice.next)}</button>
        <p class="beta-note" role="status">${notice}</p>
      </section>
      <p class="beta-note beta-trial-note">趨勢、高檔與低檔訊號已合併；兩種防守取較低上限。試行規則可能增加交易、錯過漲幅，歷史比較未證明一定更好。</p>
      <details id="betaSettingsDetails" class="beta-fold"><summary>設定與規則</summary>
        <div class="beta-settings-grid"><label>基準 Beta<input id="indexBaseline" type="number" min="0" max="5" step="0.1" value="${base}"></label><label>Beta 調整方式<select id="indexExecutionMode" aria-label="Beta 調整方式"><option value="gradual">雙向分段調整（預設）</option><option value="fastDown">確認後快降、分段回補（試行）</option></select></label><label>趨勢與修復策略<select id="indexPolicyModel"><option value="recovery">趨勢防守＋低檔轉強回補（試行）</option><option value="trend">MA60／MA200 趨勢版</option><option value="legacy">原始防守版</option></select></label><label class="heat-toggle"><input id="indexOverheatEnabled" type="checkbox" ${advice.overheatEnabled?'checked':''}>加入高檔轉弱防守（試行）</label></div>
        <p class="beta-note">設定沿用此瀏覽器的選擇；更改設定不會直接改動目標或持倉。</p>
        <details id="betaRulesDetails" class="beta-nested-fold"><summary>完整判斷規則與限制</summary>
          <h4>趨勢防守與低檔修復</h4><p>收盤低於 MA60 為 1 級，低於 MA200 為 2 級，低於 MA200 且 MA60 低於 5 日前為 3 級；近 252 筆最高收盤回檔達 20% 亦為 3 級。轉弱連續 2 日確認，改善連續 3 日逐級恢復，對應基準 Beta 的 100%／85%／65%／50%。</p>
          <p>低檔修復需最近 10 日 K 曾低於 30，且 K 高於 D 並上升、RSI 上升、MACD 柱連續兩日改善、收盤回到 MA20 之上，並未回檔達 20%，才暫時回補一級。低 KD 本身不加碼，回補不越過高檔防守上限。</p>
          ${ExposureOverheatUI.rules()}
          <h4>調整方式與原始策略</h4><p>分段模式雙向每次最多 0.10、相隔 5 個交易日；快降模式向下直接到規則參考值，可略過五日冷卻，向上仍每次最多 0.10、相隔 5 日。同一日線不重複採用。</p>
          <p>原始防守版：K &lt; D 且 K &lt; 50、RSI &lt; 45、DIF &lt; 0 且 MACD 柱 &lt; 0 各一分；低於 MA60 至少 2 級，近一年收盤回檔達 20% 為 3 級。同樣經 2 日轉弱與 3 日改善確認。</p>
          <p>KD(9,3,3) 起始 50，RSI14 採 Wilder 平滑，MACD(12,26,9) 柱為 DIF−訊號、不乘 2。採已收盤日線，資料超過 7 天停用。採用僅更改目標、不會下單；請檢查原形比例與可達 Beta。策略設定存在此瀏覽器，不包含於投組備份。</p>
        </details>
      </details>
      <details id="betaIndicatorsDetails" class="beta-fold"><summary>查看指標與判斷依據</summary>
        ${ExposureOverheatUI.render(advice,base,last)}
        <div class="index-range"><button data-days="60">近 60 日</button><button data-days="120">近 120 日</button><button data-days="252">近一年</button></div>
        <div class="index-indicators"><section><h3>KD(9,3,3) <small>K ${fmt(last.k)} ／ D ${fmt(last.d)}</small></h3><p>綠線 K · 褐線 D${last.k<last.d?' · K 位於 D 下方':' · K 位於 D 上方'}</p>${chart(rows,['k','d'],['#638977','#b99561'],[0,100])}</section><section><h3>RSI(14) <small>${fmt(last.rsi)}</small></h3><p>Wilder 平滑</p>${chart(rows,['rsi'],['#789281'],[0,100])}</section><section><h3>MACD(12,26,9)</h3><p>DIF ${fmt(last.dif)} · 訊號 ${fmt(last.signal)} · 柱 ${fmt(last.histogram)}</p>${chart(rows,['histogram','dif','signal'],['','#628a78','#b99561'])}</section></div>
      </details>`;
    $('betaHeatComparison').innerHTML=ExposureOverheatUI.comparison(execution);
    panel.querySelectorAll('[data-days]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.days)===range)));
    for(const [id,open] of openDetails){const el=$(id);if(el)el.open=open;}
    $('indexOverheatEnabled').addEventListener('change',e=>{config.overheatEnabled=e.target.checked;save();render();});
    $('indexExecutionMode').value=execution;
    $('indexExecutionMode').addEventListener('change',e=>{config.execution=e.target.value;save();render();});
    $('indexPolicyModel').value=model;
    $('indexPolicyModel').addEventListener('change',e=>{config.model=e.target.value;save();render();});
    $('indexBaseline').addEventListener('change',e=>{const v=Number(e.target.value);if(Number.isFinite(v)&&v>=0&&v<=5){config.baseline=v;save();render();}});
    $('indexApplyBeta').addEventListener('click',()=>{if(stale||cooldown)return;config.baseline=base;window.exposureRiskBridge.setTarget(advice.next);config.appliedDate=last.date;save();render();});
  }
  async function refresh(force=false){
    $('indexSignalsRefresh').disabled=true;
    try{
      if(!force){const cached=JSON.parse(sessionStorage.getItem('exposureIndexCache')||'null');if(cached&&Date.now()-cached.at<3600000){payload=cached.payload;render();return;}}
      const response=await fetch('/api/index-signals'),data=await response.json();if(!response.ok)throw new Error(data.error||'讀取失敗');
      payload=data;sessionStorage.setItem('exposureIndexCache',JSON.stringify({at:Date.now(),payload}));render();
    }catch(e){$('indexSignalsStatus').textContent=`加權指數更新失敗：${e.message}。暫不產生新建議。`;$('indexSignalsContent').innerHTML='';}
    finally{$('indexSignalsRefresh').disabled=false;}
  }
  panel.addEventListener('click',e=>{const b=e.target.closest('[data-days]');if(b){range=Number(b.dataset.days);render();}});
  $('indexSignalsRefresh').addEventListener('click',()=>refresh(true));
  window.addEventListener('exposure-target-changed',render);
  window.addEventListener('exposure-overheat-report-ready',()=>{if(payload)render();});refresh();
})();
