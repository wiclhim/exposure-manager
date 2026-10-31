(() => {
  'use strict';
  let installPrompt = null;
  const button = document.getElementById('installAppBtn');
  const strip = document.getElementById('installStrip');
  const help = document.getElementById('installHelp');
  const standalone = window.matchMedia('(display-mode: standalone)');
  const update = () => { strip.hidden = standalone.matches || navigator.standalone === true; };
  update();
  standalone.addEventListener('change', update);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    button.textContent = '安裝桌面 App';
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; strip.hidden = true; });
  document.getElementById('closeInstallHelp').addEventListener('click', () => help.close());
  button.addEventListener('click', async () => {
    if (!installPrompt) { help.showModal(); return; }
    const prompt = installPrompt;
    installPrompt = null;
    button.disabled = true;
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === 'accepted') strip.hidden = true;
    } catch (_) {
      document.getElementById('installHelpStatus').textContent = '瀏覽器未開啟安裝視窗，請使用下列方式安裝。';
      help.showModal();
    } finally { button.disabled = false; }
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
        // Browsing and portfolio data continue to work when offline support is unavailable.
      });
    });
  }
})();
