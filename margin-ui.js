(()=>{'use strict';
  const historyStore=window.exposureMarginHistory;
  const legacyCacheKey='exposureMarginCache.v3';
  let payload=null,range=60,mobile=window.matchMedia('(max-width:640px)').matches,historyVersion=0;
  const panel=document.createElement('article');panel.className='panel margin-panel';
  panel.innerHTML='<div class="panel-top"><div><div class="section-label">TAIEX · MARGIN BALANCE</div><h2>上市櫃融資水位</h2></div><button type="button" class="secondary-button small" id="marginRefresh">更新融資</button></div><p id="marginStatus" role="status">正在取得證交所盤後資料…</p><div id="marginContent"></div><p class="margin-note">融資餘額為上市與上櫃同日金額合計。任一市場缺資料時，該日留白。融資維持率採 FinLab 的上市櫃估算數列。</p><small>資料來源：<a href="https://www.twse.com.tw/zh/trading/margin/mi-margn.html" target="_blank" rel="noopener noreferrer">證交所信用交易統計</a>、<a href="https://www.tpex.org.tw/zh-tw/market-infomation.html" target="_blank" rel="noopener noreferrer">櫃買中心</a>、<a href="https://www.twse.com.tw/zh/trading/historical/mi-index.html" target="_blank" rel="noopener noreferrer">證交所收盤行情</a>、<a href="https://finlab.finance/tools/margin-maintenance-ratio" target="_blank" rel="noopener noreferrer">FinLab 融資維持率</a> · 僅供觀察，不更動 Beta 規則。</small>';
  document.querySelector('.index-price-panel').insertAdjacentElement('afterend',panel);
  const $=id=>document.getElementById(id),fmt=n=>n==null?'—':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2}),signed=n=>n==null?'—':`${n>0?'+':''}${fmt(n)}`,color=n=>n>0?'#b27865':n<0?'#638977':'#7c8875';
  const vix = document.createElement('section');
  vix.className = 'margin-vix';
  vix.setAttribute('aria-labelledby', 'vixHeading');
  vix.innerHTML = '<h3 id="vixHeading">臺指選擇權波動率指數（VIXTWN）</h3><p id="vixReading" class="margin-note" role="status">正在取得期交所收盤資料…</p><div id="vixChart" class="margin-chart"></div><small><a href="https://www.taifex.com.tw/indes/index.aspx" target="_blank" rel="noopener noreferrer">臺灣期貨交易所</a> · 日收盤值（點）</small>';
  $('marginRefresh').textContent = '更新資料';
  $('marginContent').insertAdjacentElement('afterend', vix);
  let vixData = [];
  let vixRows = [];
  let vixFailed = false;

  function visibleRows(rows) {
    const latest=rows.at(-1);
    if(!latest)return [];
    const start=new Date(latest.date+'T00:00:00Z');
    start.setUTCDate(start.getUTCDate()-364);
    const from=start.toISOString().slice(0,10);
    return rows.filter(row=>row.date>=from).slice(-range);
  }

  function inspectVix(index) {
    const row = vixRows[index];
    if (row) $('vixReading').textContent = `${row.date} 收盤 ${fmt(row.close)} 點 · 顯示 ${vixRows.length} 個交易日${vixFailed ? ' · 更新失敗，保留上次資料' : ''}`;
  }

  function renderVix() {
    vixRows = visibleRows(vixData);
    if (!vixRows.length) {
      $('vixChart').replaceChildren();
      if (vixFailed) $('vixReading').textContent = '期交所資料暫時無法取得，可按「更新資料」重試。';
      return;
    }
    const chartWidth = mobile ? 480 : 900;
    const left = mobile ? 90 : 72;
    const right = mobile ? 460 : 818;
    const values = vixRows.map(row => row.close);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const padding = Math.max(1, (high - low) * .12);
    const bottom = Math.max(0, low - padding);
    const top = high + padding;
    const step = (right - left) / Math.max(1, vixRows.length - 1);
    const x = index => left + index * step;
    const y = value => 18 + (top - value) / (top - bottom) * 126;
    const grid = [bottom, (top + bottom) / 2, top].map(value =>
      `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#e4e7df"/><text x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${fmt(value)}</text>`).join('');
    const points = vixRows.map((row, i) => `${x(i)},${y(row.close)}`).join(' ');
    const lastIndex = vixRows.length - 1;
    const labels = [...new Set([0, Math.round(lastIndex / 3), Math.round(lastIndex * 2 / 3), lastIndex])].map(i =>
      `<text x="${x(i)}" y="169" text-anchor="middle">${vixRows[i].date.slice(5).replace('-', '/')}</text>`).join('');
    const hitArea = vixRows.map((row, i) =>
      `<rect data-vix-point="${i}" x="${x(i) - step / 2}" y="8" width="${step}" height="146" fill="transparent"><title>${row.date} · ${fmt(row.close)} 點</title></rect>`).join('');
    $('vixChart').innerHTML = `<svg viewBox="0 0 ${chartWidth} 176" role="img" aria-label="VIXTWN 每日收盤走勢">${grid}<polyline points="${points}" fill="none" stroke="#346f91" stroke-width="2.8" stroke-linejoin="round"/><circle cx="${x(lastIndex)}" cy="${y(vixRows[lastIndex].close)}" r="3.5" fill="#346f91"/>${labels}${hitArea}</svg>`;
    inspectVix(lastIndex);
  }

  function showVix(rows) {
    vixData=rows;
    window.dispatchEvent(new CustomEvent('exposure-vix-close',{detail:rows.at(-1)??null}));
    if(!rows.length)$('vixReading').textContent='尚無 VIXTWN 日線，可按「更新資料」取得。';
    renderVix();
  }
  async function refreshVix(version) {
    try {
      const response = await fetch('/api/vix?v=2');
      if (!response.ok) throw new Error('VIXTWN unavailable');
      const { data } = await response.json();
      if(version!==historyVersion)return;
      if (!Array.isArray(data) || !data.length || !data.every(row =>
        /^\d{4}-\d{2}-\d{2}$/.test(row?.date) && Number.isFinite(row.close) && row.close > 0)) {
        throw new Error('Invalid VIXTWN data');
      }
      vixFailed = false;
      showVix(historyStore.mergeVix(data));
    } catch {
      if(version!==historyVersion)return;
      vixFailed = true;
      renderVix();
    }
  }
  function inspect(i){const row=payload&&visibleRows(payload.data)[i];if(row)$('marginInspect').textContent=`${row.date}｜融資 ${fmt(row.balance)} 億元｜日增減 ${signed(row.change)} 億元｜20 日均線 ${fmt(row.ma20)} 億元｜融資維持率 ${row.financingRate==null?'未提供':fmt(row.financingRate)+'%'}`;}
  function render(){
    if(!payload){
      $('marginStatus').textContent='尚無融資日線，可按「更新資料」取得。';
      $('marginContent').textContent='';
      return;
    }
    const all=payload.data,rows=visibleRows(all),s=MarginData.summary(all),last=s.last;
    const rangeLabel=range===252?'近一年':`近 ${range} 個交易日`;
    const annual=MarginData.annualHigh(all);
    const stale=last&&(Date.now()-Date.parse(last.date+'T00:00:00+08:00'))/86400000>7;
    const rates=rows.filter(r=>Number.isFinite(r.financingRate)),lastRate=rates.at(-1);
    const balanceCount=rows.filter(row=>row.balance!=null).length;
    $('marginStatus').textContent=`融資合計資料日 ${last?.date||'暫無資料'} · 維持率資料日 ${payload.maintenance?.latest?.date||'暫無資料'}${stale?' · 融資資料已超過 7 天，請留意時效':''}`;
    const values=rows.flatMap(r=>[r.balance,r.ma20]).filter(v=>v!=null),min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.15,1),lo=min-pad,hi=max+pad;
    const chartWidth=mobile?480:900,left=mobile?90:72,right=mobile?460:818,plotWidth=right-left;
    const x=i=>left+i/Math.max(1,rows.length-1)*plotWidth,y=v=>24+(hi-v)/(hi-lo)*180,barMax=Math.max(1,...rows.map(r=>Math.abs(r.change??0))),barY=v=>280-v/barMax*35;
    let svg='<text x="12" y="14">上市櫃融資餘額（億元）</text>';
    if (values.length) {
      [0,.5,1].forEach(f=>{const v=lo+(hi-lo)*f;svg+=`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e7df"/><text x="${left-8}" y="${y(v)+4}" text-anchor="end">${fmt(v)}</text>`;});
      for (const [key, stroke, dash] of [['balance','#638977',''], ['ma20','#b99561','6 4']]) {
        for (const group of MarginData.segments(rows, key)) {
          const points = group.map(({row,index})=>`${x(index)},${y(row[key])}`).join(' ');
          if (group.length === 1) {
            const {row,index}=group[0];
            svg+=`<circle cx="${x(index)}" cy="${y(row[key])}" r="3" fill="${stroke}"/>`;
          } else {
            svg+=`<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${key==='balance'?3:2}" stroke-dasharray="${dash}"/>`;
          }
        }
      }
    } else {
      svg+=`<text x="${left}" y="112">尚無同日上市櫃融資餘額</text>`;
    }
    svg+=`<text x="12" y="237">單日增減（億元）</text><line x1="${left}" x2="${right}" y1="280" y2="280" stroke="#cbd3c6"/>`;
    svg+=`<text x="${left-8}" y="252" text-anchor="end">+${fmt(barMax)}</text><text x="${left-8}" y="284" text-anchor="end">0</text><text x="${left-8}" y="319" text-anchor="end">−${fmt(barMax)}</text>`;
    const width=Math.min(16,plotWidth*.74/rows.length);
    rows.forEach((r,i)=>{if(r.change!=null)svg+=`<rect x="${x(i)-width/2}" y="${Math.min(280,barY(r.change))}" width="${width}" height="${Math.max(.6,Math.abs(barY(r.change)-280))}" fill="${color(r.change)}"/>`;});
    svg+='<text x="12" y="356">上市櫃融資維持率（%）</text>';
    if(lastRate){
      const low=Math.min(...rates.map(r=>r.financingRate)),high=Math.max(...rates.map(r=>r.financingRate)),padding=Math.max(.5,(high-low)*.15),bottom=low-padding,top=high+padding;
      const rateY=v=>378+(top-v)/(top-bottom)*120;
      svg+=`<text x="${right}" y="356" text-anchor="end" fill="#8c7b9a">${fmt(lastRate.financingRate)}% · ${lastRate.date.slice(5).replace('-','/')}</text>`;
      [0,.5,1].forEach(f=>{const value=bottom+(top-bottom)*f;svg+=`<line x1="${left}" x2="${right}" y1="${rateY(value)}" y2="${rateY(value)}" stroke="#e4e7df"/><text x="${left-8}" y="${rateY(value)+4}" text-anchor="end">${fmt(value)}%</text>`;});
      MarginData.segments(rows,'financingRate').forEach(group=>{
        svg+=`<polyline data-maintenance-line points="${group.map(({row,index})=>`${x(index)},${rateY(row.financingRate)}`).join(' ')}" fill="none" stroke="#8c7b9a" stroke-width="2.8" stroke-linejoin="round"/>`;
        if(group.length===1){const {row,index}=group[0];svg+=`<circle cx="${x(index)}" cy="${rateY(row.financingRate)}" r="3" fill="#8c7b9a"/>`;}
      });
    }else svg+=`<text x="${left}" y="432">${payload.maintenance?.error?'維持率暫時無法取得':'此區間尚無融資維持率資料'}</text>`;
    [...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])].forEach(i=>svg+=`<text x="${x(i)}" y="530" text-anchor="middle">${rows[i].date.slice(5).replace('-','/')}</text>`);
    rows.forEach((r,i)=>svg+=`<rect data-margin-point="${i}" x="${x(i)-plotWidth/2/Math.max(1,rows.length-1)}" y="18" width="${plotWidth/Math.max(1,rows.length-1)}" height="490" fill="transparent"><title>${r.date} · 融資 ${fmt(r.balance)} 億元 · 日增減 ${signed(r.change)} 億元 · 維持率 ${r.financingRate==null?'未提供':fmt(r.financingRate)+'%'}</title></rect>`);
    $('marginContent').innerHTML=`<div class="margin-summary"><div><span>融資餘額</span><strong>${fmt(last?.balance)}<small> 億元</small></strong><small>${last?`上市 ${fmt(last.listedBalance)} ＋ 上櫃 ${fmt(last.otcBalance)}`:"等待合計資料"}</small></div><div><span>單日增減</span><strong style="color:${color(s.dayChange)}">${signed(s.dayChange)}<small> 億元</small></strong><small>上市 ${signed(s.listedDayChange)} 億元<br>上櫃 ${signed(s.otcDayChange)} 億元</small><small>${s.dayPercent==null?'資料不足':signed(s.dayPercent)+'%'}</small></div><div><span>近 5 個交易日增減</span><strong style="color:${color(s.fiveChange)}">${signed(s.fiveChange)}<small> 億元</small></strong><small>${s.fivePercent==null?'資料不足':signed(s.fivePercent)+'%'}</small></div><div><span>距近一年最高餘額</span><strong id="marginYearDistance">${annual.distance==null?'—':annual.distance.toFixed(2)+'%'}</strong><small id="marginYearHigh">${annual.high?`最高 ${fmt(annual.high.balance)} 億元<br>${annual.high.date}`:'等待完整近一年資料'}</small></div></div><div class="margin-toolbar"><div class="index-range">${[60,120,252].map(n=>`<button type="button" data-margin-days="${n}" aria-pressed="${range===n}">${n===252?'近一年':`近 ${n} 日`}</button>`).join('')}</div><span>${rows[0].date} — ${rows.at(-1).date}</span></div><p id="marginCoverage" class="margin-note">${rangeLabel}：融資合計 ${balanceCount} 筆、維持率 ${rates.length} 筆。${annual.complete?'':' 近一年融資餘額資料未齊，暫無高點比較。'}${balanceCount<rows.length?' 缺少同日上市或上櫃資料的日期留白。':''}${payload.otcError?' 櫃買中心暫時無法重新查詢，顯示已取得資料。':''}${rates.length<rows.length?'未取得的融資維持率日期留白。':''}${payload.maintenance?.error?' 維持率本次更新失敗，顯示已儲存資料。':''}${payload.historyIncomplete||payload.maintenance?.historyIncomplete?' 歷史資料補取未完整，暫顯示已取得部分。':''}</p><div class="margin-chart"><svg viewBox="0 0 ${chartWidth} 545" role="img" aria-label="上市櫃融資餘額、20 日均線、單日增減及上市櫃融資維持率（FinLab 估算）趨勢">${svg}</svg></div><div class="margin-legend"><span>綠線：融資餘額</span><span>金色虛線：20 日均線</span><span>柱狀：紅增／綠減</span><span class="maintenance-legend">紫線：上市櫃融資維持率（FinLab 估算）</span></div><p id="marginInspect" class="margin-inspect" role="status"></p><p class="margin-note">滑過或點選圖表可查看當日數字。日增減為相鄰資料日餘額之差；近 5 日比較最新與 5 個交易日前。近一年高點採最新資料日往前 364 日的最高融資合計。均線不足 20 筆時不繪製。融資維持率採 FinLab 的同一來源歷史序列，以融資股票市值除以上市櫃融資金額估算。缺少的日期留白。</p>`;
    inspect(rows.length-1);
  }
  function renderMargin(rows, metadata={}) {
    const data=rows.map(row=>({...row,financingRate:row.financingSource==='FinLab'?row.financingRate:null}));
    const latest=data.findLast(row=>Number.isFinite(row.financingRate));
    payload=data.length?{...metadata,data,maintenance:{...metadata.maintenance,latest}}:null;
    render();
  }
  async function refresh(version){
    try{
      const response=await fetch('/api/margin?v=6'),data=await response.json();
      if(version!==historyVersion)return;
      if(!response.ok||data.version!==6||!Array.isArray(data.data)||data.data.length<2)throw new Error('融資資料暫時無法取得');
      renderMargin(historyStore.mergeMargin(data.data),data);
    }catch{
      if(version!==historyVersion)return;
      if(payload){render();$('marginStatus').textContent+=' · 本次更新失敗，保留上次資料';}
      else{$('marginStatus').textContent='融資資料暫時無法取得，請稍後按「更新資料」重試。';$('marginContent').textContent='';}
    }
  }
  async function refreshCharts(force = false) {
    const button = $('marginRefresh');
    const version=historyVersion, due=MarketQuotes.expectedClosingDay();
    const latestMargin=payload?.data.at(-1);
    const updateMargin=force||!latestMargin||latestMargin.date<due||latestMargin.balance==null||latestMargin.financingRate==null||!MarginData.annualHigh(payload.data).complete;
    const updateVix=force||vixData.length<120||vixData.at(-1).date<due;
    if(!updateMargin&&!updateVix)return;
    button.disabled = true;
    try {
      await Promise.all([updateMargin?refresh(version):null,updateVix?refreshVix(version):null]);
    }
    finally { button.disabled = false; }
  }
  panel.addEventListener('click',e=>{const button=e.target.closest('[data-margin-days]');if(button){range=Number(button.dataset.marginDays);render();renderVix();}const point=e.target.closest('[data-margin-point]');if(point)inspect(Number(point.dataset.marginPoint));});
  panel.addEventListener('pointermove',e=>{const point=e.target.closest('[data-margin-point]');if(point)inspect(Number(point.dataset.marginPoint));});
  function selectVixPoint(event) {
    const point = event.target.closest('[data-vix-point]');
    if (point) inspectVix(Number(point.dataset.vixPoint));
  }
  vix.addEventListener('click', selectVixPoint);
  vix.addEventListener('pointermove', selectVixPoint);
  $('marginRefresh').addEventListener('click',()=>refreshCharts(true));
  window.matchMedia('(max-width:640px)').addEventListener('change',e=>{mobile=e.matches;render();renderVix();});
  function showSavedHistory() {
    vixFailed=false;
    renderMargin(historyStore.readMargin());
    showVix(historyStore.readVix());
  }
  window.addEventListener('exposure-market-history-changed',()=>{
    historyVersion++;
    showSavedHistory();
  });
  try {
    const cached=JSON.parse(sessionStorage.getItem(legacyCacheKey)||'null');
    if(!historyStore.readMargin().length&&cached?.payload?.version===3&&Array.isArray(cached.payload.data)){
      historyStore.mergeMargin(cached.payload.data);
    }
    sessionStorage.removeItem(legacyCacheKey);
  }catch{}
  showSavedHistory();
  refreshCharts();
})();
