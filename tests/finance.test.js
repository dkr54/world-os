import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCE_KEY, DEFAULT_STOCKS, validateFinanceConfig, validateFinanceState, validateFinanceSettings,
    createFinanceState, financeState, financeConfig, financeTotals, advanceMarket, placeTrade, cancelOrder,
    gmCash, setRunning, acquireProperty, sellProperty, updateProperty, assetPrompt, cents } from '../finance-core.js';
import { createSnapshot, validateSnapshot, restoreSnapshot } from '../snapshots.js';
const config=changes=>validateFinanceConfig({feeBps:10,spreadBps:5,...changes});
const context=()=>({characterId:0,characters:[{avatar:'finance-card.png'}],chatId:'finance-chat',name1:'旅行者',extensionSettings:{},chatMetadata:{foreign:{keep:true}},saveMetadata:async()=>{},saveSettingsDebounced:()=>{}});
function atPrice(s,symbol,price){const next=structuredClone(s),m=next.markets[symbol];m.price=price;m.bars.at(-1).close=price;m.bars.at(-1).high=Math.max(price,m.bars.at(-1).open);m.bars.at(-1).low=Math.min(price,m.bars.at(-1).open);return next;}

test('金融设定默认提供多行业国际股票，配置校验拒绝异常参数与重复代码',()=>{
    const c=config();assert(c.stocks.length>=12);assert(c.stocks.some(s=>s.symbol==='TSM'));
    for(const bad of [{tickSeconds:0},{feeBps:NaN},{initialCash:Infinity},{stocks:[DEFAULT_STOCKS[0],DEFAULT_STOCKS[0]]},{properties:[{id:'bad'}]}])assert.throws(()=>config(bad));
    assert.throws(()=>validateFinanceSettings({cards:[]}));
});
test('股票与资产模板随卡共享，现金行情持仓按聊天隔离',()=>{
    const ctx=context();ctx.extensionSettings[FINANCE_KEY]={cards:{'character:finance-card.png':config({currency:'金币'})}};
    ctx.chatMetadata[FINANCE_KEY]=gmCash(financeState(ctx),4321);
    const other={...ctx,chatId:'two',chatMetadata:{}};
    assert.equal(financeConfig(other).currency,'金币');assert.equal(financeState(other).cash,10000000);assert.equal(financeState(ctx).cash,432100);
    assert.notEqual(financeState(other).seed,financeState(ctx).seed);assert.equal(financeConfig({...other,characters:[{avatar:'new.png'}]}).currency,'USD');
});
test('市价买卖计入滑点手续费，部分卖出按比例分配成本，原状态不变',()=>{
    const c=config(),start=createFinanceState(c,'roundtrip'),s=placeTrade(start,c,{side:'buy',symbol:'AAPL',quantity:10});
    assert.equal(s.positions.AAPL.quantity,10);assert.equal(s.cash+s.positions.AAPL.cost,start.cash);assert(s.fees>0);assert.deepEqual(start.positions,{});
    const before=s.positions.AAPL.cost,sold=placeTrade(s,c,{side:'sell',symbol:'AAPL',quantity:4});
    assert.equal(sold.positions.AAPL.quantity,6);assert.equal(sold.positions.AAPL.cost,before-Math.round(before*4/10));assert(sold.realized<0);
    const exit=placeTrade(sold,c,{side:'sell',symbol:'AAPL',quantity:6});assert(!exit.positions.AAPL);assert.equal(financeTotals(exit).profit,exit.realized);
});
test('禁止超余额买入、超持仓卖出、负数或零股数，不污染账本',()=>{
    const c=config(),s=createFinanceState(c),before=structuredClone(s);
    for(const trade of [{side:'buy',quantity:100000},{side:'sell',quantity:1},{side:'buy',quantity:0},{side:'buy',quantity:1.5},{side:'buy',quantity:-1}])assert.throws(()=>placeTrade(s,c,{symbol:'AAPL',...trade}));
    assert.deepEqual(s,before);
});
test('限价单守住价格边界，未触发委托可撤单，触发后资金不足则失效',()=>{
    const c=config(),s=createFinanceState(c);let pending=placeTrade(s,c,{side:'buy',symbol:'AAPL',quantity:10,limit:100});
    assert.equal(pending.orders.length,1);assert.equal(pending.cash,s.cash);
    assert.equal(cancelOrder(pending,pending.orders[0].id).orders.length,0);
    const buy=placeTrade(s,c,{side:'buy',symbol:'AAPL',quantity:10,limit:20000});assert.equal(buy.orders.length,0);assert(buy.positions.AAPL.cost<=200000+200);
    pending.orders[0].limit=100000000;pending=gmCash(pending,0);const next=advanceMarket(pending,c);assert.equal(next.orders.length,0);assert(!next.positions.AAPL);assert(next.ledger.some(e=>e.kind==='委托失效'));
});
test('保存的随机进度决定后续行情，刷新不会重掷，逐日推进与批次推进相同',()=>{
    const c=config(),s=createFinanceState(c,'seed');let daily=s;for(let i=0;i<10;i++)daily=advanceMarket(daily,c);
    assert.deepEqual(daily,advanceMarket(s,c,10));assert.deepEqual(advanceMarket(daily,c),advanceMarket(JSON.parse(JSON.stringify(daily)),c));
    assert.notEqual(daily.markets.AAPL.price,s.markets.AAPL.price);assert.notEqual(daily.markets.AAPL.price,daily.markets.NVDA.price);
    assert.equal(s.day,0);
});
test('挂单成交触及账户数值上限时完全拒绝，不留下半笔持仓或扣费',()=>{
    const c=config(),s=createFinanceState(c,'transaction-limit');s.fees=100_000_000_000_000;
    let pending=placeTrade(s,c,{side:'buy',symbol:'AAPL',quantity:1,limit:100});pending.orders[0].limit=100000000;
    const next=advanceMarket(pending,c);assert.equal(next.cash,s.cash);assert.equal(next.fees,s.fees);assert.deepEqual(next.positions,{});
    assert.equal(next.orders.length,0);assert.equal(next.ledger.at(-1).kind,'委托失效');
});
test('大量模拟日保持正股价、合法 OHLC 和有界 K 线及流水',()=>{
    const c=config();let s=createFinanceState(c,'long');s=acquireProperty(s,c.properties[1],true);
    for(let i=0;i<6;i++)s=advanceMarket(s,c,100);
    assert.equal(s.day,600);assert(s.ledger.length<=200);for(const m of Object.values(s.markets)){assert.equal(m.bars.length,120);assert(m.price>0);for(const b of m.bars){assert(b.high>=b.open&&b.high>=b.close);assert(b.low<=b.open&&b.low<=b.close);}}
    validateFinanceState(s);
});
test('季度分红增加现金并除息，持仓数量不变',()=>{
    const c=config(),s=placeTrade(createFinanceState(c,'dividend'),c,{side:'buy',symbol:'KO',quantity:100});
    const withDividend=advanceMarket(s,c,63),noDividend=structuredClone(s);noDividend.markets.KO.stock.dividendYield=0;
    const without=advanceMarket(noDividend,c,63),distribution=withDividend.cash-without.cash;
    assert(distribution>0);assert.equal(without.markets.KO.price-withDividend.markets.KO.price,distribution/100);assert.equal(withDividend.positions.KO.quantity,100);
});
test('GM 调整现金以净投入单独记录，投资收益不凭空增长',()=>{
    const c=config(),s=createFinanceState(c),next=gmCash(s,987654.32);assert.equal(next.cash,98765432);assert.equal(financeTotals(next).profit,0);assert.equal(next.ledger.at(-1).kind,'GM 调整');
    const lowered=gmCash(next,-10);assert.equal(financeTotals(lowered).profit,0);assert.throws(()=>gmCash(s,NaN));
});
test('商业资产购入承接负债、按日经营和付息、出售清偿负债，GM 授予不当作收益',()=>{
    const c=config(),start=gmCash(createFinanceState(c),500000),p=c.properties[0],owned=acquireProperty(start,p);
    assert.equal(owned.cash,start.cash-cents(p.value-p.debt));assert.equal(financeTotals(owned).net,financeTotals(start).net);
    assert.equal(financeTotals(acquireProperty(start,p,true)).profit,0);
    const next=advanceMarket(owned,c),expected=Math.round((cents(p.monthlyIncome)-cents(p.monthlyCost))/30-cents(p.debt)*p.interestRate/100/360);
    assert.equal(next.cash-owned.cash,expected);assert.equal(next.ledger.at(-1).kind,'经营结算');
    const sold=sellProperty(next,p.id);assert.equal(sold.properties.length,0);assert.equal(sold.cash,next.cash+next.properties[0].value-next.properties[0].debt);
    assert.throws(()=>acquireProperty(owned,p),/已拥有/);
});
test('GM 经营调整只影响聊天，估值与负债调整不伪造投资收益',()=>{
    const c=config(),s=acquireProperty(createFinanceState(c),c.properties[1],true),next=updateProperty(s,'corner-cafe',{value:200000,monthlyIncome:10000,debt:1000});
    assert.equal(financeTotals(next).profit,0);assert.equal(c.properties[1].value,80000);assert.equal(next.properties[0].monthlyIncome,1000000);
    assert.throws(()=>updateProperty(s,'corner-cafe',{monthlyIncome:-5}));
});
test('股票移除后旧聊天仍可卖出，模板编辑不重置价格或已拥有资产状态',()=>{
    const ctx=context(),c=config();ctx.chatMetadata[FINANCE_KEY]=placeTrade(createFinanceState(c),c,{side:'buy',symbol:'AAPL',quantity:5});
    ctx.extensionSettings[FINANCE_KEY]={cards:{'character:finance-card.png':config({stocks:[]})}};
    const s=financeState(ctx),removed=financeConfig(ctx);assert(s.markets.AAPL);assert.throws(()=>placeTrade(s,removed,{side:'buy',symbol:'AAPL',quantity:1}),/只能卖出/);assert(!placeTrade(s,removed,{side:'sell',symbol:'AAPL',quantity:5}).positions.AAPL);
    ctx.extensionSettings[FINANCE_KEY].cards['character:finance-card.png']=config({stocks:[{...DEFAULT_STOCKS[0],price:1}]});assert.equal(financeState(ctx).markets.AAPL.price,20000);
});
test('资产宏组装当前现金、持仓与名下资产，转义用户文本且不包含 API 或内部随机状态',()=>{
    const c=config();let s=placeTrade(createFinanceState(c),c,{side:'buy',symbol:'AAPL',quantity:10});s=acquireProperty(s,{...c.properties[1],name:'<商铺>',description:'小店 & 咖啡'},true);
    const prompt=assetPrompt(s,c,'测试用户');assert(prompt.startsWith('<asset>\n'));assert(prompt.endsWith('</asset>'));assert(prompt.includes('AAPL'));assert(prompt.includes('&lt;商铺&gt;'));assert(!prompt.includes('seed'));assert(!prompt.includes('apiKey'));assert(prompt.includes('计价单位：USD'));
});
test('金融状态随快照恢复，旧快照兼容且不会清空已有金融数据',async()=>{
    const ctx=context();ctx.extensionSettings[FINANCE_KEY]={cards:{'character:finance-card.png':config()}};ctx.chatMetadata[FINANCE_KEY]=gmCash(financeState(ctx),12345);const snapshot=createSnapshot(ctx);
    validateSnapshot(snapshot);ctx.chatMetadata[FINANCE_KEY]=gmCash(financeState(ctx),5);await restoreSnapshot(snapshot,ctx);assert.equal(financeState(ctx).cash,1234500);assert(ctx.chatMetadata.foreign.keep);
    const old=structuredClone(snapshot);delete old.settings[FINANCE_KEY];delete old.metadata[FINANCE_KEY];await restoreSnapshot(old,ctx);assert.equal(financeState(ctx).cash,1234500);
    const bad=structuredClone(snapshot);bad.metadata[FINANCE_KEY].positions.AAPL={quantity:-1,cost:0};assert.throws(()=>validateSnapshot(bad));
});
test('损坏或溢出的快照状态拒绝接受，不默默重置资金',()=>{
    const c=config(),s=createFinanceState(c);for(const change of [{cash:Infinity},{day:-1},{seed:NaN},{running:'yes'}])assert.throws(()=>validateFinanceState({...s,...change}));
    const over=structuredClone(s);over.positions.AAPL={quantity:100000000,cost:0};over.markets.AAPL.price=1e14;over.markets.AAPL.bars[0]={...over.markets.AAPL.bars[0],close:1e14,high:1e14};assert.throws(()=>validateFinanceState(over));
    assert.equal(setRunning(s,false).running,false);assert.equal(s.running,true);
});
