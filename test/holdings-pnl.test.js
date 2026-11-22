const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').replace('  init();', `
  globalThis.testApi = {
    set: value => state = value,
    get: () => state,
    pnl: holdingPnl,
    summary: portfolioPnl,
    apply: applyRebalancePlan,
    undo: undoRebalancePlan
  };
`);
const context = {
  localStorage: { getItem: () => null, setItem() {} },
  window: {},
  document: {}
};
vm.createContext(context);
vm.runInContext(source, context);
const api = context.testApi;
const holding = { id: 'test', symbol: '0050', quantity: 10, cost: 100, manualPrice: 120 };
api.set({ holdings: [holding], quoteCache: {}, cash: 1000 });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, message);

near(api.pnl(holding).amount, 200);
near(api.pnl(holding).percent, 20);
near(api.pnl({ ...holding, manualPrice: 80 }).amount, -200);
near(api.pnl({ ...holding, manualPrice: 80 }).percent, -20);
assert.equal(api.pnl({ ...holding, manualPrice: 100 }).amount, 0);
for (const cost of [undefined, null, '', 0, '0', -1, NaN, Infinity]) {
  assert.equal(api.pnl({ ...holding, cost }), null, 'legacy missing costs cannot appear as gains');
}
assert.equal(api.pnl({ ...holding, manualPrice: 0 }), null, 'missing prices cannot appear as total losses');
assert.equal(api.pnl({ ...holding, quantity: 0 }), null);
api.get().quoteCache['0050'] = { price: 130 };
near(api.pnl(holding).amount, 300, 'quotes drive the calculation');
delete api.get().quoteCache['0050'];

function apply(delta) {
  const current = api.get().holdings[0];
  api.apply({
    rows: [{ h: current, before: current.quantity, delta, price: 120 }],
    cash: api.get().cash - delta * 120,
    p: { beta: 1 },
    beta: 1
  });
  return api.get().holdings[0];
}
let current = apply(5);
near(current.cost, 1600 / 15);
near(api.pnl(current).amount, 200, 'buying at the current price preserves existing unrealized profit');
const buyCost = current.cost;
current = apply(-5);
near(current.cost, buyCost, 'partial sales retain the average cost');
api.undo();
assert.equal(api.get().holdings[0].quantity, 15);
near(api.get().holdings[0].cost, buyCost);
current = apply(-15);
assert.equal(current.cost, null);
assert.equal(api.pnl(current), null);
current = apply(5);
assert.equal(current.cost, 120, 'a new position starts at its simulated purchase price');
assert.equal(api.pnl(current).amount, 0);
api.set({ holdings: [{ ...holding, cost: null }], quoteCache: {}, cash: 1000 });
assert.equal(apply(5).cost, null, 'unknown existing cost remains unknown after additional buys');

api.set({
  holdings: [
    { symbol: 'A', quantity: 10, cost: 100, manualPrice: 120 },
    { symbol: 'B', quantity: 5, cost: 100, manualPrice: 80 },
    { symbol: 'C', quantity: 5, cost: 0, manualPrice: 80 },
    { symbol: 'D', quantity: 5, cost: 100, manualPrice: 0 },
    { symbol: 'E', quantity: 0, cost: 100, manualPrice: 80 },
    { symbol: '', quantity: 5, cost: 100, manualPrice: 80 }
  ],
  quoteCache: {},
  cash: 999999
});
let totals = api.summary();
assert.equal(totals.amount, 100);
near(totals.percent, 100 / 1500 * 100, 'total return uses eligible cost weights');
assert.equal(totals.count, 2);
assert.equal(totals.total, 4, 'missing costs and missing quotes remain visible in coverage');
api.get().quoteCache.A = { price: 130 };
assert.equal(api.summary().amount, 200);
api.set({ holdings: [{ symbol: 'A', quantity: 10, cost: null, manualPrice: 120 }], quoteCache: {} });
assert.equal(api.summary().amount, null, 'no cost coverage cannot appear as zero profit');
assert.equal(api.summary().percent, null);
api.set({ holdings: [], quoteCache: {} });
assert.equal(api.summary().total, 0);

console.log('PASS: optional costs, gain/loss, quote updates, average purchase cost, rebalance undo and partial portfolio totals');
