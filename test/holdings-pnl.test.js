const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8').replace('  init();', `
  globalThis.testApi = {
    set: value => state = value,
    get: () => state,
    pnl: holdingPnl,
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

console.log('PASS: optional/legacy costs, gain/loss, quote updates, average purchase cost, partial/full sales and rebalance undo');
