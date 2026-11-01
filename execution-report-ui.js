(() => {
  'use strict';
  const panel=document.createElement('details');panel.id='betaExecutionHistory';panel.className='strategy-report beta-history-report';
  panel.innerHTML='<summary>調整速度比較（未含高檔防守）</summary><div id="executionReportBody">載入比較結果…</div>';
  document.getElementById('betaHistoryReports').append(panel);
  const pct=n=>(n*100).toFixed(2)+'%',esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const table=rows=>'<div class="table-wrap"><table><thead><tr><th>調整方式</th><th>年化報酬</th><th>最大回撤</th><th>調整次數</th><th>成本／初始本金</th></tr></thead><tbody>'+rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${pct(r.cagr)}</td><td>−${pct(r.maxDrawdown)}</td><td>${r.rebalances}</td><td>${pct(r.costPerInitialCapital)}</td></tr>`).join('')+'</tbody></table></div>';
  fetch('/execution-report.json').then(r=>{if(!r.ok)throw Error();return r.json();}).then(r=>{
    const [slow,fast]=r.train,improvement=(slow.maxDrawdown-fast.maxDrawdown)/slow.maxDrawdown;
    const decision=r.selectedExecution==='fastDown'?'採用快降試行版':'保留雙向分段調整為預設';
    document.getElementById('executionReportBody').innerHTML=`<p>此比較未含新增高檔防守，既有調整方式保留。<br>比較結論：<strong>${decision}</strong>。基準 Beta ${r.baseline.toFixed(2)}，相同的趨勢修復訊號、資產與交易成本。</p><p>前段最大回撤相對改善 ${pct(improvement)}，${r.trainingQualified?'通過':'未達'}事先設定的 5% 門檻。後段及雙倍成本${r.validationPassed?'通過':'未通過'}檢查；仍依完整門檻決定預設，不只挑後段好看的結果。</p><details><summary>查看兩版數據與採用標準</summary><h3>後段比較 ${esc(r.test[0].from)} ～ ${esc(r.test[0].to)}</h3>${table(r.test)}<h3>前段比較 ${esc(slow.from)} ～ ${esc(slow.to)}</h3>${table(r.train)}<h3>後段：雙倍交易成本</h3>${table(r.stress)}<h3>後段：同以 Beta 1.60 起跑</h3>${table(r.initial160)}<p>${esc(r.selectionRule)}</p><p>${esc(r.methodology)}</p><p>單邊成本：買入 0.1925%，賣出 0.2925%，包含手續費、ETF 賣出稅與滑價；不是只比較交易次數。資料 ${esc(r.source)}，共 ${r.observations} 個有效回測交易日，截至 ${esc(r.asOf)}。</p><p>${esc(r.limitations)}</p></details><p class="field-note">上方「Beta 調整方式」可自行選擇快降試行版。切換不會自動採用建議、不會下單，也不會更動你的既有目標或持倉。</p>`;
  }).catch(()=>{document.getElementById('executionReportBody').textContent='比較報告暫時無法載入，維持既有調整設定。';});
})();
