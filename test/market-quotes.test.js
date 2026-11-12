const assert = require('node:assert/strict');
const quotes = require('../market-quotes');

assert.deepEqual(quotes.marketPair('006208'), ['006208', 'IX0001']);
assert.equal(quotes.privateOrigin('https://home.tailnet.ts.net/'), 'https://home.tailnet.ts.net');
for (const value of ['http://home.tailnet.ts.net', 'https://home.tailnet.ts.net.example.com', 'https://home.tailnet.ts.net:8765', 'https://user@home.tailnet.ts.net', 'https://home.tailnet.ts.net/quotes']) {
  assert.equal(quotes.privateOrigin(value), null);
}
assert.deepEqual(quotes.symbols(['0050', '0050', '', ' ix0001 ', '2330']), ['0050', 'IX0001', '2330']);
const pair = [{ symbol:'0050', price:98.2, quoteTime:1794192297360 }, { symbol:'IX0001', price:42056.18, quoteTime:1794192300000 }];
const invalid = [{ symbol:'0050', price:0, quoteTime:1794192297360 }, { symbol:'IX0001', price:42056.18 }, { symbol:'006208', price:184, quoteTime:1794192300000 }];
assert.deepEqual(quotes.localBatch([...pair, ...invalid], quotes.marketPair('0050')), pair);
assert.deepEqual(quotes.localBatch(null, []), []);
assert.equal(quotes.timestamp(1793683800000000), 1793683800000);
const closeTime = Date.parse('2026-11-12T13:33:00+08:00');
const indexQuote = { date:'2026-11-12', price:43091.87, high:44525.24, low:42943.50, quoteTime:closeTime, source:'永豐 Shioaji' };
assert.deepEqual(quotes.shioajiIndexBar(indexQuote, closeTime), {
  date:'2026-11-12', close:43091.87, high:44525.24, low:42943.50, quoteTime:closeTime, closed:true
});
assert.equal(quotes.shioajiIndexBar({ ...indexQuote, quoteTime:closeTime - 1000 }, closeTime).closed, false);
assert.equal(quotes.shioajiIndexBar({ ...indexQuote, quoteTime:closeTime - 3 * 60000 }, closeTime).closed, false);
for (const invalidQuote of [
  { ...indexQuote, high:undefined }, { ...indexQuote, low:44000 },
  { ...indexQuote, date:'2026-11-11' }, { ...indexQuote, source:'既有報價' }
]) {
  assert.equal(quotes.shioajiIndexBar(invalidQuote, closeTime), null);
}
assert.equal(quotes.shioajiIndexBar(indexQuote, closeTime - 1), null);
assert.equal(quotes.gainToHigh(80, 100), 25);
assert.equal(quotes.gainToHigh(101, 100), 0);
assert.equal(quotes.gainToHigh(100, 100), 0);
assert.equal(quotes.gainToHigh(0, 100), null);
assert.equal(quotes.gainToHigh(100, null), null);
console.log('PASS: paired Shioaji quotes, invalid quotes, and 52-week recovery gain');
