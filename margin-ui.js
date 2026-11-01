(()=>{'use strict';
  let payload=null,range=20,mobile=window.matchMedia('(max-width:640px)').matches;
  const panel=document.createElement('article');panel.className='panel margin-panel';
  panel.innerHTML='<div class="panel-top"><div><div class="section-label">TAIEX · MARGIN BALANCE</div><h2>上市融資水位</h2></div><button type="button" class="secondary-button small" id="marginRefresh">更新融資</button></div><p id="marginStatus" role="status">正在取得證交所盤後融資資料…</p><div id="marginContent"></div><p class="margin-note">上市市場融資金額，不含上櫃。盤後公布，可能晚於上方指數日線；數字可能經證交所更正。融資增加代表借款部位增加，增減本身不等同買賣訊號。</p><small>資料來源：<a href="https://www.twse.com.tw/zh/trading/margin/mi-margn.html" target="_blank" rel="noopener noreferrer">臺灣證券交易所信用交易統計</a> · 僅供觀察，不更動 Beta 規則。</small>';
  document.querySelector('.index-price-panel').insertAdjacentElement('afterend',panel);
  const $=id=>document.getElementById(id),fmt=n=>n==null?'—':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2}),signed=n=>n==null?'—':`${n>0?'+':''}${fmt(n)}`,color=n=>n>0?'#b27865':n<0?'#638977':'#7c8875';
  function inspect(i){const row=payload.data.slice(-range)[i];if(row)$('marginInspect').textContent=`${row.date}｜融資 ${fmt(row.balance)} 億元｜日增減 ${signed(row.change)} 億元｜20 日均線 ${fmt(row.ma20)} 億元`;}
  function render(){
    if(!payload)return;
    const all=payload.data,rows=all.slice(-range),s=MarginData.summary(all),last=s.last;
    const stale=(Date.now()-Date.parse(last.date+'T00:00:00+08:00'))/86400000>7;
    $('marginStatus').textContent=`資料日 ${last.date} · 盤後融資餘額 · ${all.length} 個交易日資料${stale?' · 資料已超過 7 天，請留意時效':''}`;
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
    [...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])].forEach(i=>svg+=`<text x="${x(i)}" y="342" text-anchor="middle">${rows[i].date.slice(5).replace('-','/')}</text>`);
    rows.forEach((r,i)=>svg+=`<rect data-margin-point="${i}" x="${x(i)-plotWidth/2/Math.max(1,rows.length-1)}" y="18" width="${plotWidth/Math.max(1,rows.length-1)}" height="302" fill="transparent"><title>${r.date} · 融資 ${fmt(r.balance)} 億元 · 日增減 ${signed(r.change)} 億元</title></rect>`);
    $('marginContent').innerHTML=`<div class="margin-summary"><div><span>融資餘額</span><strong>${fmt(last.balance)}<small> 億元</small></strong><small>${last.date}</small></div><div><span>單日增減</span><strong style="color:${color(s.dayChange)}">${signed(s.dayChange)}<small> 億元</small></strong><small>${signed(s.dayPercent)}%</small></div><div><span>近 5 個交易日增減</span><strong style="color:${color(s.fiveChange)}">${signed(s.fiveChange)}<small> 億元</small></strong><small>${s.fivePercent==null?'資料不足':signed(s.fivePercent)+'%'}</small></div></div><div class="margin-toolbar"><div class="index-range">${[20,40,60].map(n=>`<button type="button" data-margin-days="${n}" aria-pressed="${range===n}" ${all.length<n?'disabled':''}>近 ${n} 日</button>`).join('')}</div><span>${rows[0].date} — ${last.date}</span></div><div class="margin-chart"><svg viewBox="0 0 ${chartWidth} 355" role="img" aria-label="上市融資餘額、20 日均線及單日增減，單位億元">${svg}</svg></div><div class="margin-legend"><span>綠線：融資餘額</span><span>金色虛線：20 日均線</span><span>柱狀：紅增／綠減</span></div><p id="marginInspect" class="margin-inspect" role="status"></p><p class="margin-note">滑過或點選圖表可查看當日數字。日增減為相鄰資料日餘額之差；近 5 日比較最新與 5 個交易日前。均線不足 20 筆時不繪製。</p>`;
    inspect(rows.length-1);
  }
  async function refresh(force=false){
    $('marginRefresh').disabled=true;
    try{
      if(!force){try{const c=JSON.parse(sessionStorage.getItem('exposureMarginCache')||'null');if(c&&Date.now()-c.at<3600000&&c.payload?.data?.length>=2){payload=c.payload;render();return;}}catch{}}
      const response=await fetch('/api/margin'),data=await response.json();
      if(!response.ok||!Array.isArray(data.data)||data.data.length<2)throw new Error('融資資料暫時無法取得');
      payload=data;render();try{sessionStorage.setItem('exposureMarginCache',JSON.stringify({at:Date.now(),payload}));}catch{}
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
