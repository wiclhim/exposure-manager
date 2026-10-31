const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest')));
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
for (const icon of manifest.icons) {
  const buffer = fs.readFileSync(path.join(root, icon.src));
  const size = Number(icon.sizes.split('x')[0]);
  assert.equal(buffer.readUInt32BE(16), size);
  assert.equal(buffer.readUInt32BE(20), size);
}
const events = {};
let offline = false, networkCalls = 0, cacheReads = 0;
const fallback = { offline: true };
vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), {
  URL, Response,
  self: { location: { origin: 'https://example.test' }, addEventListener: (name, handler) => { events[name] = handler; } },
  fetch: async () => { networkCalls++; if (offline) throw Error('offline'); return { live: true }; },
  caches: { match: async key => { cacheReads++; assert.equal(key, '/offline.html'); return fallback; } }
});
async function request(route, mode = 'navigate', method = 'GET') {
  let response;
  events.fetch({ request: { url: route, mode, method }, respondWith: value => { response = value; } });
  return response;
}
(async () => {
  assert.equal(await request('https://example.test/api/quote?symbol=0050'), undefined);
  assert.equal(await request('https://example.test/api/history', 'cors'), undefined);
  assert.equal(await request('https://other.test/'), undefined);
  assert.equal(await request('https://example.test/app.js', 'cors'), undefined);
  assert.equal(await request('https://example.test/', 'navigate', 'POST'), undefined);
  assert.equal(networkCalls, 0);
  assert.equal((await request('https://example.test/')).live, true);
  assert.equal(cacheReads, 0);
  offline = true;
  assert.equal(await request('https://example.test/'), fallback);
  assert.equal(cacheReads, 1);
  console.log('PASS: manifest/icon sizes, no API/static caching, live navigation, offline fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
