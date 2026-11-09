const assert = require('node:assert/strict');
const quotes = require('../market-quotes');

assert.deepEqual(quotes.marketPair('006208'), ['006208', 'IX0001']);
assert.deepEqual(quotes.symbols(['0050', '0050', '', ' ix0001 ', '2330']), ['0050', 'IX0001', '2330']);
const pair = [{ symbol:'0050', price:98.2, quoteTime:1794192297360 }, { symbol:'IX0001', price:42056.18, quoteTime:1794192300000 }];
const invalid = [{ symbol:'0050', price:0, quoteTime:1794192297360 }, { symbol:'IX0001', price:42056.18 }, { symbol:'006208', price:184, quoteTime:1794192300000 }];
assert.deepEqual(quotes.localBatch([...pair, ...invalid], quotes.marketPair('0050')), pair);
assert.deepEqual(quotes.localBatch(null, []), []);
assert.equal(quotes.timestamp(1793683800000000), 1793683800000);
assert.equal(quotes.gainToHigh(80, 100), 25);
assert.equal(quotes.gainToHigh(101, 100), 0);
assert.equal(quotes.gainToHigh(100, 100), 0);
assert.equal(quotes.gainToHigh(0, 100), null);
assert.equal(quotes.gainToHigh(100, null), null);
console.log('PASS: paired Shioaji quotes, invalid quotes, and 52-week recovery gain');
