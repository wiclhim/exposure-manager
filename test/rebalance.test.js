const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace('  init();',`globalThis.testApi={set(s,ui){state=s;Object.assign(rebalanceUi,{beta:null,mode:'normal',precision:1,excluded:new Set(),from:'',to:''},ui)},preview:rebalancePreview,apply:applyRebalancePlan,undo:undoRebalancePlan,get:()=>state};`);
const context={localStorage:{getItem:()=>null,setItem:()=>{}},window:{},document:{},console};vm.createContext(context);vm.runInContext(source,context);const api=context.testApi;
const holding=(id,beta,quantity,price,category='lever')=>({id,symbol:id,name:id,beta,quantity,manualPrice:price,category});
const fixture=()=>({holdings:[holding('L1',2,100,100),holding('L2',2,100,100)],cash:20000,cashUsd:0,usdTwd:32,quoteCache:{},settings:{targetBeta:1.5,tolerance:10,allocationMode:'beta',coreTarget:0,target:{lever:75,core:0,cash:25}}});
function plan(state=fixture(),ui={}){api.set(state,ui);const before=JSON.stringify(state),result=api.preview();assert.equal(JSON.stringify(state),before,'preview must not mutate saved data');assert.ok(result.cash>=0);assert.equal(result.total,result.p.total,'value must be conserved');for(const row of result.rows)assert.ok(row.before+row.delta>=0);return result;}
let p=plan();assert.deepEqual(Array.from(p.rows,row=>row.delta),[50,50]);assert.equal(p.beta,1.5);
p=plan(fixture(),{excluded:new Set(['L1'])});assert.deepEqual(Array.from(p.rows,row=>row.delta),[0,100]);assert.equal(p.cash,10000);assert.equal(p.beta,1.5);
api.apply(p);assert.equal(api.get().holdings[0].quantity,100);assert.equal(api.get().holdings[1].quantity,200);api.undo();assert.equal(api.get().holdings[1].quantity,100);assert.equal(api.get().cash,20000);
p=plan(fixture(),{beta:.5,excluded:new Set(['L1'])});assert.deepEqual(Array.from(p.rows,row=>row.delta),[0,-100]);assert.equal(p.beta,.5);
p=plan(fixture(),{excluded:new Set(['L1','L2'])});assert.equal(p.operations,0);assert.equal(p.cash,20000);
p=plan(fixture(),{beta:.25,excluded:new Set(['L1'])});assert.equal(p.rows[0].delta,0);assert.equal(p.rows[1].delta,-100);assert.ok(p.warnings.some(w=>w.includes('超過該類目標')));
let state=fixture();state.holdings[1].quantity=0;state.cash=30000;p=plan(state,{excluded:new Set(['L1'])});assert.equal(p.rows[1].delta,200);assert.equal(p.beta,1.5);
state=fixture();state.holdings=[holding('L1',2,10000,1),holding('L2',2,10000,1),holding('L3',2,10000,1)];state.cash=30000;state.settings.distribution={lever:'custom'};state.holdings.forEach((h,i)=>h.targetWeight=[20,30,50][i]);p=plan(state,{excluded:new Set(['L1'])});assert.deepEqual(Array.from(p.rows,row=>row.delta),[0,3125,11875]);assert.equal(p.beta,1.5);
// Core and cash-ETF targets keep their own category budget and real-cash reserve.
state=fixture();state.holdings.push(holding('C',1,100,100,'core'));state.cash=10000;state.settings.coreTarget=25;state.settings.targetBeta=1.25;p=plan(state,{excluded:new Set(['L1'])});assert.equal(p.rows[0].delta,0);assert.equal(p.rows[1].delta,0);assert.equal(p.rows[2].delta,0);assert.equal(p.beta,1.25);
state=fixture();state.holdings.push(holding('CASH',0,100,100,'cash'));state.cash=10000;state.settings.realCashPct=50;p=plan(state,{excluded:new Set(['L1'])});assert.deepEqual(Array.from(p.rows,row=>row.delta),[0,100,-50]);assert.equal(p.cash,5000);assert.equal(p.beta,1.5);
state=fixture();state.cash=0;p=plan(state,{beta:3,excluded:new Set(['L1'])});assert.equal(p.operations,0);assert.equal(p.cash,0);assert.ok(p.warnings.length);
p=plan(fixture(),{precision:1000,excluded:new Set(['L1'])});assert.equal(p.operations,0);
// Existing swap and USD funding behavior remain unchanged.
state=fixture();state.holdings=[holding('L',2,200,100),holding('C',1,0,50,'core')];state.cash=0;p=plan(state,{mode:'swap',from:'L',to:'C',beta:1.5});assert.deepEqual(Array.from(p.rows,row=>row.delta),[-100,200]);assert.equal(p.beta,1.5);
state=fixture();state.cash=0;state.cashUsd=100;p=plan(state,{beta:2,excluded:new Set(['L1'])});assert.equal(p.operations,0);assert.equal(p.cash,0);assert.equal(api.get().cashUsd,100);
console.log('PASS: checked-position redistribution for buys/sells, custom weights, zero holdings, frozen limits, category budgets, cash reserves, rounding, apply/undo and swaps');
