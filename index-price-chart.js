(()=>{'use strict';let all=[],months=1,live=window.exposureIndexQuote?.();const panel=document.createElement('article');panel.className='panel market-panel index-price-panel';panel.innerHTML='<div class="panel-top"><div><div class="section-label">TAIEX MARKET LEVEL</div><h2>加權指數市場水位</h2></div><span class="subtle-pill">近一年最高收盤基準</span></div><div id="indexPriceSummary" class="index-price-summary">等待已收盤指數資料…</div><div class="market-chart-toolbar"><div id="indexPriceRanges">'+[1,3,6,12].map(n=>`<button data-months="${n}">${n===12?'1Y':n+'M'}</button>`).join('')+'</div><span id="indexPriceDates"></span></div><div id="indexPriceSvg" class="market-chart"></div><div class="market-chart-legend"><span>🟩 正常：回檔 10% 以內</span><span>🟨 觀察：回檔 10～20%</span><span>🟥 股災：回檔 20% 以上</span></div><p id="indexKdContext" class="index-kd-context"></p><small>目前指數與曲線最後一點隨永豐 Shioaji 更新。歷史日線由證交所提供，當日收盤與 Beta 建議優先使用永豐收盤報價。</small>';
document.querySelector('#page-overview .overview-grid').append(panel);
const fmt=n=>Number(n).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const latestQuote = last => live?.price > 0 && (!last || !live.date || live.date >= last.date) ? live : null;
function renderSummary(){
 const last=all.at(-1),highRow=all.reduce((best,row)=>!best||row.close>best.close?row:best,null);
 const quote=latestQuote(last);
 const price=quote?.price??last?.close,high=highRow?.close,distance=price>0&&high>0?(price/high-1)*100:null;
 const zone=distance==null?'等待歷史高點':distance>=0?'已達／超過高點':distance<=-20?'股災區間':distance<=-10?'觀察區間':'正常區間';
 document.getElementById('indexPriceSummary').innerHTML=`<div><span>距近一年最高收盤</span><strong>${distance==null?'—':distance.toFixed(2)+'%'}</strong><small>${zone}</small></div><div><span>${quote?'目前指數':'最新收盤指數'}</span><strong>${price?fmt(price):'—'}</strong><small>${quote?esc(quote.time)+' · '+esc(quote.source||'報價'):esc(last?.date||'等待報價')}</small></div><div><span>近一年最高收盤</span><strong>${high?fmt(high):'—'}</strong><small>${esc(highRow?.date||'')}</small></div>`;
}
function render(){
 if(all.length<2){renderSummary();return;}
 const last=all.at(-1),previous=all.at(-2),high=Math.max(...all.map(r=>r.close));
 const quote=latestQuote(last);
 let plot=all;
 if(quote?.date && Number.isFinite(Date.parse(quote.date+'T00:00:00Z'))){
   plot=[...all.filter(row=>row.date!==quote.date),{date:quote.date,close:quote.price,isQuote:true}];
 }
 const lastPlotted=plot.at(-1),cutoff=new Date(lastPlotted.date+'T00:00:00Z');
 cutoff.setUTCMonth(cutoff.getUTCMonth()-months);
 const rows=plot.filter(r=>r.date>=cutoff.toISOString().slice(0,10));
 const ratios=rows.map(r=>r.close/high);
 const floor=Math.min(.7,...ratios)-.015,ceiling=Math.max(1,...ratios)+.025;
 const x=i=>78+i/Math.max(1,rows.length-1)*744,y=v=>22+(ceiling-v)/(ceiling-floor)*298;
renderSummary();
let svg=[[1,.9,'#dce8df','正常'],[.9,.8,'#eee2c5','觀察'],[.8,floor,'#ecd2d2','股災']].map(([a,b,color,label])=>`<rect x="12" y="${y(a)}" width="876" height="${y(b)-y(a)}" fill="${color}"/><text x="23" y="${y(a)+39}">${label}</text>`).join('');
[1,.9,.8].forEach(v=>svg+=`<line x1="78" x2="822" y1="${y(v)}" y2="${y(v)}" stroke="#8994a0" stroke-dasharray="6 6"/><text x="23" y="${y(v)+17}">${Math.round((v-1)*100)}%</text><text x="878" y="${y(v)+17}" text-anchor="end">${fmt(high*v)}</text>`);
svg+=`<polyline points="${rows.map((r,i)=>`${x(i)},${y(r.close/high)}`).join(' ')}" fill="none" stroke="#334155" stroke-width="2.8" stroke-linejoin="round"/>`;
rows.forEach((r,i)=>svg+=`<circle cx="${x(i)}" cy="${y(r.close/high)}" r="8" fill="transparent"><title>${esc(r.date)} · ${fmt(r.close)} 點 · 距高點 ${((r.close/high-1)*100).toFixed(2)}%${r.isQuote?' · 永豐報價':''}</title></circle>`);
svg+=`<circle cx="${x(rows.length-1)}" cy="${y(lastPlotted.close/high)}" r="5" fill="#70877b" stroke="white" stroke-width="2"/>`;
[...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])].forEach(i=>svg+=`<text x="${x(i)}" y="345" text-anchor="middle">${rows[i].date.slice(5).replace('-','/')}</text>`);
document.getElementById('indexPriceSvg').innerHTML=`<svg viewBox="0 0 900 360" role="img" aria-label="加權指數最近 ${months} 個月走勢與回檔區間">${svg}</svg>`;
document.getElementById('indexPriceDates').textContent=`${rows[0].date} — ${lastPlotted.date}`;
panel.querySelectorAll('[data-months]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.months)===months);b.setAttribute('aria-pressed',String(Number(b.dataset.months)===months));});
const low=last.k<20&&last.d<20,golden=previous.k<=previous.d&&last.k>last.d&&Math.min(previous.k,previous.d)<20,recover=last.k>last.d&&last.k>previous.k&&last.rsi>previous.rsi&&last.histogram>previous.histogram;
document.getElementById('indexKdContext').textContent=golden?'KD 低檔黃金交叉：可列回補觀察，但單日交叉仍可能失敗，請等 RSI 與 MACD 改善及多日確認。':low?'KD 低檔：可能超賣，也可能弱勢鈍化；低數值本身不是提高 Beta 的充分條件。':recover?'短線修復觀察：K 在 D 上方且上升、RSI 回升、MACD 柱改善；依原規則確認後逐步恢復至基準 Beta 1.30，不因單日訊號追高。':'KD 與趨勢需一起判讀；目前尚未同時符合 K 上升且高於 D、RSI 回升、MACD 柱改善的短線修復條件。';
}
panel.addEventListener('click',e=>{const b=e.target.closest('[data-months]');if(b){months=Number(b.dataset.months);render();}});
window.addEventListener('exposure-index-data',e=>{all=e.detail;render();});
window.addEventListener('exposure-index-quote',e=>{live=e.detail;render();});
renderSummary();
})();
