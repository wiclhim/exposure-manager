(()=>{'use strict';
  let payload=null,range=30,mobile=window.matchMedia('(max-width:640px)').matches;
  const panel=document.createElement('article');panel.className='panel margin-panel';
  panel.innerHTML='<div class="panel-top"><div><div class="section-label">TAIEX · MARGIN BALANCE</div><h2>上市融資水位</h2></div><button type="button" class="secondary-button small" id="marginRefresh">更新融資</button></div><p id="marginStatus" role="status">正在取得證交所盤後資料…</p><div id="marginContent"></div><p class="margin-note">餘額為上市融資金額，不含上櫃；維持率為全市場整戶擔保維持率，涵蓋上市＋上櫃及融資＋融券，不代表個別帳戶。兩者均為盤後資料，可能分開公布或更正。</p><small>資料來源：<a href="https://www.twse.com.tw/zh/trading/margin/mi-margn.html" target="_blank" rel="noopener noreferrer">證交所信用交易統計</a>、<a href="https://www.twse.com.tw/dashboard/zh/credit/margin.html" target="_blank" rel="noopener noreferrer">臺股儀表板</a> · 僅供觀察，不更動 Beta 規則。</small>';
  document.querySelector('.index-price-panel').insertAdjacentElement('afterend',panel);
  const $=id=>document.getElementById(id),fmt=n=>n==null?'—':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2}),signed=n=>n==null?'—':`${n>0?'+':''}${fmt(n)}`,color=n=>n>0?'#b27865':n<0?'#638977':'#7c8875';
  function inspect(i){const row=payload.data.slice(-range)[i];if(row)$('marginInspect').textContent=`${row.date}｜融資 ${fmt(row.balance)} 億元｜日增減 ${signed(row.change)} 億元｜20 日均線 ${fmt(row.ma20)} 億元｜整戶維持率 ${row.keepRate==null?'未提供':fmt(row.keepRate)+'%'}`;}
  function render(){
    if(!payload)return;
    const all=payload.data,rows=all.slice(-range),s=MarginData.summary(all),last=s.last;
    const stale=(Date.now()-Date.parse(last.date+'T00:00:00+08:00'))/86400000>7;
    const rates=rows.filter(r=>Number.isFinite(r.keepRate)),lastRate=rates.at(-1);
    $('marginStatus').textContent=`融資資料日 ${last.date} · 維持率資料日 ${payload.maintenance?.latest?.date||'暫無資料'}${stale?' · 融資資料已超過 7 天，請留意時效':''}`;
    const values=rows.flatMap(r=>[r.balance,r.ma20]).filter(v=>v!=null),min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.15,1),lo=min-pad,hi=max+pad;
    const chartWidth=mobile?480:900,left=mobile?90:72,right=mobile?460:818,plotWidth=right-left;
    const x=i=>left+i/Math.max(1,rows.length-1)*plotWidth,y=v=>24+(hi-v)/(hi-lo)*180,barMax=Math.max(1,...rows.map(r=>Math.abs(r.change??0))),barY=v=>280-v/barMax*35;
    let svg='<text x="12" y="14">融資餘額（億元）</text>';
    [0,.5,1].forEach(f=>{const v=lo+(hi-lo)*f;svg+=`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e7df"/><text x="${left-8}" y="${y(v)+4}" text-anchor="end">${fmt(v)}</text>`;});
    svg+=`<path d="M ${x(0)} 204 L ${rows.map((r,i)=>`${x(i)} ${y(r.balance)}`).join(' L ')} L ${x(rows.length-1)} 204 Z" fill="#638977" opacity=".09"/><polyline points="${rows.map((r,i)=>`${x(i)},${y(r.balance)}`).join(' ')}" fill="none" stroke="#638977" stroke-width="3"/>`;
    svg+=`<polyline points="${rows.map((r,i)=>r.ma20==null?'':`${x(i)},${y(r.ma20)}`).filter(Boolean).join(' ')}" fill="none" stroke="#b99561" stroke-width="2" stroke-dasharray="6 4"/>`;
    svg+=`<text x="12" y="237">單日增減（億元）</text><line x1="${left}" x2="${right}" y1="280" y2="280" stroke="#cbd3c6"/>`;
    svg+=`<text x="${left-8}" y="252" text-anchor="end">+${fmt(barMax)}</text><text x="${left-8}" y="284" text-anchor="end">0</text><text x="${left-8}" y="319" text-anchor="end">−${fmt(barMax)}</text>`;
    const width=Math.min(16,plotWidth*.74/rows.length);
    rows.forEach((r,i)=>{if(r.change!=null)svg+=`<rect x="${x(i)-width/2}" y="${Math.min(280,barY(r.change))}" width="${width}" height="${Math.max(.6,Math.abs(barY(r.change)-280))}" fill="${color(r.change)}"/>`;});
    svg+='<text x="12" y="356">全市場整戶擔保維持率（%）</text>';
    if(lastRate){
      const low=Math.min(...rates.map(r=>r.keepRate)),high=Math.max(...rates.map(r=>r.keepRate)),padding=Math.max(.5,(high-low)*.15),bottom=low-padding,top=high+padding;
      const rateY=v=>378+(top-v)/(top-bottom)*120;
      svg+=`<text x="${right}" y="356" text-anchor="end" fill="#8c7b9a">${fmt(lastRate.keepRate)}% · ${lastRate.date.slice(5).replace('-','/')}</text>`;
      [0,.5,1].forEach(f=>{const value=bottom+(top-bottom)*f;svg+=`<line x1="${left}" x2="${right}" y1="${rateY(value)}" y2="${rateY(value)}" stroke="#e4e7df"/><text x="${left-8}" y="${rateY(value)+4}" text-anchor="end">${fmt(value)}%</text>`;});
      MarginData.segments(rows,'keepRate').forEach(group=>{
        svg+=`<polyline data-maintenance-line points="${group.map(({row,index})=>`${x(index)},${rateY(row.keepRate)}`).join(' ')}" fill="none" stroke="#8c7b9a" stroke-width="2.8" stroke-linejoin="round"/>`;
        if(group.length===1){const {row,index}=group[0];svg+=`<circle cx="${x(index)}" cy="${rateY(row.keepRate)}" r="3" fill="#8c7b9a"/>`;}
      });
    }else svg+=`<text x="${left}" y="432">${payload.maintenance?.error?'維持率暫時無法取得':'此區間尚無官方維持率資料'}</text>`;
    [...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])].forEach(i=>svg+=`<text x="${x(i)}" y="530" text-anchor="middle">${rows[i].date.slice(5).replace('-','/')}</text>`);
    rows.forEach((r,i)=>svg+=`<rect data-margin-point="${i}" x="${x(i)-plotWidth/2/Math.max(1,rows.length-1)}" y="18" width="${plotWidth/Math.max(1,rows.length-1)}" height="490" fill="transparent"><title>${r.date} · 融資 ${fmt(r.balance)} 億元 · 日增減 ${signed(r.change)} 億元 · 維持率 ${r.keepRate==null?'未提供':fmt(r.keepRate)+'%'}</title></rect>`);
    $('marginContent').innerHTML=`<div class="margin-summary"><div><span>融資餘額</span><strong>${fmt(last.balance)}<small> 億元</small></strong><small>${last.date}</small></div><div><span>單日增減</span><strong style="color:${color(s.dayChange)}">${signed(s.dayChange)}<small> 億元</small></strong><small>${signed(s.dayPercent)}%</small></div><div><span>近 5 個交易日增減</span><strong style="color:${color(s.fiveChange)}">${signed(s.fiveChange)}<small> 億元</small></strong><small>${s.fivePercent==null?'資料不足':signed(s.fivePercent)+'%'}</small></div></div><div class="margin-toolbar"><div class="index-range">${[30,60,90].map(n=>`<button type="button" data-margin-days="${n}" aria-pressed="${range===n}">近 ${n} 日</button>`).join('')}</div><span>${rows[0].date} — ${last.date}</span></div><p id="marginCoverage" class="margin-note">近 ${range} 個交易日：融資餘額 ${rows.length} 筆、維持率 ${rates.length} 筆。${rates.length<rows.length?'維持率官方自 2026/08/03 起提供，缺漏日期留白。':''}${payload.maintenance?.error?' 維持率服務暫時無法取得，請稍後重試。':''}${payload.historyIncomplete||payload.maintenance?.historyIncomplete?' 歷史資料補取未完整，暫顯示已取得部分。':''}</p><div class="margin-chart"><svg viewBox="0 0 ${chartWidth} 545" role="img" aria-label="上市融資餘額、20 日均線、單日增減及全市場整戶擔保維持率趨勢">${svg}</svg></div><div class="margin-legend"><span>綠線：融資餘額</span><span>金色虛線：20 日均線</span><span>柱狀：紅增／綠減</span><span class="maintenance-legend">紫線：全市場整戶維持率</span></div><p id="marginInspect" class="margin-inspect" role="status"></p><p class="margin-note">滑過或點選圖表可查看當日數字。日增減為相鄰資料日餘額之差；近 5 日比較最新與 5 個交易日前。均線不足 20 筆時不繪製。維持率以相同日期對齊，缺資料不補值、不跨缺口連線。</p>`;
    inspect(rows.length-1);
  }
  async function refresh(force=false){
    $('marginRefresh').disabled=true;
    try{
      if(!force){try{const c=JSON.parse(sessionStorage.getItem('exposureMarginCache.v2')||'null');if(c&&c.payload?.version===2&&Date.now()-c.at<(c.payload.maintenance?.error||c.payload.historyIncomplete||c.payload.maintenance?.historyIncomplete?300000:3600000)&&c.payload.data?.length>=2){payload=c.payload;render();return;}}catch{}}
      const response=await fetch('/api/margin?v=2'),data=await response.json();
      if(!response.ok||data.version!==2||!Array.isArray(data.data)||data.data.length<2)throw new Error('融資資料暫時無法取得');
      payload=data;render();try{sessionStorage.setItem('exposureMarginCache.v2',JSON.stringify({at:Date.now(),payload}));}catch{}
    }catch{
      if(payload){render();$('marginStatus').textContent+=' · 本次更新失敗，保留上次資料';}
      else{$('marginStatus').textContent='融資資料暫時無法取得，請稍後按「更新融資」重試。';$('marginContent').textContent='';}
    }finally{$('marginRefresh').disabled=false;}
  }
  panel.addEventListener('click',e=>{const button=e.target.closest('[data-margin-days]');if(button){range=Number(button.dataset.marginDays);render();}const point=e.target.closest('[data-margin-point]');if(point)inspect(Number(point.dataset.marginPoint));});
  panel.addEventListener('pointermove',e=>{const point=e.target.closest('[data-margin-point]');if(point)inspect(Number(point.dataset.marginPoint));});
  $('marginRefresh').addEventListener('click',()=>refresh(true));
  window.matchMedia('(max-width:640px)').addEventListener('change',e=>{mobile=e.matches;render();});refresh();
})();
