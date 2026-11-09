(() => {
  'use strict';
  const STORE_KEY = 'exposureManager.v1';
  const defaults = {
    holdings: [], cash: 0, history: [], quoteCache: {}, marketHistory: null, holdingHighs: {},
    settings: { targetBeta: 1, tolerance: 10, target: { lever: 20, core: 60, cash: 20 }, refreshSeconds: 60, benchmark: '0050' }
  };
  let isRefreshing = false;
  let quoteTimer = null;
  let marketStream = null;
  let marketStreamKey = '';
  let marketFrame = null;
  const liveMarketQuotes = new Map();
  let swapSymbolDebounce = null;
  const SHIOAJI_STORE = 'exposureShioajiLocal.v1';
  const SHIOAJI_REMOTE_STORE = 'exposureShioajiRemote.v1';
  const SHIOAJI_NGROK_STORE = 'exposureShioajiNgrok.v1';
  const SHIOAJI_LOCAL = 'http://127.0.0.1:8765';
  const SHIOAJI_NGROK = 'https://sandbag-wok-skied.ngrok-free.dev/exposure-quotes';
  let shioajiEnabled = localStorage.getItem(SHIOAJI_STORE) === '1';
  let remoteQuoteOrigin = null;
  let ngrokToken = localStorage.getItem(SHIOAJI_NGROK_STORE) || '';
  let activeQuoteOrigin = null;
  let connectionVersion = 0;
  const backupQuoteOrigin = () => remoteQuoteOrigin || SHIOAJI_LOCAL;
  const preferredQuoteOrigin = () => ngrokToken ? SHIOAJI_NGROK : backupQuoteOrigin();
  const quoteOrigin = () => activeQuoteOrigin || preferredQuoteOrigin();
  const quoteConnectionName = origin => origin === SHIOAJI_NGROK ? 'ngrok' : origin === SHIOAJI_LOCAL ? '本機' : 'Tailscale';
  const ngrokHeaders = token => ({ Authorization: 'Bearer ' + token, 'ngrok-skip-browser-warning': '1' });
  let shioajiStatus = '';
  let toastTimer = null;
  let currentPage = 'overview';
  let marketRangeMonths = 1;

  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  // loadState clones the defaults, so it must run only after clone is initialized.
  let state = loadState();
  const money = value => `NT$${Math.round(Number(value || 0)).toLocaleString('zh-TW')}`;
  const money2 = value => `NT$${Number(value || 0).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const number = value => Number(value || 0).toLocaleString('zh-TW', { maximumFractionDigits: 4 });
  const pct = value => `${Number(value || 0).toFixed(1)}%`;
  const betaFmt = value => Number(value || 0).toFixed(2);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const fmtTime = timestamp => {
    if (!timestamp) return '時間未提供';
    let n = Number(timestamp);
    if (!Number.isFinite(n)) return String(timestamp);
    if (n > 1e14) n /= 1000; // Fugle WebSocket/quote timestamps may be microseconds
    if (n < 1e11) n *= 1000;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? '時間未提供' : new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(d);
  };
  function isTaiwanMarketOpen() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Taipei', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date());
    const get = type => parts.find(x=>x.type===type)?.value;
    const weekday = get('weekday');
    const minutes = Number(get('hour'))*60 + Number(get('minute'));
    return ['Mon','Tue','Wed','Thu','Fri'].includes(weekday) && minutes >= 510 && minutes <= 815;
  }
  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return clone(defaults);
      return {
        ...clone(defaults), ...parsed,
        settings: { ...clone(defaults.settings), ...(parsed.settings || {}), target: { ...clone(defaults.settings.target), ...((parsed.settings || {}).target || {}) } },
        holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        quoteCache: parsed.quoteCache || {}
      };
    } catch { return clone(defaults); }
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { notify('本機儲存空間不足，請先匯出備份資料。'); }
  }
  function notify(message) {
    const el = $('toast'); if (!el) return;
    el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function categoryName(category) { return ({ lever: '槓桿', core: '原形', cash: '現金＋類現金' })[category] || '原形'; }
  function categoryClass(category) { return ['lever','core','cash'].includes(category) ? category : 'core'; }
  function manualPrice(h) { return Number(h.manualPrice ?? h.price ?? 0); }
  function priceOf(h) {
    const quote = h.quote || state.quoteCache[h.symbol];
    return Number(quote?.price || manualPrice(h) || 0);
  }
  function marketValue(h) { return Math.max(0, Number(h.quantity || 0)) * priceOf(h); }
  function getPortfolio() {
    const totalPositions = state.holdings.reduce((sum, h) => sum + marketValue(h), 0);
    const cashPositions = state.holdings.filter(h => h.category === 'cash').reduce((sum, h) => sum + marketValue(h), 0);
    const lever = state.holdings.filter(h => h.category === 'lever').reduce((sum, h) => sum + marketValue(h), 0);
    const core = state.holdings.filter(h => h.category === 'core').reduce((sum, h) => sum + marketValue(h), 0);
    const cashBalance = Math.max(0, Number(state.cash || 0)) + Math.max(0, Number(state.cashUsd || 0)) * Number(state.usdTwd || 0);
    const cash = cashBalance + cashPositions;
    const total = totalPositions + cashBalance;
    const betaExposure = state.holdings.reduce((sum, h) => sum + marketValue(h) * Number(h.beta || 0), 0);
    const beta = total > 0 ? betaExposure / total : 0;
    const categories = { lever, core, cash };
    return { total, totalPositions, lever, core, cash, cashBalance, cashPositions, betaExposure, beta, categories };
  }
  function targetRatios() { return state.settings.target || defaults.settings.target; }
  function setPage(page) {
    if(page==='holdings'){settingsSection='holdings';page='settings';}
    if (!$(`page-${page}`)) return;
    currentPage = page;
    document.querySelectorAll('.page').forEach(node => node.classList.toggle('active', node.id === `page-${page}`));
    document.querySelectorAll('[data-page]').forEach(node => node.classList.toggle('active', node.dataset.page === page));
    const title = ({ overview:'總覽', holdings:'持股管理', rebalance:'再平衡', history:'歷史紀錄', settings:'系統設定' })[page];
    const eye = ({ overview:'PORTFOLIO OVERVIEW', holdings:'POSITIONS & HOLDINGS', rebalance:'PORTFOLIO REBALANCING', history:'DAILY SNAPSHOTS', settings:'PREFERENCES & DATA' })[page];
    $('pageTitle').textContent = title; $('pageEyebrow').textContent = eye;
    if (page === 'holdings') renderHoldings();
    if (page === 'rebalance') renderRebalance();
    if (page === 'history') renderHistory();
    if (page === 'settings') renderSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function openModal(id) { $(id).classList.add('open'); $(id).setAttribute('aria-hidden', 'false'); }
  function closeModal(id) { $(id).classList.remove('open'); $(id).setAttribute('aria-hidden', 'true'); }
  function renderOverview() {
    const p = getPortfolio(), t = state.settings.targetBeta, tol = state.settings.tolerance;
    $('currentBeta').textContent = betaFmt(p.beta);
    $('overviewTargetBeta').textContent = betaFmt(t);
    const gap = p.beta - t;
    const relativeGap=t>0 ? `${gap>=0?'+':''}${(gap/t*100).toFixed(2)}%` : '—';
    $('betaGapBadge').textContent = `${gap >= 0 ? '+' : ''}${gap.toFixed(2)} (${relativeGap})`;
    $('betaToleranceText').textContent = `± ${tol}%`;
    const low = t * (1 - tol / 100), high = t * (1 + tol / 100);
    let status = '尚未建立持股資料', gapColor = '#8290a0';
    if (p.total > 0) {
      if (p.beta > high) { status = '曝險高於目標區間，建議降低槓桿或增加現金'; gapColor = '#cf6868'; }
      else if (p.beta < low) { status = '曝險低於目標區間，請檢查是否需要增加風險資產'; gapColor = '#d28b31'; }
      else { status = '目前 Beta 位於目標容許範圍內'; gapColor = '#14966d'; }
    }
    $('betaGapBadge').style.color = gapColor; $('betaStatusText').textContent = status;
    const needsSetup=!state.holdings.some(h=>h.symbol&&Number(h.quantity)>0);
    const outside=p.beta<low||p.beta>high;
    $('betaOverviewAction').hidden=!needsSetup&&!outside;
    $('betaOverviewAction').dataset.goto=needsSetup?'settings':'rebalance';
    $('betaOverviewAction').textContent=needsSetup?'開始設定 Beta／持股 →':'前往再平衡 →';
    $('betaInRange').hidden=needsSetup||outside;
    const scaleMax=Math.max(2,Math.ceil(Math.max(p.beta,high)*2)/2);
    const position=value=>Math.max(0,Math.min(100,value/scaleMax*100));
    const currentX = position(p.beta);
    const targetX = position(t);
    $('betaMeterFill').style.width = `${currentX}%`;
    $('betaCurrentMarker').style.left = `${currentX}%`;
    $('betaTargetMarker').style.left = `${targetX}%`;
    $('betaTargetLabel').textContent=`目標 ${betaFmt(t)}`;
    $('betaToleranceZone').style.left=`${position(low)}%`;
    $('betaToleranceZone').style.width=`${position(high)-position(low)}%`;
    $('betaMeterScale').innerHTML=Array.from({length:5},(_,i)=>`<span>${Number((scaleMax*i/4).toFixed(3))}</span>`).join('');
    $('betaMeter').setAttribute('aria-label',`目前 Beta ${betaFmt(p.beta)}，目標 ${betaFmt(t)}，容忍區間 ${betaFmt(low)} 至 ${betaFmt(high)}`);
    $('totalAssets').textContent = money(p.total);
    $('leverValue').textContent = money(p.lever); $('coreValue').textContent = money(p.core); $('cashValue').textContent = money(p.cash);
    $('holdingCount').textContent = `${state.holdings.length} 個標的`;
    const total = p.total || 1;
    const leverPct = p.lever / total * 100, corePct = p.core / total * 100, cashPct = p.cash / total * 100;
    const investedPct = (p.lever + p.core) / total * 100;
    $('allocationDonut').style.background = `conic-gradient(#6781ed 0 ${leverPct}%, #3dbb98 ${leverPct}% ${leverPct + corePct}%, #c5cfdb ${leverPct + corePct}% 100%)`;
    $('allocationCenter').textContent = pct(investedPct);
    $('leverPct').textContent = `${pct(leverPct)} · 目標 ${pct(state.settings.target.lever)}`;
    $('corePct').textContent = `${pct(corePct)} · 目標 ${pct(state.settings.target.core)}`;
    $('cashPct').textContent = `${pct(cashPct)} · 目標 ${pct(state.settings.target.cash)}`;
    const body = $('overviewHoldingsBody');
    const search=($('overviewHoldingSearch').value||'').trim().toLowerCase();
    const holdings=state.holdings.filter(h=>h.symbol);
    const visible=holdings.filter(h=>`${h.symbol} ${h.name||''}`.toLowerCase().includes(search)).sort((a,b)=>marketValue(b)-marketValue(a));
    $('overviewHoldingsCount').textContent=search?`顯示 ${visible.length} / ${holdings.length} 檔`:`共 ${holdings.length} 檔持股`;
    if (!visible.length) body.innerHTML = `<tr><td colspan="7" class="empty-cell">${search?'找不到符合的持股。':'尚未新增持股，請至「設定 → 持股」輸入資料。'}</td></tr>`;
    else body.innerHTML = visible.map(h => {
      const price=priceOf(h),high=holdingHighOf(h.symbol),gain=MarketQuotes.gainToHigh(price,high?.highPrice);
      const symbol=escapeHtml(h.symbol),name=escapeHtml(h.name||h.symbol),category=categoryName(h.category);
      return `<tr><td><div class="overview-asset"><div class="overview-asset-heading"><strong title="${symbol}">${symbol}</strong><span class="tag ${categoryClass(h.category)}" title="${category}">${h.category==='cash'?'類現金':category}</span></div><small title="${name}">${name}</small></div></td><td class="right">${price ? money2(price) : '—'}</td><td class="right">${money(marketValue(h))}</td><td class="right">${number(h.quantity)}</td><td class="right">${pct(p.total ? marketValue(h)/p.total*100 : 0)}</td><td class="right">${high?`${money2(high.highPrice)}<small class="holding-high-date">${escapeHtml(high.highPriceDate||'')}</small>`:'—'}</td><td class="right">${gain==null?'—':gain===0?'已達高點':`+${gain.toFixed(2)}%`}</td></tr>`;
    }).join('');
    renderMarketCard();
    window.dispatchEvent(new CustomEvent('exposure-index-quote',{detail:indexQuoteReading()}));
  }
  function renderMarketCard() {
    const symbol = String(state.settings.benchmark || '0050').toUpperCase();
    const q = marketQuote(symbol);
    const h = state.marketHistory && state.marketHistory.symbol === symbol ? state.marketHistory : null;
    const price = Number(q?.price || 0), high = Number(h?.highClose || 0);
    renderMarketChart(h, q);
    if (price && high) {
      const distance = (price / high - 1) * 100;
      $('marketDistance').textContent = `${distance.toFixed(2)}%`;
      $('marketDistance').style.color = distance <= -20 ? '#c55e5e' : distance <= -10 ? '#c28a39' : '#14966d';
      $('marketZone').textContent = distance <= -20 ? '股災觀察區間（低於高點 20% 以上）' : distance <= -10 ? '觀察區間（低於高點 10～20%）' : '正常區間（低於高點 10% 以內）';
      $('marketBarFill').style.width = `${Math.max(0, Math.min(100, price / high * 100))}%`;
      $('marketPrice').textContent = money2(price); $('marketHigh').textContent = money2(high); $('marketHighDate').textContent = `高點日期 ${h.highDate || '—'}`;
      $('marketQuoteTime').textContent = q ? fmtTime(q.quoteTime || q.lastUpdated) : '尚無報價';
      $('marketSourceText').textContent = `報價：${q?.source || '既有報價'} · 還原日 K 備份 ${h.to || ''}`;
    } else {
      $('marketDistance').textContent = '—'; $('marketZone').textContent = h ? '等待即時報價' : '等待歷史高點資料';
      $('marketPrice').textContent = price ? money2(price) : '—'; $('marketHigh').textContent = high ? money2(high) : '—';
      $('marketHighDate').textContent = h ? `高點日期 ${h.highDate}` : '—'; $('marketQuoteTime').textContent = q ? fmtTime(q.quoteTime || q.lastUpdated) : '尚無報價';
      $('marketSourceText').textContent = '報價：' + (q?.source || '永豐 Shioaji（等待報價）');
    }
  }
  function renderMarketChart(history, quote) {
    document.querySelectorAll('#marketRanges button').forEach(button => {
      const active = Number(button.dataset.range) === marketRangeMonths;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const all = (history?.data || []).filter(row => row.date && Number(row.close) > 0)
      .map(row => ({date: row.date.slice(0,10), close: Number(row.close)}))
      .sort((a,b) => a.date.localeCompare(b.date));
    if (quote?.date && Number(quote.price) > 0) {
      const date = quote.date.slice(0,10);
      const existing = all.find(row => row.date === date);
      if (existing) existing.close = Number(quote.price);
      else all.push({date, close: Number(quote.price)});
      all.sort((a,b) => a.date.localeCompare(b.date));
    }
    if (!history || all.length < 2) {
      $('marketChart').innerHTML = '<p class="empty-cell">等待歷史走勢資料，請按「更新市場水位」。</p>';
      $('marketChartDates').textContent = '';
      return;
    }
    const end = all[all.length-1].date;
    const cutoff = new Date(`${end}T00:00:00Z`);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - marketRangeMonths);
    const rows = all.filter(row => row.date >= cutoff.toISOString().slice(0,10));
    const high = Math.max(Number(history.highClose) || 0, ...all.map(row => row.close));
    const floor = Math.min(.7, ...rows.map(row => row.close/high)) - .015;
    const ceiling = Math.max(1, ...rows.map(row => row.close/high)) + .025;
    const left=78, right=822, top=22, bottom=320;
    const y = ratio => top + (ceiling-ratio)/(ceiling-floor)*(bottom-top);
    const x = i => left + i/Math.max(1,rows.length-1)*(right-left);
    const bands = [[1,.9,'#dce8df','正常'],[.9,.8,'#eee2c5','觀察'],[.8,floor,'#ecd2d2','股災']];
    let svg = bands.map(([upper,lower,color,label]) => `<rect x="12" y="${y(upper)}" width="876" height="${y(lower)-y(upper)}" fill="${color}"/><text x="23" y="${y(upper)+39}" fill="#637369">${label}</text>`).join('');
    [1,.9,.8].forEach(ratio => { svg += `<line x1="${left}" x2="${right}" y1="${y(ratio)}" y2="${y(ratio)}" stroke="#8994a0" stroke-dasharray="6 6"/><text x="23" y="${y(ratio)+17}">${Math.round((ratio-1)*100)}%</text><text x="878" y="${y(ratio)+17}" text-anchor="end">${(high*ratio).toFixed(2)}</text>`; });
    const points = rows.map((row,i) => `${x(i)},${y(row.close/high)}`).join(' ');
    svg += `<polyline points="${points}" fill="none" stroke="#334155" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`;
    rows.forEach((row,i) => { svg += `<circle cx="${x(i)}" cy="${y(row.close/high)}" r="8" fill="transparent"><title>${row.date} · ${row.close.toFixed(2)} 元 · 距高點 ${((row.close/high-1)*100).toFixed(2)}%</title></circle>`; });
    const last = rows[rows.length-1];
    svg += `<circle cx="${x(rows.length-1)}" cy="${y(last.close/high)}" r="5" fill="#70877b" stroke="white" stroke-width="2"/>`;
    [...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])].forEach(i => { svg += `<text x="${x(i)}" y="345" text-anchor="middle">${rows[i].date.slice(5).replace('-','/')}</text>`; });
    $('marketChart').innerHTML = `<svg viewBox="0 0 900 360" role="img" aria-label="${escapeHtml(history.symbol)} 最近 ${marketRangeMonths} 個月走勢，依 52 週高點劃分回檔區間"><title>${escapeHtml(history.symbol)} 股價走勢與回檔區間</title>${svg}</svg>`;
    $('marketChartDates').textContent = `${rows[0].date} — ${end}`;
  }
  function renderHoldings() {
    const p = getPortfolio();
    $('cashBalanceInput').value = Number(state.cash || 0);
    $('holdingMiniStats').innerHTML = `<div class="mini-stat"><span>總資產</span><strong>${money(p.total)}</strong></div><div class="mini-stat"><span>持倉標的</span><strong>${state.holdings.length}</strong></div><div class="mini-stat"><span>目前 Beta</span><strong>${betaFmt(p.beta)}</strong></div><div class="mini-stat"><span>現金餘額</span><strong>${money(state.cash)}</strong></div>`;
    const term = ($('holdingSearch').value || '').trim().toLowerCase();
    const rows = state.holdings.filter(h => `${h.symbol} ${h.name}`.toLowerCase().includes(term));
    const body = $('holdingsBody');
    if (!rows.length) { body.innerHTML = `<tr><td colspan="9" class="empty-cell">${state.holdings.length ? '找不到符合的標的。' : '尚未建立持倉，請按右上角新增持股。'}</td></tr>`; return; }
    body.innerHTML = rows.map(h => {
      const q = h.quote || state.quoteCache[h.symbol];
      const qError = state.quoteCache[h.symbol]?.error;
      const qText = qError ? (q ? '更新失敗，沿用上次價' : '報價失敗') : q ? (isTaiwanMarketOpen() ? '盤中最後成交' : '盤後最後成交') : '等待永豐報價';
      const qClass = q && !qError ? 'live' : '';
      return `<tr><td><div class="asset-cell"><div class="asset-avatar">${escapeHtml(String(h.symbol).slice(0,4))}</div><div class="asset-name"><strong>${escapeHtml(h.name || h.symbol)}</strong><small>${escapeHtml(h.symbol)}</small></div></div></td><td><span class="tag ${categoryClass(h.category)}">${categoryName(h.category)}</span></td><td class="right">${number(h.quantity)}</td><td class="right">${money2(h.cost || 0)}</td><td class="right">${priceOf(h) ? money2(priceOf(h)) : '—'}</td><td class="right">${money(marketValue(h))}</td><td class="right">${betaFmt(h.beta)}</td><td><span class="quote-status ${qClass}" title="${q ? `更新 ${fmtTime(q.quoteTime || q.lastUpdated)}` : ''}">${qText}</span></td><td><button class="table-action" data-edit="${h.id}">編輯</button> <button class="table-action danger" data-delete="${h.id}">刪除</button></td></tr>`;
    }).join('');
  }
  function calculateRebalance() {
    const p = getPortfolio(), targets = targetRatios();
    const groups = { lever: state.holdings.filter(h => h.category === 'lever'), core: state.holdings.filter(h => h.category === 'core'), cash: state.holdings.filter(h => h.category === 'cash') };
    groups.cash.push({ id: '__cash__', symbol: 'CASH', name: '現金餘額', category: 'cash', quantity: 1, beta: 0, manualPrice: p.cashBalance, isCashBalance: true });
    const entries = [], missing = [];
    for (const category of ['lever','core','cash']) {
      const targetValue = p.total * Number(targets[category] || 0) / 100;
      const currentValue = groups[category].reduce((sum,h) => sum + (h.isCashBalance ? p.cashBalance : marketValue(h)), 0);
      const allocatable = groups[category].filter(h => !h.isCashBalance || p.cashBalance > 0);
      if (targetValue > 0 && !allocatable.length && category !== 'cash') {
        missing.push({ category, value: targetValue });
      }
      const weightedGroup=groupWeights(category);
      const cashEtfs=groups.cash.filter(h=>!h.isCashBalance);
      const realCashShare=cashEtfs.length ? Math.max(0,Math.min(100,Number(state.settings.realCashPct??10)))/100 : 1;
      const weights = groups[category].map(h => category==='cash' ? (h.isCashBalance ? realCashShare : (1-realCashShare)*(state.settings.cashMode==='custom' ? weightedGroup.find(x=>x.h.id===h.id)?.weight||0 : 1/Math.max(1,cashEtfs.length))) : weightedGroup.find(x=>x.h.id===h.id)?.weight||0);
      const weightSum = weights.reduce((a,b)=>a+b,0);
      const equalWeight = groups[category].length ? 1 / groups[category].length : 0;
      groups[category].forEach((h,i) => {
        const current = h.isCashBalance ? p.cashBalance : marketValue(h);
        const weight = weightSum > 0 ? weights[i] / weightSum : equalWeight;
        const target = targetValue * weight;
        const delta = target - current;
        entries.push({ id:h.id, symbol:h.symbol, name:h.name, category, current, target, delta, price:h.isCashBalance ? 0 : priceOf(h), quantity:h.isCashBalance ? 0 : (h.quantity || 0), beta:Number(h.beta||0), isCashBalance:Boolean(h.isCashBalance) });
      });
    }
    for (const m of missing) entries.push({ id:`missing-${m.category}`, symbol:'待指定標的', name:`${categoryName(m.category)}目標尚無持倉`, category:m.category, current:0, target:m.value, delta:m.value, price:0, beta:0, missing:true });
    const buy = entries.filter(x=>x.delta>1).reduce((s,x)=>s+x.delta,0);
    const sell = entries.filter(x=>x.delta< -1).reduce((s,x)=>s+Math.abs(x.delta),0);
    const tradeTotal = (buy+sell)/2;
    let targetBeta = 0;
    for (const cat of ['lever','core','cash']) {
      const holdings = groups[cat];
      const mv = holdings.reduce((s,h)=>s+(h.isCashBalance ? p.cashBalance : marketValue(h)),0);
      const avgBeta = mv ? holdings.reduce((s,h)=>s+(h.isCashBalance ? 0 : marketValue(h)*Number(h.beta||0)),0)/mv : 0;
      targetBeta += Number(targets[cat]||0)/100 * avgBeta;
    }
    targetBeta=p.total ? entries.reduce((sum,row)=>sum+row.target*Number(row.beta||0),0)/p.total : 0;
    return { p, entries, missing, buy, sell, tradeTotal, targetBeta };
  }
  function renderRebalance() {
    renderFamiliarRebalance();
    return;
    const plan = calculateRebalance(), p = plan.p, t = state.settings.targetBeta, tol = state.settings.tolerance;
    $('rebalanceSummary').innerHTML = `<div class="summary-card"><span>目前整體 Beta</span><strong>${betaFmt(p.beta)}</strong><small>目標 ${betaFmt(t)} · 容許 ±${tol}%</small></div><div class="summary-card"><span>預估目標配置 Beta</span><strong>${betaFmt(plan.targetBeta)}</strong><small>依各持倉 Beta 加權估計</small></div><div class="summary-card"><span>預計調整金額</span><strong>${money(plan.tradeTotal)}</strong><small>買進／賣出金額合計的一半</small></div><div class="summary-card"><span>持倉可分配資產</span><strong>${money(p.total)}</strong><small>現金與證券市值合計</small></div>`;
    const compare = $('allocationCompare');
    compare.innerHTML = ['lever','core','cash'].map(cat => {
      const current = p.total ? p.categories[cat]/p.total*100 : 0;
      const target = Number(targetRatios()[cat] || 0);
      return `<div class="compare-row"><div class="compare-label"><i class="legend-swatch ${cat}"></i>${categoryName(cat)}</div><div class="compare-bars"><div class="compare-bar"><span style="width:${Math.max(0,Math.min(100,current))}%;background:${cat==='lever'?'#6781ed':cat==='core'?'#3dbb98':'#c5cfdb'}"></span></div><div class="compare-bar"><span style="width:${Math.max(0,Math.min(100,target))}%;background:#d4dbe6"></span></div></div><div class="compare-values">${current.toFixed(1)}% <small>→ ${target}%</small></div></div>`;
    }).join('');
    const body = $('rebalanceBody');
    if (!p.total) { body.innerHTML = '<tr><td colspan="6" class="empty-cell">請先新增證券持倉或設定現金餘額，再產生再平衡建議。</td></tr>'; }
    else {
      body.innerHTML = plan.entries.map(e => {
        const qty = e.price > 0 ? Math.abs(e.delta/e.price) : 0;
        let action = '維持', actionClass = 'trade-hold';
        if (e.missing) { action='請新增此類標的'; actionClass='trade-hold'; }
        else if (e.delta > 1) { action='買進'; actionClass='trade-buy'; }
        else if (e.delta < -1) { action='賣出'; actionClass='trade-sell'; }
        return `<tr><td><div class="asset-cell"><div class="asset-avatar">${escapeHtml(String(e.symbol).slice(0,4))}</div><div class="asset-name"><strong>${escapeHtml(e.name || e.symbol)}</strong><small>${escapeHtml(e.symbol)} · ${categoryName(e.category)}</small></div></div></td><td class="right">${money(e.current)}</td><td class="right">${money(e.target)}</td><td class="right ${e.delta>1?'trade-buy':e.delta< -1?'trade-sell':''}">${e.delta>=0?'+':''}${money(e.delta)}</td><td class="right">${e.price>0 ? `${e.delta>=0?'+':'−'}${number(qty)}` : '—'}</td><td class="${actionClass}">${action}</td></tr>`;
      }).join('');
    }
    const missingText = plan.missing.length ? `；尚有 ${plan.missing.map(x=>categoryName(x.category)).join('、')} 的目標配置尚未指定標的` : '';
    $('rebalanceFoot').textContent = `預估買進 ${money(plan.buy)}，賣出 ${money(plan.sell)}${missingText}。系統以目前報價及持倉市值估算，請勿直接視為下單指令。`;
    const low=t*(1-tol/100),high=t*(1+tol/100);
    $('planStatusPill').textContent = !p.total ? '等待持倉' : (p.beta<low?'曝險不足':p.beta>high?'曝險偏高':'目標區間內');
  }
  function renderHistory() {
    const list = [...state.history].sort((a,b)=>b.date.localeCompare(a.date));
    $('historySummary').innerHTML = `<div class="summary-card"><span>快照筆數</span><strong>${list.length}</strong><small>已保存日期</small></div><div class="summary-card"><span>最近資產總值</span><strong>${list.length?money(list[0].total):'—'}</strong><small>${list[0]?.date || '尚無紀錄'}</small></div><div class="summary-card"><span>最近整體 Beta</span><strong>${list.length?betaFmt(list[0].beta):'—'}</strong><small>收盤後可儲存一次</small></div>`;
    $('historyBody').innerHTML = list.length ? list.map(x=>`<tr><td>${escapeHtml(x.date)}</td><td class="right">${money(x.total)}</td><td class="right">${betaFmt(x.beta)}</td><td class="right">${pct(x.leverPct)}</td><td class="right">${pct(x.corePct)}</td><td class="right">${pct(x.cashPct)}</td><td><button class="table-action danger" data-delete-history="${escapeHtml(x.date)}">刪除</button></td></tr>`).join('') : '<tr><td colspan="7" class="empty-cell">尚無歷史快照。每日收盤後可按「儲存今日紀錄」。</td></tr>';
  }
  function renderSettings() {
    renderFamiliarSettings();
    $('settingTargetBeta').value = state.settings.targetBeta;
    $('settingTolerance').value = state.settings.tolerance;
    $('targetLever').value = state.settings.target.lever;
    $('targetCore').value = state.settings.target.core;
    $('targetCash').value = state.settings.target.cash;
    $('shioajiRemoteUrl').value = remoteQuoteOrigin || '';
    updateTargetTotal();
    updateApiStatusUi();
  }
  function updateTargetTotal() {
    const total = Number($('targetLever').value||0)+Number($('targetCore').value||0)+Number($('targetCash').value||0);
    $('targetAllocationTotal').textContent = `${total}%`;
    $('targetAllocationTotal').style.color = total === 100 ? '#14966d' : '#c85f5f';
    $('allocationValidation').textContent = total === 100 ? '目標配置合計正確。' : '三項比例合計必須為 100%。';
  }
  function updateApiStatusUi() {
    const ready = shioajiStatus.startsWith('已連線');
    const status = shioajiStatus || '請按 ⟳ 連線永豐行情';
    $('marketStatusText').textContent = status;
    $('shioajiModeText').textContent = status;
    $('sideStatusText').textContent = '永豐 Shioaji · ' + quoteConnectionName(quoteOrigin());
    $('sideStatusSub').textContent = '市場水位每 20 秒推播 · 持倉每 60 秒推播';
    $('providerState').textContent = ready ? '已連線' : '等待行情服務';
    $('checkApiBtn').textContent = '重新連線永豐';
    $('pairNgrokBtn').textContent = ngrokToken ? '重新配對 ngrok' : '啟用 ngrok 預設';
    $('ngrokPairHint').textContent = ngrokToken
      ? '這台裝置已設定 ngrok 為預設。若連線中斷，網站會嘗試備用連線。'
      : '首次配對時，手機先連上 Tailscale，電腦可用本機行情服務。完成後用 4G 開網站即可。';
    $('clearShioajiRemoteBtn').hidden = !remoteQuoteOrigin;
    for (const id of ['marketDot','sideStatusDot']) {
      $(id).classList.toggle('ok', ready);
      $(id).classList.toggle('bad', !ready);
    }
  }
  function renderAll() { syncModelTargets(); renderOverview(); if(currentPage==='holdings')renderHoldings(); if(currentPage==='rebalance')renderRebalance(); if(currentPage==='history')renderHistory(); if(currentPage==='settings'){renderFamiliarSummary();refreshFamiliarHoldingValues();} }

  async function fetchQuote(symbol) {
    const normalized = MarketQuotes.symbol(symbol);
    if (!normalized) throw new Error('股票代號不可空白');
    const { quotes } = await fetchShioajiQuotes([normalized], true);
    if (!quotes.length) throw new Error('等待永豐推播此標的的報價');
    return quotes[0];
  }
  function currentQuoteSymbols(extra='') { return MarketQuotes.symbols([...MarketQuotes.marketPair(state.settings.benchmark),...state.holdings.map(h=>h.symbol),extra]); }
  async function fetchShioajiQuotes(symbols, interactive=false, origin=quoteOrigin(), token=ngrokToken) {
    if (!interactive && origin === SHIOAJI_LOCAL) {
      const permission = await navigator.permissions?.query({ name:'loopback-network' }).catch(()=>null);
      if (permission && permission.state !== 'granted') throw new Error('請在設定頁重新檢查 API，並允許本機網路存取');
    }
    let response;
    try {
      const query = new URLSearchParams({ symbols: symbols.slice(0,100).join(',') });
      response = await fetch(origin + '/quotes?' + query, {
        cache:'no-store', credentials:'omit', redirect:'error',
        ...(origin === SHIOAJI_NGROK ? { headers:ngrokHeaders(token) }
          : { targetAddressSpace:origin === SHIOAJI_LOCAL ? 'loopback' : 'local' }),
        signal:AbortSignal.timeout(origin === SHIOAJI_NGROK ? 7000 : interactive ? 25000 : 5000)
      });
    } catch {
      if (origin === SHIOAJI_NGROK) throw new Error('ngrok 行情無法連線，請確認家中電腦的通道與行情服務已啟動');
      throw new Error(origin === SHIOAJI_LOCAL ? '無法連到本機服務，請確認服務已啟動及瀏覽器權限'
        : '無法連到家中行情服務，請確認 Tailscale 已連線，且家中電腦與行情服務都已啟動');
    }
    if (origin === SHIOAJI_NGROK && !response.ok) throw new Error(response.status === 401
      ? 'ngrok 行情驗證失敗，請在設定重新配對' : 'ngrok 行情服務暫時無法使用');
    if (!response.ok) throw new Error('無法讀取永豐行情服務，請確認使用相同的 Tailscale 帳號');
    const body = await response.json();
    if (body.state === 'login_error') throw new Error('本機服務登入永豐失敗');
    if (body.state !== 'connected') throw new Error('本機服務正在登入永豐，稍後再試');
    return { quotes: MarketQuotes.localBatch(body.quotes, symbols), stream: body.stream === true };
  }
  async function pairNgrokQuotes() {
    const button = $('pairNgrokBtn');
    const status = $('ngrokPairStatus');
    const backup = backupQuoteOrigin();
    const version = connectionVersion;
    button.disabled = true;
    status.textContent = '正在驗證這台裝置…';
    try {
      const response = await fetch(backup + '/pair-ngrok', {
        cache:'no-store', credentials:'omit', redirect:'error',
        targetAddressSpace:backup === SHIOAJI_LOCAL ? 'loopback' : 'local',
        signal:AbortSignal.timeout(25000)
      }).catch(() => { throw new Error('配對時請先連上既有的 Tailscale 或本機行情服務'); });
      if (!response.ok) throw new Error('家中行情服務暫時無法配對 ngrok');
      const { token } = await response.json();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('無法取得有效的配對資訊');
      const { quotes, stream } = await fetchShioajiQuotes(currentQuoteSymbols(), true, SHIOAJI_NGROK, token);
      if (version !== connectionVersion) throw new Error('備用連線已變更，請重新配對');
      localStorage.setItem(SHIOAJI_NGROK_STORE, token);
      localStorage.setItem(SHIOAJI_STORE, '1');
      ngrokToken = token;
      shioajiEnabled = true;
      connectionVersion++;
      useQuoteConnection(SHIOAJI_NGROK, quotes, stream);
      status.textContent = '配對完成。下次開網站會自動優先使用 ngrok。';
    } catch (error) {
      status.textContent = error.message;
    } finally { button.disabled = false; }
  }
  async function pairRemoteQuotes(event) {
    event.preventDefault();
    const origin = MarketQuotes.privateOrigin($('shioajiRemoteUrl').value);
    if (!origin) return notify('請輸入家中電腦的 Tailscale HTTPS 網址');
    const button = $('pairShioajiBtn');
    button.disabled = true;
    $('shioajiPairStatus').textContent = '正在連線家中行情服務…';
    try {
      const { quotes, stream } = await fetchShioajiQuotes(currentQuoteSymbols(), true, origin);
      localStorage.setItem(SHIOAJI_REMOTE_STORE, origin);
      localStorage.setItem(SHIOAJI_STORE, '1');
      remoteQuoteOrigin = origin;
      shioajiEnabled = true;
      connectionVersion++;
      if (ngrokToken) void refreshQuotes(true);
      else useQuoteConnection(origin, quotes, stream);
      $('shioajiPairStatus').textContent = '已儲存這台裝置的 Tailscale 備用連線';
      if (new URLSearchParams(location.hash.slice(1)).has('shioaji')) {
        history.replaceState(null, '', location.pathname + location.search);
        setPage('overview');
      }
    } catch (error) {
      $('shioajiPairStatus').textContent = error.message;
    } finally { button.disabled = false; }
  }
  function clearRemoteQuotes() {
    localStorage.removeItem(SHIOAJI_REMOTE_STORE);
    remoteQuoteOrigin = null;
    activeQuoteOrigin = null;
    connectionVersion++;
    stopMarketStream();
    shioajiStatus = '';
    $('shioajiRemoteUrl').value = '';
    $('shioajiPairStatus').textContent = '';
    updateApiStatusUi();
    void refreshQuotes(true);
  }
  function applyShioajiQuotes(quotes, stream, refreshMarket) {
    for (const quote of quotes) {
      updateQuoteEverywhere(quote.symbol, quote);
      const live = liveMarketQuotes.get(quote.symbol);
      if (refreshMarket && live && MarketQuotes.timestamp(quote.quoteTime) >= MarketQuotes.timestamp(live.quoteTime)) {
        liveMarketQuotes.set(quote.symbol, quote);
      }
    }
    const via = ' · ' + quoteConnectionName(quoteOrigin());
    shioajiStatus = marketStream?.readyState === 1 ? '已連線 · 永豐即時推播' + via
      : stream ? '已連線 · 正在連接永豐推播' + via : '已連線 · 每 60 秒同步' + via;
    $('footerUpdated').textContent = shioajiStatus;
    persist();
    renderAll();
    updateApiStatusUi();
  }
  function marketQuote(symbol) {
    const live = liveMarketQuotes.get(symbol);
    const saved = state.quoteCache[symbol];
    if (live && marketStream?.readyState === 1) return live;
    return live && MarketQuotes.timestamp(live.quoteTime) >= (MarketQuotes.timestamp(saved?.quoteTime || saved?.lastUpdated) || 0) ? live : saved;
  }
  function stopMarketStream() {
    marketStream?.close();
    marketStream = null;
    marketStreamKey = '';
    if (marketFrame !== null) cancelAnimationFrame(marketFrame);
    marketFrame = null;
  }
  function openNgrokStream(url) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), 8000);
    let closed = false;
    const source = {
      readyState:0,
      close() {
        closed = true;
        source.readyState = 2;
        clearTimeout(timer);
        controller.abort();
      }
    };
    void (async () => {
      try {
        const response = await fetch(url, {
          cache:'no-store', credentials:'omit', redirect:'error',
          headers:ngrokHeaders(ngrokToken), signal:controller.signal
        });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
          throw new Error('ngrok 推播暫時無法使用');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        while (!closed) {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), 40000);
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream:true });
          let end;
          while (!closed && (end = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (frame.startsWith('data: ')) {
              source.readyState = 1;
              source.onmessage?.({ data:frame.slice(6) });
            }
          }
          if (pending.length > 65536) break;
        }
      } catch {
        // Report the interruption through the same handler as EventSource.
      } finally {
        const wasClosed = closed;
        source.close();
        if (!wasClosed) source.onerror?.();
      }
    })();
    return source;
  }
  function connectMarketStream() {
    if (document.hidden) return;
    const marketSymbols = MarketQuotes.marketPair(state.settings.benchmark);
    const symbols = currentQuoteSymbols().slice(0, 100);
    const origin = quoteOrigin();
    const key = origin + '|' + symbols.join(',');
    if (marketStreamKey === key && marketStream?.readyState !== 2) return;
    stopMarketStream();
    const query = new URLSearchParams({ symbols: symbols.join(',') });
    const url = origin + '/stream?' + query;
    if (origin !== SHIOAJI_NGROK && typeof EventSource === 'undefined') return;
    const source = origin === SHIOAJI_NGROK ? openNgrokStream(url) : new EventSource(url);
    marketStream = source;
    marketStreamKey = key;
    source.onmessage = event => {
      if (marketStream !== source) return;
      let body;
      try { body = JSON.parse(event.data); } catch { return; }
      if (body?.state !== 'connected') return;
      const connected = '已連線 · 永豐即時推播 · ' + quoteConnectionName(origin);
      if (shioajiStatus !== connected) {
        shioajiStatus = connected;
        $('footerUpdated').textContent = shioajiStatus;
        updateApiStatusUi();
      }
      let changed = false;
      const quotes = MarketQuotes.localBatch(body.quotes, symbols);
      for (const quote of quotes) {
        if (!marketSymbols.includes(quote.symbol)) continue;
        const previous = marketQuote(quote.symbol);
        const previousTime = MarketQuotes.timestamp(previous?.quoteTime || previous?.lastUpdated);
        const quoteTime = MarketQuotes.timestamp(quote.quoteTime);
        if (previousTime && quoteTime < previousTime) continue;
        liveMarketQuotes.set(quote.symbol, quote);
        changed ||= quote.price !== previous?.price || Math.floor(quoteTime / 1000) !== Math.floor(previousTime / 1000)
          || quote.high !== previous?.high || quote.low !== previous?.low;
      }
      if (body.holdingsSync === true) {
        source.holdingsSync = true;
        quotes.forEach(quote => updateQuoteEverywhere(quote.symbol, quote));
        persist();
        renderAll();
        return;
      }
      if (changed && marketFrame === null) {
        marketFrame = requestAnimationFrame(() => {
          marketFrame = null;
          renderMarketCard();
          window.dispatchEvent(new CustomEvent('exposure-index-quote', { detail:indexQuoteReading() }));
        });
      }
    };
    source.onerror = () => {
      if (marketStream !== source) return;
      shioajiStatus = origin === SHIOAJI_NGROK ? 'ngrok 推播中斷 · 正在嘗試備用連線' : '永豐即時推播暫停 · 等待重連';
      $('footerUpdated').textContent = shioajiStatus;
      updateApiStatusUi();
      if (origin === SHIOAJI_NGROK) void refreshQuotes(false, true);
    };
  }
  function indexQuoteReading() {
    const q=marketQuote(MarketQuotes.INDEX),price=Number(q?.price);
    if(!Number.isFinite(price)||price<=0)return null;
    const timestamp=q.quoteTime||q.lastUpdated,ms=MarketQuotes.timestamp(timestamp);
    return {price, high:q.high, low:q.low, time:fmtTime(timestamp),date:q.date||(ms?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)):null),source:q.source||'既有報價'};
  }
  function updateQuoteEverywhere(symbol, quote) {
    const previous=state.quoteCache[symbol],older=MarketQuotes.timestamp(quote.quoteTime||quote.lastUpdated),newer=MarketQuotes.timestamp(previous?.quoteTime||previous?.lastUpdated);
    if(older&&newer&&older<newer)return;
    state.quoteCache[symbol] = quote;
    state.holdings.forEach(h => { if (String(h.symbol).toUpperCase() === symbol) h.quote = quote; });
    const swapOpen = $('swapModal')?.classList.contains('open');
    const swapTarget = String($('swapSymbol')?.value || '').trim().toUpperCase();
    const swapSource = selectedSwapSource();
    const sourcePriceChanged = swapOpen && String(swapSource?.symbol || '').toUpperCase() === String(symbol).toUpperCase();
    if (swapOpen && swapTarget === String(symbol).toUpperCase()) {
      $('swapPrice').value = Number(quote.price || 0).toFixed(2);
      if (!$('swapName').value) $('swapName').value = quote.name || symbol;
      const quoteAt = quote.quoteTime || quote.lastUpdated;
      $('swapQuoteStamp').textContent = `新標的報價 ${money2(quote.price)} · ${fmtTime(quoteAt)} · ${quote.source || '既有報價'}`;
    }
    if (swapOpen && (swapTarget === String(symbol).toUpperCase() || sourcePriceChanged)) updateSwapPreview();
  }
  function useQuoteConnection(origin, quotes, stream, refreshMarket=false) {
    if (quoteOrigin() !== origin) stopMarketStream();
    activeQuoteOrigin = origin;
    applyShioajiQuotes(quotes, stream, refreshMarket);
    if (stream) connectMarketStream();
    else stopMarketStream();
  }
  async function refreshQuotes(interactive=false, backupOnly=false) {
    if (isRefreshing || (!interactive && !shioajiEnabled)) return;
    isRefreshing = true;
    const version = connectionVersion;
    const backup = backupQuoteOrigin();
    const origins = !backupOnly && ngrokToken ? [SHIOAJI_NGROK, backup] : [backup];
    try {
      const activeSwapSymbol = $('swapModal')?.classList.contains('open') ? $('swapSymbol').value : '';
      const symbols = currentQuoteSymbols(activeSwapSymbol);
      const errors = [];
      for (const origin of origins) {
        try {
          const { quotes, stream } = await fetchShioajiQuotes(symbols, interactive, origin);
          if (version !== connectionVersion) return;
          shioajiEnabled = true;
          localStorage.setItem(SHIOAJI_STORE, '1');
          useQuoteConnection(origin, quotes, stream, interactive);
          return true;
        } catch (error) {
          if (version !== connectionVersion) return;
          errors.push(error.message);
        }
      }
      shioajiStatus = errors.join('。');
      updateApiStatusUi();
      return false;
    } finally { isRefreshing = false; }
  }
  function holdingHighOf(symbol){
    const s=MarketQuotes.symbol(symbol),market=state.marketHistory?.symbol===s?state.marketHistory:null,holding=state.holdingHighs?.[s];
    return [market,holding].filter(h=>Number(h?.highPrice)>0).sort((a,b)=>(b.fetchedAt||0)-(a.fetchedAt||0))[0]||null;
  }
  function startQuoteTimer() {
    clearInterval(quoteTimer);
    let nextRetry = 0;
    quoteTimer = setInterval(() => {
      if (document.hidden || Date.now() < nextRetry) return;
      const expectedStreamKey = quoteOrigin() + '|' + currentQuoteSymbols().slice(0, 100).join(',');
      const combined = marketStream?.readyState === 1 && marketStream.holdingsSync === true && marketStreamKey === expectedStreamKey;
      if (combined && (!ngrokToken || quoteOrigin() === SHIOAJI_NGROK)) return;
      if (ngrokToken) {
        const taipei = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const minutes = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
        const weekdays = taipei.getUTCDay() >= 1 && taipei.getUTCDay() <= 5;
        const offHours = !weekdays || minutes < 530 || minutes >= 825;
        if (offHours && quoteOrigin() === SHIOAJI_NGROK && marketStream?.readyState === 1 && marketStreamKey === expectedStreamKey) return;
        if (offHours || combined) {
          nextRetry = Date.now() + 15 * 60000;
        }
      }
      void refreshQuotes().then(ok => {
        if (ngrokToken && ok === false) nextRetry = Math.max(nextRetry, Date.now() + 5 * 60000);
      });
    }, 60000);
  }

  function clearHoldingForm() {
    $('holdingForm').reset(); $('editHoldingId').value=''; $('holdingModalTitle').textContent='新增持股';
    $('assetCategory').value='core'; $('assetBeta').value='1'; $('assetQuantity').value='0'; $('assetCost').value='0'; $('assetPrice').value='0';
    $('deleteHoldingBtn').hidden=true; $('assetQuoteHint').textContent='永豐本機服務連線後會更新報價；也可輸入手動備援價。';
  }
  function openAddHolding() { clearHoldingForm(); openModal('holdingModal'); }
  function openEditHolding(id) {
    const h=state.holdings.find(x=>x.id===id); if(!h)return;
    clearHoldingForm(); $('holdingModalTitle').textContent='編輯持股'; $('editHoldingId').value=h.id;
    $('assetSymbol').value=h.symbol; $('assetName').value=h.name||''; $('assetCategory').value=h.category||'core'; $('assetBeta').value=h.beta ?? 1;
    $('assetQuantity').value=h.quantity ?? 0; $('assetCost').value=h.cost ?? 0; $('assetPrice').value=manualPrice(h);
    $('deleteHoldingBtn').hidden=false;
    const q=h.quote||state.quoteCache[h.symbol]; $('assetQuoteHint').textContent=q?`目前報價 ${money2(q.price)} · 更新 ${fmtTime(q.quoteTime||q.lastUpdated)}；手動備援價 ${money2(manualPrice(h))}`:'此標的尚無 API 報價，將先使用手動價格。';
    openModal('holdingModal');
  }
  function saveHolding(e) {
    e.preventDefault();
    const id=$('editHoldingId').value, symbol=$('assetSymbol').value.trim().toUpperCase();
    if(!symbol)return;
    const previous=state.holdings.find(x=>x.id===id);
    const asset={id:id||uid(),symbol,name:$('assetName').value.trim()||symbol,category:$('assetCategory').value,beta:Number($('assetBeta').value),quantity:Number($('assetQuantity').value),cost:Number($('assetCost').value),manualPrice:Number($('assetPrice').value),quote:previous?.symbol===symbol?previous.quote:state.quoteCache[symbol]||null};
    if(id)state.holdings=state.holdings.map(x=>x.id===id?asset:x); else state.holdings.push(asset);
    persist(); closeModal('holdingModal'); renderAll(); if(currentPage==='holdings')renderHoldings(); notify('持倉資料已儲存'); void refreshQuotes();
  }
  function deleteHolding(id) {
    const h=state.holdings.find(x=>x.id===id); if(!h)return;
    if(!confirm(`確定刪除 ${h.symbol} ${h.name||''}？`))return;
    state.holdings=state.holdings.filter(x=>x.id!==id); persist(); renderAll(); renderHoldings(); closeModal('holdingModal'); notify('持倉已刪除');
  }
  function openSwapModal() {
    if(!state.holdings.length){notify('請先新增至少一筆持倉，再使用標的互換。');return;}
    $('swapFrom').innerHTML=state.holdings.map(h=>`<option value="${h.id}">${escapeHtml(h.symbol)}｜${escapeHtml(h.name||h.symbol)}（${money(marketValue(h))}）</option>`).join('');
    const h=state.holdings[0]; $('swapSymbol').value=''; $('swapName').value=''; $('swapBeta').value=Number(h.beta||1); $('swapPrice').value='0';
    $('swapPreview').innerHTML='<span>輸入新標的代號、Beta 與價格後，這裡會顯示互換結果。</span>';
    $('swapQuoteStamp').textContent='尚未取得新標的報價';
    openModal('swapModal');
  }
  function selectedSwapSource() { return state.holdings.find(h=>h.id===$('swapFrom').value); }
  function swapNumbers() {
    const from=selectedSwapSource(); if(!from)return null;
    const newPrice=Number($('swapPrice').value||0), newBeta=Number($('swapBeta').value||0), oldValue=marketValue(from), oldBeta=Number(from.beta||0);
    const mode=document.querySelector('input[name="swapMode"]:checked')?.value||'value';
    let newValue=oldValue;
    if(mode==='beta') newValue = newBeta!==0 ? oldValue*oldBeta/newBeta : NaN;
    const qty = newPrice>0 && Number.isFinite(newValue) ? newValue/newPrice : 0;
    return {from,newPrice,newBeta,oldValue,oldBeta,newValue,qty,mode,cashDifference:oldValue-newValue};
  }
  function updateSwapPreview() {
    const x=swapNumbers(); if(!x)return;
    if(!x.newPrice || !Number.isFinite(x.newValue) || !Number.isFinite(x.qty)) { $('swapPreview').innerHTML='<span>請輸入大於 0 的新標的價格，並確認新 Beta 不為 0（保留 Beta 曝險模式）。</span>'; return; }
    $('swapPreview').innerHTML=`<div>原持倉：<strong>${escapeHtml(x.from.symbol)}</strong> · 市值 ${money(x.oldValue)} · Beta ${betaFmt(x.oldBeta)}</div><div>新標的：<strong>${escapeHtml($('swapSymbol').value.trim().toUpperCase()||'—')}</strong> · 預估換入市值 ${money(x.newValue)} · Beta ${betaFmt(x.newBeta)}</div><div>預估換入數量：<strong>${number(x.qty)}</strong> 股</div><div>現金差額（原市值－新換入市值）：<strong style="color:${x.cashDifference>=0?'#14966d':'#c86b6b'}">${x.cashDifference>=0?'+':''}${money(x.cashDifference)}</strong></div>`;
    const cachedQuote = state.quoteCache[$('swapSymbol').value.trim().toUpperCase()];
    const usesCachedQuote = cachedQuote && Math.abs(Number(cachedQuote.price || 0) - x.newPrice) < 0.005;
    $('swapQuoteStamp').textContent = usesCachedQuote ? `計算採用報價 ${money2(x.newPrice)} · ${fmtTime(cachedQuote.quoteTime || cachedQuote.lastUpdated)} · ${cachedQuote.source || '既有報價'}` : `計算採用手動價格 ${money2(x.newPrice)}`;
  }
  async function fetchSwapQuote() {
    const symbol=$('swapSymbol').value.trim().toUpperCase(); if(!symbol){notify('請先輸入新標的代號');return;}
    try { const q=await fetchQuote(symbol); updateQuoteEverywhere(symbol,q); $('swapPrice').value=q.price; if(!$('swapName').value)$('swapName').value=q.name||symbol; updateSwapPreview(); persist(); renderAll(); notify(`已取得 ${symbol} 報價 ${money2(q.price)}`); }
    catch(e){notify(`取得報價失敗：${e.message}`);}
  }
  function applySwap(e) {
    e.preventDefault();
    const symbol=$('swapSymbol').value.trim().toUpperCase(), x=swapNumbers();
    if(!x || !symbol || !x.newPrice || !Number.isFinite(x.newValue) || x.newValue<0 || !Number.isFinite(x.qty)){notify('互換資料不完整，請檢查價格與 Beta。');return;}
    const other=state.holdings.find(h=>h.id!==x.from.id && h.symbol===symbol);
    const newName=$('swapName').value.trim()||state.quoteCache[symbol]?.name||symbol;
    if(other){
      const otherQty=Number(other.quantity||0), totalQty=otherQty+x.qty;
      const mergedCost=totalQty>0?((otherQty*Number(other.cost||0))+(x.qty*x.newPrice))/totalQty:0;
      other.quantity=totalQty; other.cost=mergedCost; other.name=newName; other.beta=x.newBeta; other.category=x.from.category; other.quote=state.quoteCache[symbol]||other.quote||null;
      state.holdings=state.holdings.filter(h=>h.id!==x.from.id);
    }else{
      const newHolding={...x.from,symbol,name:newName,beta:x.newBeta,quantity:x.qty,manualPrice:x.newPrice,quote:state.quoteCache[symbol]||null};
      state.holdings=state.holdings.map(h=>h.id===x.from.id?newHolding:h);
    }
    persist(); closeModal('swapModal'); renderAll(); notify(`已將 ${x.from.symbol} 替換為 ${symbol}（僅更新模型持倉）`); void refreshQuotes();
  }
  function estimateBeta() {
    const symbol = MarketQuotes.symbol($('assetSymbol').value);
    if (!symbol) return notify('請先輸入股票代號');
    if (symbol === MarketQuotes.symbol(state.settings.benchmark)) {
      $('assetBeta').value = '1';
      return notify('基準標的 Beta 為 1.00');
    }
    notify('尚無永豐還原日 K 可估算，請使用既有或手動輸入的 Beta。');
  }
  function saveCash() {
    const value=Number($('cashBalanceInput').value);
    if(!Number.isFinite(value)||value<0){notify('現金餘額需為 0 或正數');return;}
    state.cash=value;persist();renderAll();renderHoldings();notify('現金餘額已更新');
  }
  function saveSettings() {
    const targetBeta=Number($('settingTargetBeta').value), tolerance=Number($('settingTolerance').value);
    const target={lever:Number($('targetLever').value),core:Number($('targetCore').value),cash:Number($('targetCash').value)};
    const total=target.lever+target.core+target.cash;
    if(!Number.isFinite(targetBeta)||targetBeta<0||targetBeta>5){notify('目標 Beta 請設定在 0～5');return false;}
    if(!Number.isFinite(tolerance)||tolerance<0||tolerance>50){notify('容許偏離幅度請設定在 0～50%');return false;}
    if(Object.values(target).some(x=>!Number.isFinite(x)||x<0||x>100)||total!==100){notify('目標配置三項比例合計必須剛好為 100%');return false;}
    state.settings={...state.settings,targetBeta,tolerance,target,benchmark:$('benchmarkSymbol').value.trim().toUpperCase()||'0050'};
    persist(); startQuoteTimer(); updateApiStatusUi(); renderAll(); void refreshQuotes(); notify('設定已儲存'); $('settingsSaveStatus').textContent='已儲存'; return true;
  }
  function saveSnapshot() {
    const p=getPortfolio(), total=p.total||0;
    if(!total){notify('目前資產總值為 0，尚無可儲存的快照。');return;}
    const row={date:today(),total,beta:p.beta,leverPct:total?p.lever/total*100:0,corePct:total?p.core/total*100:0,cashPct:total?p.cash/total*100:0,holdings:state.holdings.map(h=>({symbol:h.symbol,quantity:h.quantity,price:priceOf(h),beta:h.beta,category:h.category})),cash:state.cash};
    const idx=state.history.findIndex(x=>x.date===row.date);
    if(idx>=0)state.history[idx]=row; else state.history.push(row);
    persist();renderHistory();notify(`${row.date} 的資產快照已儲存`);
  }
  function csvDownload(filename, rows) {
    const csv='\uFEFF'+rows.map(row=>row.map(value=>`"${String(value??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  }
  function exportHoldings() {
    const rows=[['代號','名稱','分類','數量','成本均價','目前價格','市值','Beta','報價時間','52 週最高價','高點日期','回到高點需漲%'],...state.holdings.map(h=>{const high=holdingHighOf(h.symbol),gain=MarketQuotes.gainToHigh(priceOf(h),high?.highPrice);return [h.symbol,h.name,categoryName(h.category),h.quantity,h.cost,priceOf(h),marketValue(h),h.beta,fmtTime(h.quote?.quoteTime||h.quote?.lastUpdated),high?.highPrice,high?.highPriceDate,gain?.toFixed(2)];})];
    csvDownload(`exposure-manager-holdings-${today()}.csv`,rows);
  }
  function exportHistory() {
    const rows=[['日期','總資產','整體Beta','槓桿比例%','原形比例%','現金比例%'],...state.history.sort((a,b)=>a.date.localeCompare(b.date)).map(x=>[x.date,x.total,x.beta,x.leverPct,x.corePct,x.cashPct])];
    csvDownload(`exposure-manager-history-${today()}.csv`,rows);
  }
  function backupData() {
    const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`exposure-manager-backup-${today()}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);notify('備份檔已下載');
  }
  async function restoreData(file) {
    try{const data=JSON.parse(await file.text());if(!data||!Array.isArray(data.holdings)||!data.settings)throw new Error('備份檔格式不正確');
      if(!confirm('匯入資料會覆蓋目前持倉與設定；歷史依日期合併，同一天以備份為準。確定繼續？'))return;
      const mergedHistory=new Map(state.history.map(row=>[row.date,row]));
      (Array.isArray(data.history)?data.history:[]).forEach(row=>mergedHistory.set(row.date,row));
      state={...clone(defaults),...data,history:[...mergedHistory.values()],settings:{...clone(defaults.settings),...data.settings,target:{...clone(defaults.settings.target),...(data.settings.target||{})}}};persist();renderAll();renderSettings();notify('資料備份已匯入');
    }catch(e){notify(`匯入失敗：${e.message}`);}
  }
  function bindEvents() {
    document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',()=>setPage(el.dataset.page)));
    document.querySelectorAll('[data-goto]').forEach(el=>el.addEventListener('click',()=>setPage(el.dataset.goto)));
    document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>closeModal(el.dataset.close)));
    document.querySelectorAll('.modal-backdrop').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)closeModal(el.id);}));
    const gotoHoldingSettings=()=>{settingsSection='holdings';setPage('settings');};
    $('quickAddBtn').addEventListener('click',gotoHoldingSettings);
    $('overviewManageHoldingsBtn').addEventListener('click',gotoHoldingSettings);
    $('overviewHoldingSearch').addEventListener('input',renderOverview);
    $('overviewExportCsvBtn').addEventListener('click',exportHoldings);
    $('addHoldingBtn').addEventListener('click',openAddHolding);
    $('holdingForm').addEventListener('submit',saveHolding);
    $('assetCategory').addEventListener('change',()=>{ $('assetBeta').value = $('assetCategory').value === 'lever' ? 2 : $('assetCategory').value === 'cash' ? 0 : 1; });
    $('deleteHoldingBtn').addEventListener('click',()=>deleteHolding($('editHoldingId').value));
    $('holdingsBody').addEventListener('click',e=>{const edit=e.target.closest('[data-edit]');const del=e.target.closest('[data-delete]');if(edit)openEditHolding(edit.dataset.edit);if(del)deleteHolding(del.dataset.delete);});
    $('holdingSearch').addEventListener('input',renderHoldings);
    $('swapOpenBtn').addEventListener('click',openSwapModal);$('rebalanceSwapBtn').addEventListener('click',openSwapModal);
    $('swapFrom').addEventListener('change',()=>{const h=selectedSwapSource();if(h){$('swapBeta').value=h.beta;updateSwapPreview();}});
    ['swapSymbol','swapBeta','swapPrice'].forEach(id=>$(id).addEventListener('input',updateSwapPreview));
    $('swapSymbol').addEventListener('change',()=>{ clearTimeout(swapSymbolDebounce); swapSymbolDebounce=setTimeout(()=>fetchSwapQuote(),250); });
    document.querySelectorAll('input[name="swapMode"]').forEach(el=>el.addEventListener('change',updateSwapPreview));
    $('fetchSwapQuoteBtn').addEventListener('click',fetchSwapQuote);$('swapForm').addEventListener('submit',applySwap);
    $('estimateBetaBtn').addEventListener('click',estimateBeta);
    $('saveSettingsBtn').addEventListener('click',saveSettings);
    $('settingTargetBeta').addEventListener('change',()=>{ $('settingsSaveStatus').textContent='尚有未儲存變更'; });
    $('settingTolerance').addEventListener('change',()=>{ $('settingsSaveStatus').textContent='尚有未儲存變更'; });
    ['targetLever','targetCore','targetCash'].forEach(id=>$(id).addEventListener('input',()=>{updateTargetTotal();$('settingsSaveStatus').textContent='尚有未儲存變更';}));
    $('benchmarkSymbol').addEventListener('change',()=>{$('settingsSaveStatus').textContent='尚有未儲存變更';});
    $('refreshAllBtn').addEventListener('click',()=>refreshQuotes(true));
    $('marketRefreshBtn').addEventListener('click',()=>notify('52 週走勢顯示既有資料，等待可核對的還原日 K。'));
    $('marketRanges').addEventListener('click', event => {
      const button = event.target.closest('button[data-range]');
      if (!button) return;
      marketRangeMonths = Number(button.dataset.range);
      renderMarketCard();
    });
    $('checkApiBtn').addEventListener('click',()=>refreshQuotes(true));
    $('pairNgrokBtn').addEventListener('click', pairNgrokQuotes);
    $('shioajiPairForm').addEventListener('submit', pairRemoteQuotes);
    $('clearShioajiRemoteBtn').addEventListener('click', clearRemoteQuotes);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopMarketStream();
      else void refreshQuotes();
    });
    $('saveSnapshotBtn').addEventListener('click',saveSnapshot);$('historyExportBtn').addEventListener('click',exportHistory);$('exportCsvBtn').addEventListener('click',exportHoldings);
    $('historyBody').addEventListener('click',e=>{const btn=e.target.closest('[data-delete-history]');if(!btn)return;const date=btn.dataset.deleteHistory;if(confirm(`確定刪除 ${date} 的快照？`)){state.history=state.history.filter(x=>x.date!==date);persist();renderHistory();}});
    $('clearHistoryBtn').addEventListener('click',()=>{if(confirm('確定清除所有歷史快照？建議先匯出 CSV。')){state.history=[];persist();renderHistory();notify('歷史紀錄已清除');}});
    $('backupBtn').addEventListener('click',backupData);$('restoreInput').addEventListener('change',e=>{if(e.target.files?.[0])restoreData(e.target.files[0]);e.target.value='';});
    $('resetAllBtn').addEventListener('click',()=>{if(confirm('確定清空全部持倉、設定與歷史紀錄？此操作無法復原，建議先下載備份。')){state=clone(defaults);persist();renderAll();renderSettings();notify('所有資料已清空');}});
    $('printPlanBtn').addEventListener('click',()=>window.print());
    document.querySelectorAll('[data-tip]').forEach(el=>el.addEventListener('click',()=>notify(el.dataset.tip)));
    document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.modal-backdrop.open').forEach(x=>closeModal(x.id));});
  }

  // Add a cash-balance editor to the holdings workspace.
  function initCashEditor() {
    const page=$('page-holdings');
    const strip=document.createElement('div');strip.className='cash-input-strip';strip.innerHTML='<div><strong>現金餘額</strong><small>與證券持倉合併計入總資產</small></div><div class="cash-input-control"><span>NT$</span><input id="cashBalanceInput" type="number" min="0" step="1" value="0"><button class="secondary-button small" id="saveCashBalanceBtn">更新現金</button></div>';
    page.insertBefore(strip,page.children[1]);
    $('cashBalanceInput').value=Number(state.cash||0);
    $('saveCashBalanceBtn').addEventListener('click',saveCash);
  }

  const rebalanceUi={beta:null,mode:'normal',precision:1000,excluded:new Set(),from:'',to:'',confirmation:''};
  function applyRebalancePlan(plan) {
    state.rebalanceUndo={at:new Date().toISOString(),holdings:clone(state.holdings),cash:state.cash,cashUsd:state.cashUsd||0};
    plan.rows.forEach(row=>{row.h.quantity=Math.max(0,row.before+row.delta);});state.cash=plan.cash;
    state.rebalanceLog=state.rebalanceLog||[];state.rebalanceLog.push({at:new Date().toISOString(),mode:rebalanceUi.mode,beforeBeta:plan.p.beta,afterBeta:plan.beta,precision:rebalanceUi.precision,trades:plan.rows.filter(row=>row.delta).map(row=>({symbol:row.h.symbol,quantity:row.delta,price:row.price}))});
    persist();
  }
  function undoRebalancePlan() {
    const undo=state.rebalanceUndo;if(!undo)return;
    state.holdings=clone(undo.holdings);state.cash=undo.cash;state.cashUsd=undo.cashUsd;delete state.rebalanceUndo;persist();
  }
  function rebalancePreview() {
    const p=getPortfolio(), desired=rebalanceUi.beta??Number(state.settings.targetBeta);
    const rows=state.holdings.filter(h=>h.symbol).map(h=>({h,price:priceOf(h),before:Number(h.quantity||0),delta:0}));
    const warnings=[];
    let cash=Number(state.cash||0);
    if(rows.some(row=>row.before>0&&!(row.price>0)))warnings.push('部分持股尚無價格，請更新行情或填寫手動價格。');
    const units=row=>(row.h.currency&&row.h.currency!=='TWD')?1:rebalanceUi.precision;
    if(rebalanceUi.mode==='swap') {
      const sell=rows.find(row=>row.h.id===rebalanceUi.from), buy=rows.find(row=>row.h.id===rebalanceUi.to);
      if(!sell||!buy||sell===buy)warnings.push('請選擇不同的賣出與買入標的。');
      else if((sell.h.currency||'TWD')!==(buy.h.currency||'TWD') || (sell.h.currency||'TWD')!=='TWD')warnings.push('目前互換支援同為新台幣計價的標的。');
      else if(sell.price>0&&buy.price>0) {
        const difference=Number(buy.h.beta||0)-Number(sell.h.beta||0);
        const amount=Math.abs(difference)>1e-9?(desired-p.beta)*p.total/difference:0;
        if(Math.abs(difference)<1e-9)warnings.push('兩檔標的 Beta 相同，互換無法改變整體 Beta。');
        else if(amount<-.01)warnings.push('此互換方向無法接近指定 Beta，請對調賣出與買入標的。');
        else {
          sell.delta=-Math.min(Math.floor(sell.before/units(sell))*units(sell),Math.floor(Math.max(0,amount)/sell.price/units(sell))*units(sell));
          const proceeds=-sell.delta*sell.price;
          buy.delta=Math.floor((proceeds+1e-7)/buy.price/units(buy))*units(buy);
          cash+=proceeds-buy.delta*buy.price;
        }
      }
    } else {
      const savedTarget=clone(state.settings.target), savedBeta=state.settings.targetBeta, savedMode=state.settings.allocationMode;
      let ideal;
      try {state.settings.targetBeta=desired;state.settings.allocationMode='beta';syncModelTargets();ideal=calculateRebalance();}
      finally {state.settings.target=savedTarget;state.settings.targetBeta=savedBeta;state.settings.allocationMode=savedMode;}
      // Frozen positions still count toward their category target. Redistribute
      // only the remaining target among tradable, checked positions.
      ['lever','core','cash'].forEach(category=>{
        const group=rows.filter(row=>row.h.category===category);
        const eligible=group.filter(row=>!rebalanceUi.excluded.has(row.h.id)&&row.price>0);
        const fixedValue=group.filter(row=>!eligible.includes(row)).reduce((sum,row)=>sum+row.before*row.price,0);
        // Real cash remains the funding balance, not a security to buy.
        const entries=ideal.entries.filter(entry=>entry.category===category&&!entry.isCashBalance);
        const groupTarget=entries.reduce((sum,entry)=>sum+entry.target,0);
        const remainingTarget=Math.max(0,groupTarget-fixedValue);
        const weights=eligible.map(row=>Math.max(0,entries.find(entry=>entry.id===row.h.id)?.target||0));
        const weightSum=weights.reduce((sum,weight)=>sum+weight,0);
        if(fixedValue>groupTarget+.01&&group.some(row=>rebalanceUi.excluded.has(row.h.id)))warnings.push(`${categoryName(category)}未勾選持股的市值已超過該類目標，無法只靠已勾選標的達成配置。`);
        eligible.forEach((row,index)=>{
          const weight=weightSum>0?weights[index]/weightSum:1/eligible.length;
          const target=remainingTarget*weight;
          const change=(target/row.price)-row.before;
          row.delta=Math.trunc(change/units(row)+Math.sign(change)*1e-9)*units(row);
          row.delta=Math.max(-Math.floor(row.before/units(row))*units(row),row.delta);
        });
      });
      rows.filter(row=>row.delta<0).forEach(row=>cash-=row.delta*row.price);
      const buys=rows.filter(row=>row.delta>0), cost=buys.reduce((sum,row)=>sum+row.delta*row.price,0);
      const scale=cost>0?Math.min(1,Math.max(0,cash)/cost):1;
      if(scale<1)warnings.push('可用台幣不足，買進股數已依現有台幣與賣出所得調降；美元現金不會自動換匯。');
      buys.forEach(row=>{row.delta=Math.floor((row.delta*scale+1e-9)/units(row))*units(row);cash-=row.delta*row.price;});
    }
    cash=Math.max(0,cash);
    const total=rows.reduce((sum,row)=>sum+(row.before+row.delta)*row.price,0)+cash+Number(state.cashUsd||0)*Number(state.usdTwd||0);
    const beta=total?rows.reduce((sum,row)=>sum+(row.before+row.delta)*row.price*Number(row.h.beta||0),0)/total:0;
    if(p.total>0&&Math.abs(beta-desired)>.005)warnings.push('目前勾選範圍或交易精度無法完全達成指定 Beta。');
    return {p,desired,rows,cash,beta,total,warnings,operations:rows.filter(row=>Math.abs(row.delta)>1e-8).length};
  }
  function renderFamiliarRebalance() {
    let root=$('familiarRebalance');
    if(!root){
      const page=$('page-rebalance');[...page.children].forEach(child=>child.hidden=true);
      root=document.createElement('div');root.id='familiarRebalance';page.append(root);
      root.addEventListener('click',event=>{
        const button=event.target.closest('button');if(!button)return;
        if(button.dataset.rbmode){rebalanceUi.mode=button.dataset.rbmode;renderFamiliarRebalance();}
        if(button.dataset.rbstep){rebalanceUi.beta=Math.max(0,Math.min(5,Math.round(((rebalanceUi.beta??state.settings.targetBeta)+Number(button.dataset.rbstep))*100)/100));renderFamiliarRebalance();}
        if(button.hasAttribute('data-rbreset')){rebalanceUi.beta=null;renderFamiliarRebalance();}
        if(button.hasAttribute('data-rbhelp'))notify('先指定 Beta、選擇方式與精度，勾選要調整的標的，確認預覽後套用；整張為 1,000 股、整股為 1 股。套用只更新本站模擬資料。');
        if(button.hasAttribute('data-rbapply')){rebalanceUi.confirmation='apply';renderFamiliarRebalance();return;}
        if(button.hasAttribute('data-rbundo')){rebalanceUi.confirmation='undo';renderFamiliarRebalance();return;}
        if(button.hasAttribute('data-rbcancel')){rebalanceUi.confirmation='';renderFamiliarRebalance();return;}
        if(button.dataset.rbconfirm==='apply'){
          const plan=rebalancePreview();if(!plan.operations)return;
          rebalanceUi.confirmation='';
          applyRebalancePlan(plan);renderAll();notify('已套用模擬再平衡，復原點已保留。');
        }
        if(button.dataset.rbconfirm==='undo'&&state.rebalanceUndo){
          rebalanceUi.confirmation='';
          undoRebalancePlan();renderAll();notify('已復原上次再平衡');
        }
      });
      root.addEventListener('change',event=>{
        rebalanceUi.confirmation='';
        const input=event.target;
        if(input.hasAttribute('data-rbbeta')){const value=Number(input.value);if(!Number.isFinite(value)||value<0||value>5){notify('Beta 請填 0～5');return;}rebalanceUi.beta=value;}
        if(input.name==='rbprecision')rebalanceUi.precision=Number(input.value);
        if(input.dataset.rbselect){input.checked?rebalanceUi.excluded.delete(input.dataset.rbselect):rebalanceUi.excluded.add(input.dataset.rbselect);}
        if(input.hasAttribute('data-rbfrom')){rebalanceUi.from=input.value;rebalanceUi.to='';}
        if(input.hasAttribute('data-rbto'))rebalanceUi.to=input.value;
        renderFamiliarRebalance();
      });
    }
    const plan=rebalancePreview(), target=Number(state.settings.targetBeta), tol=Number(state.settings.tolerance);
    const status=plan.p.beta<target*(1-tol/100)?'需增加 Beta':plan.p.beta>target*(1+tol/100)?'需降低 Beta':'容忍區間內';
    const deltaLabel=value=>Math.abs(value)<.01?'不需調整':`${value>0?'買進':'賣出'} ${money(Math.abs(value))}`;
    const options=(filter)=>'<option value="">請選擇標的</option>'+plan.rows.filter(filter).map(row=>`<option value="${escapeHtml(row.h.id)}">${escapeHtml(row.h.symbol)} · ${betaFmt(row.h.beta)}× · ${row.h.currency||'TWD'}</option>`).join('');
    root.innerHTML=`<article class="panel rb-controls"><div class="panel-top"><h2>再平衡參數設定</h2><button class="info-button" data-rbhelp aria-label="查看再平衡操作說明">i</button></div><p class="helper-text">共 ${plan.operations} 筆操作，金額依目前交易精度估算。${rebalanceUi.mode==='normal'?' 未勾選持股維持不動，同類別差額會重新分配給已勾選標的。':''}</p><div class="rb-status">目前狀態 <strong>${status}</strong></div><div class="familiar-step"><label>再平衡到 Beta <small>每次 ±0.01</small></label><button data-rbstep="-0.01" aria-label="降低再平衡 Beta 0.01">−</button><input type="number" min="0" max="5" step="0.01" data-rbbeta aria-label="再平衡到 Beta" value="${plan.desired}"><button data-rbstep="0.01" aria-label="提高再平衡 Beta 0.01">＋</button></div><button class="text-button" data-rbreset>回到目標 Beta ${betaFmt(target)}</button><div class="familiar-switch"><span>再平衡方式</span><button data-rbmode="normal" aria-pressed="${rebalanceUi.mode==='normal'}">一般再平衡</button><button data-rbmode="swap" aria-pressed="${rebalanceUi.mode==='swap'}">標的互換</button></div>${rebalanceUi.mode==='swap'?`<div class="rb-swap"><h3>選擇互換標的</h3><p>同幣別一賣一買，其他持股不調整；零股差額留在現金。</p><div class="familiar-fields"><label>賣出標的<select data-rbfrom aria-label="賣出標的">${options(row=>row.before>0)}</select></label><label>買入標的<select data-rbto aria-label="買入標的">${options(row=>row.h.id!==rebalanceUi.from)}</select></label></div><p class="field-note">買入標的需先在設定的持股清單新增，股數可填 0。</p></div>`:''}<h3>Beta 變化</h3><div class="rb-beta-flow"><div><span>目前 Beta</span><strong>${betaFmt(plan.p.beta)}</strong></div><b>→</b><div><span>再平衡後 Beta</span><strong>${betaFmt(plan.beta)}</strong></div><b>→</b><div><span>目標 Beta</span><strong>${betaFmt(target)}</strong></div></div><p class="rb-tolerance">容忍區間 ${(target*(1-tol/100)).toFixed(2)} – ${(target*(1+tol/100)).toFixed(2)}</p><h3>預估資金變化</h3><div class="rb-funds">${['lever','core','cash'].map(cat=>`<div><span>${cat==='cash'?'類現金 ETF':categoryName(cat)}</span><strong>${deltaLabel(plan.rows.filter(row=>row.h.category===cat).reduce((sum,row)=>sum+row.delta*row.price,0))}</strong></div>`).join('')}<div><span>台幣現金</span><strong>${money(state.cash)} → ${money(plan.cash)}</strong></div><div><span>美元現金</span><strong>US$${number(state.cashUsd||0)} · 無變化</strong></div></div><h3>台股交易精度</h3><fieldset class="cash-reasons" aria-label="再平衡精度"><label><input type="radio" name="rbprecision" value="1000" ${rebalanceUi.precision===1000?'checked':''}>精確到張數</label><label><input type="radio" name="rbprecision" value="1" ${rebalanceUi.precision===1?'checked':''}>精確到股數</label></fieldset>${plan.warnings.map(w=>`<p class="migration-note">${escapeHtml(w)}</p>`).join('')}</article><div class="rb-lists">${['lever','core','cash'].map(cat=>{
      const rows=plan.rows.filter(row=>row.h.category===cat);if(!rows.length)return '';
      const before=rows.reduce((s,row)=>s+row.before*row.price,0),after=rows.reduce((s,row)=>s+(row.before+row.delta)*row.price,0);
      return `<article class="panel rb-group"><h2>${cat==='cash'?'類現金':categoryName(cat)}再平衡清單</h2><p class="helper-text">${rows.length} 檔標的 ／ 調整後市值 ${money(after)} · 目前 ${pct(plan.p.total?before/plan.p.total*100:0)} → 調整後 ${pct(plan.total?after/plan.total*100:0)}</p>${rows.map(row=>`<div class="rb-stock"><div class="rb-stock-head">${rebalanceUi.mode==='normal'?`<input type="checkbox" data-rbselect="${escapeHtml(row.h.id)}" aria-label="${escapeHtml(row.h.symbol)} 是否納入本次再平衡" ${rebalanceUi.excluded.has(row.h.id)?'':'checked'}>`:''}<div><strong>${escapeHtml(row.h.symbol)} ${escapeHtml(row.h.name||'')}</strong><small>股價 ${money2(row.price)} · 市值 ${money(row.before*row.price)}</small></div><b class="${row.delta>0?'trade-buy':row.delta<0?'trade-sell':''}">${row.delta?`${row.delta>0?'買進':'賣出'} ${number(Math.abs(row.delta))} 股`:'不動作'}</b></div><div class="rb-share"><span>股數 ${number(row.before)} → ${number(row.before+row.delta)}</span><span>目前 ${pct(before?row.before*row.price/before*100:0)} → 再平衡後 ${pct(after?(row.before+row.delta)*row.price/after*100:0)}</span></div></div>`).join('')}</article>`;
    }).join('')}</div><article class="panel rb-apply"><h3>確認清單後套用</h3><p>依上方精度更新本站持股與現金，套用前自動保留復原點。估算未計交易成本；可至現金頁補登。</p><button class="primary-button" data-rbapply ${!plan.operations||plan.rows.some(row=>row.before>0&&!(row.price>0))?'disabled':''}>套用再平衡結果</button>${state.rebalanceUndo?'<button class="secondary-button" data-rbundo>復原上次再平衡</button>':''}</article>`;
    decorateRebalanceDisplay(root,plan);
    if(rebalanceUi.confirmation){
      const box=document.createElement('div');box.className='migration-note';box.setAttribute('role','alert');
      box.innerHTML=rebalanceUi.confirmation==='apply'?`<p>確認套用 ${plan.operations} 筆模擬調整：台幣 ${money(state.cash)} → ${money(plan.cash)}；Beta ${betaFmt(plan.p.beta)} → ${betaFmt(plan.beta)}。只更新本站資料。</p><button class="primary-button" data-rbconfirm="apply">確認套用</button><button class="secondary-button" data-rbcancel>取消</button>`:'<p>復原上次套用前的持股、台幣與美元現金，套用後另行修改的持股與現金也會還原。</p><button class="primary-button" data-rbconfirm="undo">確認復原</button><button class="secondary-button" data-rbcancel>取消</button>';
      root.querySelector('.rb-apply').append(box);
    }
    if(root.querySelector('[data-rbfrom]'))root.querySelector('[data-rbfrom]').value=rebalanceUi.from;
    if(root.querySelector('[data-rbto]'))root.querySelector('[data-rbto]').value=rebalanceUi.to;
  }
  function decorateRebalanceDisplay(root,plan) {
    const controls=root.querySelector('.rb-controls');
    const heading=controls.querySelector('.panel-top');
    heading.classList.add('rb-reference-heading');
    const info=heading.querySelector('button');
    heading.querySelector('h2').append(info);
    heading.append(controls.querySelector('.rb-status'));
    const paramBox=document.createElement('div');paramBox.className='rb-reference-parameters';
    const step=controls.querySelector('.familiar-step'), reset=controls.querySelector('[data-rbreset]');
    step.append(reset);paramBox.append(step,controls.querySelector('.familiar-switch'));
    const swap=controls.querySelector('.rb-swap');if(swap)paramBox.append(swap);
    controls.querySelector(':scope > .helper-text').after(paramBox);
    const flow=controls.querySelector('.rb-beta-flow'), tolerance=controls.querySelector('.rb-tolerance'),flowTitle=flow.previousElementSibling;
    const flowBox=document.createElement('section');flowBox.className='rb-reference-section';
    flowTitle.before(flowBox);flowBox.append(flowTitle);
    flowBox.append(flow);flow.querySelector('div:last-child').append(tolerance);
    flow.querySelectorAll(':scope > div').forEach((cell,index)=>{if(index){const arrow=document.createElement('span');arrow.className='rb-flow-arrow';arrow.textContent='→';cell.append(arrow);}});
    const funds=controls.querySelector('.rb-funds'), fundTitle=funds.previousElementSibling;
    const fundBox=document.createElement('section');fundBox.className='rb-reference-section';fundTitle.before(fundBox);fundBox.append(fundTitle,funds);
    const precision=controls.querySelector('[aria-label="再平衡精度"]'), precisionTitle=precision.previousElementSibling;
    const precisionBox=document.createElement('section');precisionBox.className='rb-reference-precision';precisionTitle.before(precisionBox);precisionBox.append(precisionTitle,precision);
    const groups=[...root.querySelectorAll('.rb-group')];
    groups.forEach(group=>{
      const title=group.querySelector('h2'), label=title.textContent;
      const category=label.startsWith('槓桿')?'lever':label.startsWith('原形')?'core':'cash';
      group.classList.add(`rb-category-${category}`);
      const rows=plan.rows.filter(row=>row.h.category===category);
      const before=rows.reduce((sum,row)=>sum+row.before*row.price,0),after=rows.reduce((sum,row)=>sum+(row.before+row.delta)*row.price,0);
      const subtitle=group.querySelector(':scope > .helper-text');
      subtitle.textContent=`${rows.length} 檔標的 ／ 調整後市值 ${money(after)}`;
      const header=document.createElement('div');header.className='rb-group-heading';
      title.before(header);const text=document.createElement('div');text.append(title,subtitle);header.append(text);
      const ratios=document.createElement('div');ratios.className='rb-group-ratios';
      ratios.innerHTML=`<span>目前 ${pct(plan.p.total?before/plan.p.total*100:0)}</span><strong>調整後 ${pct(plan.total?after/plan.total*100:0)}</strong>`;header.append(ratios);
      group.querySelectorAll('.rb-stock').forEach((card,index)=>{
        const row=rows[index], head=card.querySelector('.rb-stock-head'),meta=head.querySelector('div');
        meta.className='rb-stock-info';
        meta.querySelector('strong').innerHTML=`${escapeHtml(row.h.symbol)} ${category==='lever'?`<span class="rb-leverage-badge">${number(row.h.beta)}×</span>`:''}`;
        const quote=row.h.quote||state.quoteCache[row.h.symbol];
        meta.querySelector('small').textContent=row.h.name||row.h.symbol;
        const detail=document.createElement('small');detail.textContent=`市值 ${money(row.before*row.price)}`;meta.append(detail);
        const stamp=document.createElement('small');stamp.textContent=`股價 ${money2(row.price)}${quote?.date?` · 更新 ${quote.date}`:''}`;meta.append(stamp);
        head.prepend(meta);
        const progress=document.createElement('div');progress.className='rb-proportion';
        const current=before?row.before*row.price/before*100:0, next=after?(row.before+row.delta)*row.price/after*100:0;
        progress.innerHTML=`<div class="rb-proportion-track" role="img" aria-label="目前 ${pct(current)}，再平衡後 ${pct(next)}"><div style="width:${Math.max(0,Math.min(100,current))}%"></div><i style="left:${Math.max(0,Math.min(100,next))}%"></i></div><div class="rb-proportion-labels"><span>目前 ${pct(current)}</span><span>再平衡後 ${pct(next)}</span></div><small>股數 ${number(row.before)} → ${number(row.before+row.delta)}</small>`;
        head.insertBefore(progress,head.querySelector(':scope > b'));
        card.querySelector('.rb-share').hidden=true;
      });
    });
  }
  let settingsSection = 'cash';
  let cashAdjustmentDraft={currency:'TWD',amount:''};
  function cashAdjustmentPreview(currency,raw,reason=state.cashReason||'flow') {
    if(!['TWD','USD'].includes(currency)||!['cost','flow','correction'].includes(reason))throw new Error('請選擇有效幣別與變動原因');
    if(raw==null||String(raw).trim()==='')throw new Error('請輸入變動金額；負數扣款，正數入金');
    const delta=Number(raw),minor=Math.round(delta*100);
    if(!Number.isFinite(delta)||!Number.isSafeInteger(minor)||Math.abs(delta*100-minor)>1e-6||minor===0)throw new Error('請輸入非零金額，最多兩位小數');
    if(reason==='cost'&&minor>=0)throw new Error('手續費／交易成本請輸入負數，例如 -100');
    const key=currency==='TWD'?'cash':'cashUsd',before=Number(state[key]||0),beforeMinor=Math.round(before*100);
    if(!Number.isSafeInteger(beforeMinor)||beforeMinor<0||!Number.isSafeInteger(beforeMinor+minor))throw new Error('現金餘額無效，請先修正餘額');
    if(Math.abs(before*100-beforeMinor)>1e-6)throw new Error('請先將目前現金餘額修正為最多兩位小數');
    const after=(beforeMinor+minor)/100;
    if(after<0)throw new Error(`${currency} 現金餘額不足，這筆扣款會超過目前餘額`);
    const fx=currency==='USD'?Number(state.usdTwd):1;
    if((!Number.isFinite(fx)||!(fx>0))&&currency==='USD')throw new Error('請先設定有效的 USD/TWD 匯率');
    return {key,currency,before,after,delta:minor/100,reason,fx,assetChangeTwd:minor/100*fx};
  }
  function applyCashAdjustment(currency,raw,reason) {
    const plan=cashAdjustmentPreview(currency,raw,reason);
    const changes=Array.isArray(state.cashChanges)?state.cashChanges:[];
    const entry={at:new Date().toISOString(),currency:plan.currency,before:plan.before,after:plan.after,delta:plan.delta,reason:plan.reason,source:'adjustment',fx:plan.fx,assetChangeTwd:plan.assetChangeTwd};
    state.cashChanges=[...changes,entry];state[plan.key]=plan.after;
    return plan;
  }
  function cashAdjustmentEditor() {
    const latest=state.cashChanges?.at(-1),labels={cost:'手續費／交易成本',flow:'新資金投入／提領',correction:'資料修正'};
    const recent=latest?`<p class="field-note">最近一筆：${escapeHtml(labels[latest.reason]||'現金變動')} · ${escapeHtml(latest.currency)} ${number(Number(latest.after)-Number(latest.before))}；餘額 ${number(latest.before)} → ${number(latest.after)}</p>`:'';
    return `<section class="cash-adjustment" aria-labelledby="cashAdjustmentTitle"><h3 id="cashAdjustmentTitle">記錄一筆現金變動</h3><p class="field-note">上方是目前餘額；這裡填本次增加或減少的金額。手續費請填負數，例如 -100。輸入時只預覽，按「套用現金變動」才會扣款一次。</p><div class="familiar-fields"><label>變動幣別<select id="cashAdjustmentCurrency" aria-label="變動幣別"><option value="TWD" ${cashAdjustmentDraft.currency==='TWD'?'selected':''}>新台幣 TWD</option><option value="USD" ${cashAdjustmentDraft.currency==='USD'?'selected':''}>美金 USD</option></select></label><label>變動金額<input id="cashAdjustmentAmount" type="number" step="0.01" value="${escapeHtml(cashAdjustmentDraft.amount)}" placeholder="例如 -100" aria-describedby="cashAdjustmentPreview" /></label></div><p class="field-note" id="cashAdjustmentPreview" role="status"></p><button type="button" class="secondary-button" data-apply-cash-adjustment disabled>套用現金變動</button>${recent}</section>`;
  }
  function renderCashAdjustmentPreview() {
    const preview=$('cashAdjustmentPreview'),button=document.querySelector('[data-apply-cash-adjustment]');if(!preview||!button)return;
    try {
      const plan=cashAdjustmentPreview(cashAdjustmentDraft.currency,cashAdjustmentDraft.amount);
      preview.textContent=`${plan.currency} 現金 ${number(plan.before)} → ${number(plan.after)}；總資產${plan.delta<0?'減少':'增加'} NT$${number(Math.abs(plan.assetChangeTwd))}。`;
      button.disabled=false;
    } catch(error){preview.textContent=error.message;button.disabled=true;}
  }
  function groupWeights(category) {
    const holdings = state.holdings.filter(h=>h.category===category && h.symbol);
    const custom = category==='cash' ? state.settings.cashMode==='custom' : state.settings.distribution?.[category] === 'custom';
    const values = holdings.map(h=>custom ? Math.max(0,Number(h.targetWeight||0)) : marketValue(h));
    const total = values.reduce((a,b)=>a+b,0);
    return holdings.map((h,i)=>({h,weight:total ? values[i]/total : 1/holdings.length}));
  }
  function syncModelTargets() {
    if (state.settings.allocationMode !== 'beta') return;
    const core = groupWeights('core'), lever = groupWeights('lever');
    const corePct = core.length ? Math.max(0,Math.min(100,Number(state.settings.coreTarget||0))) : 0;
    const coreBeta = core.reduce((sum,x)=>sum+x.weight*Number(x.h.beta||0),0);
    const leverBeta = lever.reduce((sum,x)=>sum+x.weight*Number(x.h.beta||0),0);
    const required = leverBeta > 0 ? (Number(state.settings.targetBeta)-corePct/100*coreBeta)/leverBeta*100 : 0;
    const leverPct = Math.max(0,Math.min(100-corePct,required));
    state.settings.target = {core:corePct,lever:leverPct,cash:100-corePct-leverPct};
  }
  function renderFamiliarSummary() {
    if (!$('familiarSummary')) return;
    syncModelTargets();
    const t=targetRatios();
    $('settingTargetBeta').value=state.settings.targetBeta;
    $('settingTolerance').value=state.settings.tolerance;
    $('targetLever').value=t.lever;$('targetCore').value=t.core;$('targetCash').value=t.cash;
    const achievable = ['lever','core'].reduce((sum,cat)=>sum+t[cat]/100*groupWeights(cat).reduce((s,x)=>s+x.weight*Number(x.h.beta||0),0),0);
    $('familiarSummary').textContent = `即時試算配置　槓桿 ${pct(t.lever)} ／ 原形 ${pct(t.core)} ／ 現金 ${pct(t.cash)}　· 可達 Beta ${betaFmt(achievable)}`;
    $('familiarValidation').textContent = state.settings.allocationMode==='beta' && Math.abs(achievable-state.settings.targetBeta)>.005 ? '目前標的與原形比例無法達成目標 Beta，請調整曝險倍數、原形比例或目標 Beta。' : '變更會自動儲存在目前瀏覽器。';
  }
  function familiarField(label,key,value,step='1',max='') {
    return `<label>${label}<input type="number" min="0" ${max ? `max="${max}"` : ''} step="${step}" data-setting="${key}" value="${Number(value||0)}"></label>`;
  }
  function familiarHoldings(category) {
    const title = category==='lever'?'槓桿':category==='core'?'原形':'類現金';
    const rows = state.holdings.filter(h=>h.category===category);
    const custom = category==='cash' ? state.settings.cashMode==='custom' : state.settings.distribution?.[category]==='custom';
    return `<article class="panel familiar-group"><div class="panel-top"><h2>${title} <small>${rows.length} 筆標的</small></h2></div><div class="familiar-switch"><span>個股佔比分配方式</span><button data-distribution="${category}:auto" aria-pressed="${!custom}">自動分配</button><button data-distribution="${category}:custom" aria-pressed="${custom}">自訂個股佔比</button></div>${rows.map((h,i)=>`<div class="familiar-holding" data-holding="${escapeHtml(h.id)}"><div class="panel-top"><strong>${title} ${i+1} ${escapeHtml(h.name!==h.symbol?h.name||'':'')}</strong><button class="text-button danger-text" data-remove-familiar="${escapeHtml(h.id)}">移除</button></div><div class="familiar-fields"><label>代號<input data-holding-field="symbol" value="${escapeHtml(h.symbol)}" maxlength="12" placeholder="例如 0050"></label><label>股數<input data-holding-field="quantity" type="number" min="0" step="1" value="${Number(h.quantity||0)}"></label>${category==='lever'?`<label>曝險倍數<input data-holding-field="beta" type="number" min="0" max="10" step="0.1" value="${Number(h.beta??2)}"></label>`:''}${custom?`<label>個股佔比 %<input data-holding-field="targetWeight" type="number" min="0" max="100" value="${Number(h.targetWeight??100/Math.max(1,rows.length))}"></label>`:''}</div><div class="helper-text">目前價格 ${priceOf(h)?money2(priceOf(h)):'等待報價'} · 市值 ${money(marketValue(h))}</div><details><summary>手動價格與進階資料</summary><div class="familiar-fields"><label>手動價格（新台幣）<input data-holding-field="manualPrice" type="number" min="0" step="0.01" value="${Number(h.manualPrice||0)}"></label><label>Beta<input data-holding-field="beta" type="number" step="0.1" value="${Number(h.beta||0)}"></label></div></details></div>`).join('')}<button class="secondary-button" data-add-familiar="${category}">新增${title}${category==='cash'?'標的':''}</button></article>`;
  }
  function refreshFamiliarHoldingValues() {
    document.querySelectorAll('.familiar-holding[data-holding]').forEach(card=>{
      const holding=state.holdings.find(h=>h.id===card.dataset.holding);
      const summary=card.querySelector(':scope > .helper-text');
      if(!holding||!summary)return;
      const price=priceOf(holding);
      summary.textContent=price>0 ? `${number(holding.quantity)} 股 × ${money2(price)} ＝ 持有市值 ${money2(marketValue(holding))}` : `${number(holding.quantity)} 股 · 等待報價，尚無法計算持有市值`;
    });
  }
  function renderFamiliarSettings() {
    if (!$('familiarContent')) return;
    document.querySelectorAll('[data-settings-section]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.settingsSection===settingsSection)));
    let html='';
    if(settingsSection==='cash') html=`<article class="panel familiar-group"><h2>現金</h2><div class="familiar-fx">USD/TWD 匯率 <strong>${state.usdTwd?Number(state.usdTwd).toFixed(4):'尚未更新'}</strong><button class="text-button" data-refresh-fx>更新匯率</button><small>${escapeHtml(state.fxDate||'可手動填寫匯率')}</small></div><fieldset class="cash-reasons"><legend>本次現金變動原因</legend>${[['cost','手續費 / 交易成本'],['flow','新資金投入 / 提領'],['correction','資料修正']].map(([value,label])=>`<label><input type="radio" name="cashReason" value="${value}" ${(state.cashReason||'flow')===value?'checked':''}>${label}</label>`).join('')}</fieldset><div class="familiar-fields">${familiarField('新台幣 TWD（目前餘額）','cash',state.cash)}${familiarField('美金 USD（目前餘額）','cashUsd',state.cashUsd,'0.01')}${familiarField('USD/TWD 匯率','usdTwd',state.usdTwd,'0.0001')}</div><p class="field-note">美金以此匯率換算新台幣。現金合計 ${money(getPortfolio().cashBalance)}。直接修改上方數字是設定目前餘額；記錄手續費或提領請使用下方變動金額。異動會包含於完整備份。</p>${cashAdjustmentEditor()}</article><article class="panel familiar-group"><h2>類現金配置方式</h2><div class="familiar-switch"><button data-cash-mode="auto" aria-pressed="${state.settings.cashMode!=='custom'}">自動配置</button><button data-cash-mode="custom" aria-pressed="${state.settings.cashMode==='custom'}">自訂比例</button></div>${familiarField('現金部位內的真實現金比例 %','realCashPct',state.settings.realCashPct??10,'1','100')}<p class="field-note">此比例只分配現金部位，不代表占總資產的比例。類現金 ETF 有價格波動。</p></article>${familiarHoldings('cash')}`;
    if(settingsSection==='holdings') html=familiarHoldings('lever')+familiarHoldings('core');
    if(settingsSection==='beta') html=`<article class="panel familiar-group"><h2>Beta 與再平衡設定</h2><div class="familiar-step"><label>目標 Beta <small>每次 ±0.1</small></label><button data-step="targetBeta:-0.1" aria-label="目標 Beta 減少 0.1">−</button><input aria-label="目標 Beta" type="number" min="0" max="5" step="0.1" data-setting="targetBeta" value="${state.settings.targetBeta}"><button data-step="targetBeta:0.1" aria-label="目標 Beta 增加 0.1">＋</button></div><div class="familiar-step"><label>再平衡容忍度 <small>每次 ±1%</small></label><button data-step="tolerance:-1" aria-label="再平衡容忍度減少 1%">−</button><input aria-label="再平衡容忍度百分比" type="number" min="0" max="50" step="1" data-setting="tolerance" value="${state.settings.tolerance}"><button data-step="tolerance:1" aria-label="再平衡容忍度增加 1%">＋</button></div><p class="field-note">Beta 是目標，持股是工具，現金是結果；超出容忍區間時會提醒再平衡。</p><div class="familiar-step"><label>原形目標比例 <small>每次 ±5%</small></label><button data-step="coreTarget:-5" aria-label="原形目標比例減少 5%">−</button><input aria-label="原形目標比例百分比" type="number" min="0" max="100" step="5" data-setting="coreTarget" value="${state.settings.coreTarget??state.settings.target.core}"><button data-step="coreTarget:5" aria-label="原形目標比例增加 5%">＋</button></div><p class="field-note">依原形比例與槓桿標的的加權曝險倍數推算槓桿配置，剩餘為現金。</p>${state.settings.allocationMode!=='beta'?'<p class="migration-note">目前保留你原有的三類目標比例。修改 Beta／原形參數，或按下方按鈕，即切換為 Beta 自動試算。</p><button class="secondary-button" data-enable-model>使用 Beta 自動試算</button>':''}</article>`;
    $('familiarContent').innerHTML=html;
    renderFamiliarSummary();
    refreshFamiliarHoldingValues();
    renderCashAdjustmentPreview();
  }
  function saveFamiliarValue(key,value) {
    if(!Number.isFinite(value)||value<0) {notify('請輸入 0 或正數');return false;}
    const limits={targetBeta:5,tolerance:50,coreTarget:100,realCashPct:100};
    if(key in limits && value>limits[key]) {notify(`此欄最大為 ${limits[key]}`);return false;}
    if(key==='usdTwd' && value<=0) {notify('匯率必須大於 0');return false;}
    if(['cash','cashUsd','usdTwd'].includes(key)) {
      const oldValue=Number(state[key]||0);
      state[key]=value;
      if(key!=='usdTwd' && oldValue!==value) {
        state.cashChanges=state.cashChanges||[];
        state.cashChanges.push({at:new Date().toISOString(),currency:key==='cash'?'TWD':'USD',before:oldValue,after:value,reason:state.cashReason||'flow'});
      }
    } else {
      state.settings[key]=value;
      if(['targetBeta','coreTarget'].includes(key)) state.settings.allocationMode='beta';
    }
    syncModelTargets();persist();renderAll();
    $('settingsSaveStatus').textContent='已自動儲存';
    if(key==='targetBeta')window.dispatchEvent(new Event('exposure-target-changed'));
    return true;
  }
  async function refreshFx() {
    try {
      const r=await fetch('/api/fx'); const data=await r.json();
      if(!r.ok||!(data.rate>0)) throw new Error(data.error||'匯率更新失敗');
      state.usdTwd=data.rate;state.fxDate=data.date;persist();renderAll();renderFamiliarSettings();notify('USD/TWD 匯率已更新');
    } catch(e){notify(`${e.message}，可手動填入匯率`);}
  }
  function initFamiliarSettings() {
    const page=$('page-settings');
    page.querySelector('.page-intro h2').textContent='參數設定';
    page.querySelector('.page-intro p').textContent='調整持股、現金與 Beta 試算條件';
    const workspace=document.createElement('div');workspace.id='familiarWorkspace';
    workspace.innerHTML='<div class="panel familiar-summary"><strong id="familiarSummary"></strong><p id="familiarValidation"></p></div><div class="familiar-tabs" role="tablist" aria-label="設定分類"><button role="tab" data-settings-section="cash">現金</button><button role="tab" data-settings-section="holdings">持股</button><button role="tab" data-settings-section="beta">Beta 參數</button></div><div id="familiarContent"></div>';
    page.insertBefore(workspace,page.querySelector('.settings-grid'));
    const grid=page.querySelector('.settings-grid');
    grid.children[0].hidden=true;grid.children[1].hidden=true;
    const details=document.createElement('details');details.className='familiar-advanced';details.innerHTML='<summary>進階設定與行情連線</summary>';
    page.insertBefore(details,grid);details.append(grid);
    const backupCard=grid.querySelector('.wide-card');
    page.insertBefore(backupCard,details);
    backupCard.querySelector('h2').textContent='資料備份';
    $('backupBtn').textContent='匯出完整備份';
    $('saveSettingsBtn').textContent='儲存進階設定';
    // Existing portfolio values and explicit target allocations stay intact on migration.
    if(state.settings.coreTarget==null) state.settings.coreTarget=Number(state.settings.target.core||0);
    if(state.settings.realCashPct==null && localStorage.getItem(STORE_KEY)) {
      const portfolio=getPortfolio();
      state.settings.realCashPct=portfolio.cash ? portfolio.cashBalance/portfolio.cash*100 : 10;
    }
    if(!localStorage.getItem(STORE_KEY)) {state.settings.allocationMode='beta';state.settings.coreTarget=0;}
    workspace.addEventListener('input',event=>{
      const input=event.target;
      if(input.name==='cashReason') {state.cashReason=input.value;persist();renderCashAdjustmentPreview();return;}
      if(input.id==='cashAdjustmentAmount'){cashAdjustmentDraft.amount=input.value;renderCashAdjustmentPreview();return;}
      if(input.id==='cashAdjustmentCurrency'){cashAdjustmentDraft.currency=input.value;renderCashAdjustmentPreview();return;}
      if(input.dataset.setting) {saveFamiliarValue(input.dataset.setting,Number(input.value));renderCashAdjustmentPreview();return;}
      if(input.dataset.holdingField) {
        const h=state.holdings.find(row=>row.id===input.closest('[data-holding]').dataset.holding);if(!h)return;
        const key=input.dataset.holdingField;
        if(key==='symbol') {
          const symbol=input.value.trim().toUpperCase();
          if(symbol && !/^[A-Z0-9.-]{1,12}$/.test(symbol)){notify('請輸入有效標的代號');input.value=h.symbol;return;}
          if(symbol!==h.symbol){h.symbol=symbol;h.name=symbol;h.quote=null;h.manualPrice=0;}
        } else {
          const value=Number(input.value);
          if(!Number.isFinite(value)||value<0||(key==='targetWeight'&&value>100)||(key==='beta'&&value>10)){notify('請檢查欄位數值');input.value=h[key]||0;return;}
          h[key]=value;
        }
        persist();renderAll();
      }
    });
    workspace.addEventListener('change',event=>{
      if(event.target.dataset.holdingField==='symbol') refreshQuotes();
    });
    workspace.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.hasAttribute('data-apply-cash-adjustment')){
        try {
          const plan=applyCashAdjustment(cashAdjustmentDraft.currency,cashAdjustmentDraft.amount);
          cashAdjustmentDraft.amount='';syncModelTargets();persist();renderAll();renderFamiliarSettings();
          notify(`已${plan.delta<0?'扣除':'增加'} ${plan.currency} ${number(Math.abs(plan.delta))}`);
        } catch(error){notify(error.message);renderCashAdjustmentPreview();}
        return;
      }
      if(button.dataset.settingsSection){settingsSection=button.dataset.settingsSection;renderFamiliarSettings();}
      if(button.dataset.addFamiliar){const cat=button.dataset.addFamiliar;state.holdings.push({id:uid(),symbol:'',name:'',category:cat,quantity:0,beta:cat==='lever'?2:cat==='core'?1:0,cost:0,manualPrice:0,targetWeight:100});persist();renderAll();renderFamiliarSettings();}
      if(button.dataset.removeFamiliar){const id=button.dataset.removeFamiliar;const h=state.holdings.find(x=>x.id===id);if(h&&confirm(`移除 ${h.symbol||'此標的'}？`)){state.holdings=state.holdings.filter(x=>x.id!==id);persist();renderAll();renderFamiliarSettings();}}
      if(button.dataset.distribution){const [cat,mode]=button.dataset.distribution.split(':');state.settings.distribution=state.settings.distribution||{};state.settings.distribution[cat]=mode;state.holdings.filter(h=>h.category===cat).forEach(h=>{if(h.targetWeight==null)h.targetWeight=100/state.holdings.filter(x=>x.category===cat).length;});persist();renderAll();renderFamiliarSettings();}
      if(button.dataset.cashMode){state.settings.cashMode=button.dataset.cashMode;persist();renderFamiliarSettings();}
      if(button.dataset.step){const [key,step]=button.dataset.step.split(':');saveFamiliarValue(key,Math.max(0,Math.min(key==='targetBeta'?5:key==='tolerance'?50:100,Math.round((Number(state.settings[key]||0)+Number(step))*10)/10)));renderFamiliarSettings();}
      if(button.hasAttribute('data-enable-model')){state.settings.allocationMode='beta';syncModelTargets();persist();renderAll();renderFamiliarSettings();}
      if(button.hasAttribute('data-refresh-fx'))refreshFx();
    });
    if(!state.usdTwd)refreshFx();
  }

  function init() {
    remoteQuoteOrigin = MarketQuotes.privateOrigin(localStorage.getItem(SHIOAJI_REMOTE_STORE));
    initCashEditor(); initFamiliarSettings(); bindEvents(); renderAll(); renderSettings();
    updateApiStatusUi(); startQuoteTimer();
    const pairing = MarketQuotes.privateOrigin(new URLSearchParams(location.hash.slice(1)).get('shioaji'));
    if (pairing) {
      setPage('settings');
      $('shioajiPairForm').closest('details').open = true;
      $('shioajiRemoteUrl').value = pairing;
      $('shioajiPairStatus').textContent = '手機連上 Tailscale 後，按「儲存備用連線」。若瀏覽器詢問本機網路存取，請選「允許」。';
      $('shioajiPairForm').scrollIntoView({ block:'center' });
    }
    if (location.hash === '#ngrok') {
      setPage('settings');
      $('pairNgrokBtn').closest('details').open = true;
      $('pairNgrokBtn').scrollIntoView({ block:'center' });
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (shioajiEnabled) void refreshQuotes();
  }
  window.exposureRiskBridge={getTarget:()=>Number(state.settings.targetBeta),setTarget:value=>{if(!Number.isFinite(value)||value<0||value>5)return;saveFamiliarValue('targetBeta',value);renderSettings();notify('已更新目標 Beta，請至再平衡頁確認調整。');}};
  window.exposureIndexQuote=indexQuoteReading;
  init();
})();
