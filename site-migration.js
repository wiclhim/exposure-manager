(() => {
  'use strict';
  const oldOrigin = 'https://betree-exposure-manager.vercel.app';
  const newOrigin = 'https://exposure-manager.vercel.app';
  const appKey = 'exposureManager.v1';
  const riskKey = 'exposureIndexRisk.v1';
  const backupKey = 'exposureMigrationBackup.v1';
  const $ = id => document.getElementById(id);
  const source = location.origin === oldOrigin;
  const destination = location.origin === newOrigin;
  if (!source && !destination) return;

  if (!$('transferStatus')) {
    if (!source && localStorage.getItem(appKey) !== null) return;
    const banner = document.createElement('aside');
    banner.setAttribute('aria-label', '網站更名與資料轉移');
    banner.style.cssText = 'padding:14px 16px;margin:0 0 20px;border:1px solid #dcd9d0;border-radius:14px;background:#eeece5;color:#404b42;line-height:1.8;overflow-wrap:anywhere';
    const text = document.createElement('span');
    text.textContent = source ? '網站已更名為 exposure-manager。原有資料仍在此瀏覽器，請先轉移再使用新網址。 ' : '若你曾使用舊網址，請在原本的瀏覽器轉入舊資料。 ';
    const link = document.createElement('a');
    link.href = '/transfer.html';
    link.textContent = source ? '轉移資料並前往新網站 →' : '從舊網址轉入資料 →';
    link.style.cssText = 'color:inherit;font-weight:700';
    banner.append(text, link);
    document.querySelector('.topbar')?.after(banner);
    return;
  }

  const status = text => { $('transferStatus').textContent = text; };
  const parseApp = raw => {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.holdings) || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings) || !Array.isArray(data.history || [])) throw new Error('舊資料格式不完整，請改用 JSON 備份。');
    return data;
  };
  const parseRisk = raw => {
    if (raw === null) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('指數策略設定格式不正確。');
    return raw;
  };
  const showBackup = () => {
    try {
      const previous = JSON.parse(localStorage.getItem(backupKey) || 'null');
      if (!previous?.app) return;
      $('transferBackup').hidden = false;
    } catch (_) { /* There may not be a previous destination portfolio. */ }
  };
  $('transferBackup').addEventListener('click', () => {
    try {
      const previous = JSON.parse(localStorage.getItem(backupKey) || 'null');
      parseApp(previous.app);
      const url = URL.createObjectURL(new Blob([previous.app], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'exposure-manager-before-transfer.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (_) { status('無法下載轉移前備份；舊網址的原始資料仍保留。'); }
  });
  if (destination) showBackup();

  if (source) {
    let receiver = null;
    let snapshot = null;
    try {
      const raw = localStorage.getItem(appKey);
      if (!raw) {
        status('這個瀏覽器沒有舊資料。請使用原本儲存持倉的瀏覽器，或匯入之前下載的 JSON 備份。');
        return;
      }
      const app = parseApp(raw);
      status(`找到 ${app.holdings.length} 筆持倉、${(app.history || []).length} 筆歷史紀錄。將開啟 exposure-manager.vercel.app，供你確認匯入。`);
      $('transferSend').hidden = false;
      $('transferSend').addEventListener('click', () => {
        try {
          const current = localStorage.getItem(appKey);
          parseApp(current);
          snapshot = { app: current, risk: parseRisk(localStorage.getItem(riskKey)) };
          receiver = window.open(newOrigin + '/transfer.html?receive=1', '_blank');
          status(receiver ? '新網站已開啟，請在新視窗確認匯入。舊資料會完整保留。' : '新視窗被阻擋，請允許開啟後再按一次，或使用 JSON 備份匯出／匯入。');
        } catch (error) { status(error.message); }
      });
      window.addEventListener('message', event => {
        if (event.origin !== newOrigin || event.source !== receiver || !snapshot) return;
        if (event.data?.type === 'exposure-transfer-ready' && typeof event.data.nonce === 'string') {
          receiver.postMessage({ type: 'exposure-transfer-data', nonce: event.data.nonce, ...snapshot }, newOrigin);
        }
        if (event.data?.type === 'exposure-transfer-complete') status('新網站已成功匯入。之後請使用 exposure-manager.vercel.app；此處的舊資料仍會保留。');
      });
    } catch (error) { status(error.message); }
    return;
  }

  if (!new URLSearchParams(location.search).has('receive') || !window.opener) {
    status('請從原本儲存資料的瀏覽器開啟舊網址，再將資料複製到新網站。');
    $('transferStart').href = oldOrigin + '/transfer.html';
    $('transferStart').hidden = false;
    return;
  }

  const nonce = crypto.randomUUID();
  let pending = null;
  let imported = false;
  status('等待舊網址提供此瀏覽器的本機資料…');
  window.addEventListener('message', event => {
    if (event.origin !== oldOrigin || event.source !== window.opener || event.data?.type !== 'exposure-transfer-data' || event.data.nonce !== nonce || imported) return;
    try {
      const app = parseApp(event.data.app);
      pending = { app: event.data.app, risk: parseRisk(event.data.risk) };
      $('transferPreview').textContent = `持倉 ${app.holdings.length} 筆／歷史 ${(app.history || []).length} 筆／目標 Beta ${Number(app.settings.targetBeta || 0).toFixed(2)}`;
      $('transferPreview').hidden = false;
      $('transferConsent').hidden = false;
      $('transferImport').hidden = false;
      status('資料已就緒。確認匯入後，請改用新網址；不會刪除舊網址的資料。');
    } catch (error) { pending = null; status(error.message); }
  });
  $('transferOverwrite').addEventListener('change', () => { $('transferImport').disabled = !pending || !$('transferOverwrite').checked; });
  $('transferImport').addEventListener('click', () => {
    if (!pending || !$('transferOverwrite').checked || imported) return;
    const previous = { app: localStorage.getItem(appKey), risk: localStorage.getItem(riskKey) };
    try {
      // Stop if a backup cannot be retained; never overwrite unprotected data.
      localStorage.setItem(backupKey, JSON.stringify({ at: new Date().toISOString(), ...previous }));
      localStorage.setItem(appKey, pending.app);
      if (pending.risk !== null) localStorage.setItem(riskKey, pending.risk);
      else localStorage.removeItem(riskKey);
      imported = true;
      showBackup();
      $('transferImport').disabled = true;
      $('transferConsent').hidden = true;
      $('transferHome').textContent = '開啟 exposure-manager →';
      $('transferHome').className = 'action';
      status('匯入成功。持倉、現金、設定與歷史已儲存至新網址。WebSocket Key 請在新網站的設定頁重新輸入。');
      window.opener.postMessage({ type: 'exposure-transfer-complete' }, oldOrigin);
    } catch (error) {
      try {
        for (const [key, value] of [[appKey, previous.app], [riskKey, previous.risk]]) {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      } catch (_) { /* Source data remains available on the original domain. */ }
      status('匯入未完成，舊資料仍保留。請確認瀏覽器儲存空間，或使用 JSON 匯出／匯入。');
    }
  });
  window.opener.postMessage({ type: 'exposure-transfer-ready', nonce }, oldOrigin);
})();
