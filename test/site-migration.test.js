const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../site-migration.js'), 'utf8');
const compatibility = fs.readFileSync(path.join(__dirname, '../storage-compat.js'), 'utf8');
const oldOrigin = 'https://betree-exposure-manager.vercel.app';
const newOrigin = 'https://exposure-manager.vercel.app';
const appKey = 'exposureManager.v1', riskKey = 'exposureIndexRisk.v1';
const portfolio = JSON.stringify({ holdings: [{ symbol: '0050', quantity: 100 }], cash: 1234, settings: { targetBeta: 1.3 }, history: [{ date: '2026-10-30' }] });
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function setup(origin, initial, receive = false) {
  const elements = new Map(), listeners = {}, sent = [];
  const localStorage = storage(initial);
  const context = {
    location: { origin, search: receive ? '?receive=1' : '' }, localStorage, URLSearchParams, console,
    crypto: { randomUUID: () => 'test-nonce' }, Date,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: true, checked: false, disabled: true, textContent: '', listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
      return elements.get(id);
    } },
    window: {
      opener: receive ? { postMessage: (data, target) => sent.push({ data, target }) } : null,
      addEventListener: (name, callback) => { listeners[name] = callback; },
      open: () => receiver
    }
  };
  const receiver = { postMessage: (data, target) => sent.push({ data, target }) };
  vm.runInNewContext(script, context);
  return { context, elements, localStorage, sent, receiver,
    message: data => listeners.message?.(data),
    click: id => elements.get(id).listeners.click(),
    consent: () => { const e = elements.get('transferOverwrite'); e.checked = true; e.listeners.change(); }
  };
}

// Same-origin key migration copies once, without deleting or replacing data.
const legacy = storage({ 'betreeExposureManager.v1': portfolio, 'betreeFugleWsKey.v1': 'fixture-only' });
vm.runInNewContext(compatibility, { localStorage: legacy, console });
assert.equal(legacy.getItem(appKey), portfolio);
assert.equal(legacy.getItem('exposureFugleWsKey.v1'), 'fixture-only');
legacy.setItem(appKey, 'newer');
vm.runInNewContext(compatibility, { localStorage: legacy, console });
assert.equal(legacy.getItem(appKey), 'newer');
assert.equal(legacy.getItem('betreeExposureManager.v1'), portfolio);

// Source sends only to the window it opened on the exact new origin.
const source = setup(oldOrigin, { [appKey]: portfolio, [riskKey]: '{"baseline":1.3}', exposureFugleWsKey: 'fixture-secret' });
source.click('transferSend');
source.message({ origin: 'https://unexpected.example', source: source.receiver, data: { type: 'exposure-transfer-ready', nonce: 'n' } });
source.message({ origin: newOrigin, source: {}, data: { type: 'exposure-transfer-ready', nonce: 'n' } });
assert.equal(source.sent.length, 0);
source.message({ origin: newOrigin, source: source.receiver, data: { type: 'exposure-transfer-ready', nonce: 'n' } });
assert.equal(source.sent[0].target, newOrigin);
assert.equal(source.sent[0].data.app, portfolio);
assert.ok(!JSON.stringify(source.sent).includes('fixture-secret'));
assert.equal(source.localStorage.getItem(appKey), portfolio);

function offer(destination, overrides = {}) {
  destination.message({ origin: oldOrigin, source: destination.context.window.opener, data: { type: 'exposure-transfer-data', nonce: 'test-nonce', app: portfolio, risk: '{"baseline":1.3}', ...overrides } });
}
const destination = setup(newOrigin, { [appKey]: '{"holdings":[],"settings":{},"history":[]}', [riskKey]: '{"baseline":1}' }, true);
assert.equal(destination.sent[0].target, oldOrigin);
offer(destination, { nonce: 'wrong' });
assert.equal(destination.elements.get('transferImport').hidden, true);
offer(destination);
destination.click('transferImport');
assert.notEqual(destination.localStorage.getItem(appKey), portfolio);
destination.consent();
destination.click('transferImport');
assert.equal(destination.localStorage.getItem(appKey), portfolio);
assert.equal(destination.localStorage.getItem(riskKey), '{"baseline":1.3}');
assert.equal(JSON.parse(destination.localStorage.getItem('exposureMigrationBackup.v1')).risk, '{"baseline":1}');
assert.equal(destination.elements.get('transferBackup').hidden, false);
assert.ok(destination.sent.some(s => s.data.type === 'exposure-transfer-complete'));

// Malformed input and backup failures cannot overwrite the destination.
const invalid = setup(newOrigin, {}, true);
offer(invalid, { app: '{"holdings":"wrong"}' });
assert.equal(invalid.elements.get('transferImport').hidden, true);
assert.equal(invalid.localStorage.getItem(appKey), null);
const blocked = setup(newOrigin, { [appKey]: 'original' }, true);
offer(blocked); blocked.consent();
const setItem = blocked.localStorage.setItem;
blocked.localStorage.setItem = (key, value) => { if (key === 'exposureMigrationBackup.v1') throw new Error('Quota exceeded'); setItem(key, value); };
blocked.click('transferImport');
assert.equal(blocked.localStorage.getItem(appKey), 'original');

// Restore the previous app state if writing the paired risk setting fails.
const rollback = setup(newOrigin, { [appKey]: 'original', [riskKey]: '{"baseline":1}' }, true);
offer(rollback); rollback.consent();
const originalSet = rollback.localStorage.setItem; let failOnce = true;
rollback.localStorage.setItem = (key, value) => { if (key === riskKey && failOnce) { failOnce = false; throw new Error('Write failed'); } originalSet(key, value); };
rollback.click('transferImport');
assert.equal(rollback.localStorage.getItem(appKey), 'original');
assert.equal(rollback.localStorage.getItem(riskKey), '{"baseline":1}');
console.log('PASS: legacy storage compatibility, exact origins/windows/nonce, no credential transfer, explicit import, backup and rollback');
