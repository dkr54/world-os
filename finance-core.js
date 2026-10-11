import { calendarOwner, calendarChat } from './calendar-core.js';
import { plainObject, safeJSON, cloneJSON } from './characters-core.js';

export const FINANCE_KEY = 'world_os_finance';
const MAX = 100_000_000_000_000; // Cents. Stay well inside exact integer arithmetic.
const LIMITS = { stocks:128, properties:128, bars:120, ledger:200, orders:100 };
function number(value, label, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(label + '超出范围或格式无效。');
    return value;
}
function text(value, label, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + '需要 1～' + max + ' 个字符。');
    return value.trim();
}
function list(value, max, label) { if (!Array.isArray(value) || value.length > max) throw new Error(label + '数量或格式无效。'); return value; }
const amount = (value, label = '金额', min = -MAX) => number(value,label,min,MAX,true);
export const cents = value => amount(Math.round(number(value,'金额',-MAX/100,MAX/100)*100));
export const money = value => (value/100).toLocaleString('en-US',{ minimumFractionDigits:2,maximumFractionDigits:2 });
const boundedPrice = value => Math.max(1,Math.min(100_000_000,Math.round(value)));
const unique = (items,key,label) => { if (new Set(items.map(item => item[key])).size !== items.length) throw new Error(label + '不能重复。'); return items; };

// Real names/tickers, deliberately fictional starting prices and simulation parameters.
export const DEFAULT_STOCKS = [
    ['AAPL','苹果','科技',200,28,7,0.5],['MSFT','微软','科技',400,26,8,0.8],
    ['NVDA','英伟达','半导体',120,50,10,0.1],['AMZN','亚马逊','消费',180,35,8,0],
    ['GOOGL','Alphabet','科技',160,30,7,0.4],['META','Meta','科技',500,38,8,0.4],
    ['TSLA','特斯拉','汽车',240,60,8,0],['TSM','台积电 ADR','半导体',160,38,8,1.5],
    ['JPM','摩根大通','金融',200,25,6,2.3],['KO','可口可乐','消费',60,18,4,3],
    ['BABA','阿里巴巴 ADR','消费',90,42,6,1],['TM','丰田 ADR','汽车',180,28,5,2],
].map(([symbol,name,sector,price,volatility,annualReturn,dividendYield]) => ({ symbol,name,sector,price,volatility,annualReturn,dividendYield }));
export const DEFAULT_PROPERTIES = [
    { id:'city-apartment',name:'中央公园公寓',type:'住宅',description:'一套城市核心区出租公寓。',value:250000,monthlyIncome:2200,monthlyCost:450,annualGrowth:2,debt:100000,interestRate:4.5 },
    { id:'corner-cafe',name:'街角咖啡馆',type:'企业',description:'独立经营的精品咖啡馆，收入为营业收入，成本包含日常经营支出。',value:80000,monthlyIncome:18000,monthlyCost:14500,annualGrowth:3,debt:0,interestRate:0 },
    { id:'office-building',name:'金融区办公楼',type:'商业地产',description:'向企业出租办公空间。',value:2000000,monthlyIncome:20000,monthlyCost:4500,annualGrowth:2,debt:800000,interestRate:5 },
];
export function validateStock(value) {
    if (!plainObject(value)) throw new Error('股票设定无效。');
    const symbol = text(value.symbol,'股票代码',24).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(symbol)) throw new Error('股票代码请使用英文字母、数字、点、横线或下划线。');
    return { symbol,name:text(value.name,'股票名称'),sector:text(value.sector,'行业',40),
        price:number(value.price,'初始股价',0.01,1_000_000),volatility:number(value.volatility,'年化波动率',0,200),
        annualReturn:number(value.annualReturn,'年化趋势',-90,100),dividendYield:number(value.dividendYield,'年化分红率',0,30) };
}
export function validateProperty(value) {
    if (!plainObject(value)) throw new Error('商业资产设定无效。');
    const id = text(value.id,'资产标识',80);
    if (!/^[\w-]+$/.test(id)) throw new Error('资产标识请使用英文字母、数字、横线或下划线。');
    const result = { id,name:text(value.name,'资产名称'),type:text(value.type,'资产类别',40),description:String(value.description ?? '').slice(0,4000),
        value:number(value.value,'资产估值',0,MAX/100),monthlyIncome:number(value.monthlyIncome,'月收入',0,MAX/100),
        monthlyCost:number(value.monthlyCost,'月成本',0,MAX/100),annualGrowth:number(value.annualGrowth,'估值年增长率',-90,100),
        debt:number(value.debt,'负债',0,MAX/100),interestRate:number(value.interestRate,'负债年利率',0,100) };
    if (result.debt > result.value) throw new Error('购入时负债不能大于资产估值。');
    return result;
}
export function validateFinanceConfig(value = {}) {
    if (!plainObject(value)) throw new Error('金融设置无效。');
    return { schema:1,enabled:value.enabled !== false,currency:text(value.currency ?? 'USD','计价单位',16),
        initialCash:number(value.initialCash ?? 100000,'初始现金',0,MAX/100),tickSeconds:number(value.tickSeconds ?? 8,'推进间隔',2,120,true),
        feeBps:number(value.feeBps ?? 10,'手续费（万分比）',0,1000),spreadBps:number(value.spreadBps ?? 5,'单边滑点（万分比）',0,1000),
        stocks:unique(list(value.stocks ?? DEFAULT_STOCKS,LIMITS.stocks,'股票').map(validateStock),'symbol','股票代码'),
        properties:unique(list(value.properties ?? DEFAULT_PROPERTIES,LIMITS.properties,'商业资产').map(validateProperty),'id','资产标识') };
}
export function financeConfig(ctx) { return validateFinanceConfig(ctx.extensionSettings?.[FINANCE_KEY]?.cards?.[calendarOwner(ctx)] ?? {}); }
export function validateFinanceSettings(value) {
    if (!plainObject(value) || !plainObject(value.cards)) throw new Error('金融角色卡设置无效。');
    return { schema:1,cards:Object.fromEntries(Object.entries(value.cards).map(([key,config]) => [key,validateFinanceConfig(config)])) };
}
function hash(text) { let n=2166136261; for(const c of text) n=Math.imul(n^c.charCodeAt(0),16777619); return n>>>0; }
function random(state) { state.seed=(state.seed+0x6D2B79F5)>>>0; let n=state.seed; n=Math.imul(n^(n>>>15),n|1); n^=n+Math.imul(n^(n>>>7),n|61); return ((n^(n>>>14))>>>0)/4294967296; }
function normal(state) { return Math.sqrt(-2*Math.log(Math.max(1e-9,random(state))))*Math.cos(2*Math.PI*random(state)); }
function market(stock) { const price=cents(stock.price); return { stock:cloneJSON(stock),price,previous:price,bars:[{ day:0,open:price,high:price,low:price,close:price,volume:0 }] }; }
export function createFinanceState(config, scope = '') {
    return { schema:1,day:0,seed:hash(scope),running:true,cash:cents(config.initialCash),contributed:cents(config.initialCash),realized:0,
        income:0,fees:0,sequence:0,regime:0,markets:Object.fromEntries(config.stocks.map(stock => [stock.symbol,market(stock)])),
        positions:{},properties:[],orders:[],ledger:[],news:'开市准备就绪。报价、新闻与收益均为本地模拟。' };
}
export function validateFinanceState(input) {
    const s = safeJSON(input);
    if (!plainObject(s) || s.schema !== 1) throw new Error('金融聊天状态无效。');
    for (const key of ['day','sequence']) number(s[key],key,0,1_000_000_000,true);
    number(s.seed,'行情种子',0,4294967295,true); number(s.regime,'市场状态',-1,1,true);
    if (typeof s.running !== 'boolean' || typeof s.news !== 'string' || s.news.length > 1000) throw new Error('金融运行状态无效。');
    for (const key of ['cash','contributed','realized','income','fees']) amount(s[key],key);
    if (!plainObject(s.markets) || Object.keys(s.markets).length > 256 || !plainObject(s.positions)) throw new Error('行情或持仓格式无效。');
    for (const [symbol,m] of Object.entries(s.markets)) {
        m.stock=validateStock(m.stock); if(m.stock.symbol!==symbol) throw new Error('行情代码不一致。');
        amount(m.price,'股价',1);amount(m.previous,'昨收',1);
        if (!list(m.bars,LIMITS.bars,'K 线').length) throw new Error('K 线不能为空。');
        let previous=-1;
        for(const b of m.bars) {
            number(b.day,'K 线交易日',0,s.day,true); if(b.day<=previous) throw new Error('K 线顺序无效。'); previous=b.day;
            for(const key of ['open','high','low','close']) amount(b[key],'K 线价格',1);
            number(b.volume,'成交量',0,1e12,true);
            if(b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)) throw new Error('K 线高低价无效。');
        }
        if(m.bars.at(-1).close!==m.price) throw new Error('K 线与现价不一致。');
    }
    for (const [symbol,p] of Object.entries(s.positions)) {
        if (!s.markets[symbol]) throw new Error('持仓缺少行情。');
        number(p.quantity,'持股数',1,100_000_000,true);amount(p.cost,'持仓成本',0);
    }
    unique(list(s.properties,LIMITS.properties,'名下资产'),'id','名下资产');
    for (const p of s.properties) {
        text(p.id,'资产标识',80);text(p.name,'资产名称');text(p.type,'资产类型',40);
        if(typeof p.description!=='string'||p.description.length>4000)throw new Error('资产介绍无效。');
        for(const key of ['value','debt','monthlyIncome','monthlyCost','cost'])amount(p[key],key,0);
        number(p.annualGrowth,'估值变化',-90,100);number(p.interestRate,'负债利率',0,100);
    }
    unique(list(s.orders,LIMITS.orders,'委托'),'id','委托标识');
    for(const o of s.orders) {
        number(o.id,'委托编号',1,s.sequence,true);if(!s.markets[o.symbol]||!['buy','sell'].includes(o.side))throw new Error('委托目标无效。');
        number(o.quantity,'委托数量',1,100_000_000,true);amount(o.limit,'委托限价',1);number(o.day,'委托日期',0,s.day,true);
    }
    for(const e of list(s.ledger,LIMITS.ledger,'流水')) {
        number(e.id,'流水编号',1,s.sequence,true);number(e.day,'流水日期',0,s.day,true);amount(e.amount);amount(e.balance);text(e.kind,'流水类型',40);text(e.note,'流水摘要',500);
    }
    financeTotals(s); // Reject arithmetic that cannot be represented safely.
    return s;
}
export function financeState(ctx, config = financeConfig(ctx)) {
    const saved=ctx.chatMetadata?.[FINANCE_KEY];
    const state=saved ? validateFinanceState(saved) : createFinanceState(config,calendarChat(ctx));
    for(const stock of config.stocks) { if(state.markets[stock.symbol])state.markets[stock.symbol].stock=cloneJSON(stock); else state.markets[stock.symbol]=market(stock); }
    // Removed instruments remain available for liquidation in existing chats.
    for(const [symbol] of Object.entries(state.markets)) if(!config.stocks.some(s=>s.symbol===symbol)&&!state.positions[symbol]&&!state.orders.some(o=>o.symbol===symbol))delete state.markets[symbol];
    return state;
}
function record(state,kind,note,delta=0) {
    state.cash=amount(state.cash+delta);state.ledger.push({ id:++state.sequence,day:state.day,kind,note,amount:delta,balance:state.cash });
    state.ledger=state.ledger.slice(-LIMITS.ledger);
}
export function financeTotals(state) {
    const stocks=amount(Object.entries(state.positions).reduce((sum,[symbol,p])=>sum+state.markets[symbol].price*p.quantity,0));
    const stockCost=amount(Object.values(state.positions).reduce((sum,p)=>sum+p.cost,0));
    const propertyValue=amount(state.properties.reduce((sum,p)=>sum+p.value,0));
    const debt=amount(state.properties.reduce((sum,p)=>sum+p.debt,0));
    const gross=amount(state.cash+stocks+propertyValue),net=amount(gross-debt);
    return { cash:state.cash,stocks,stockCost,unrealized:amount(stocks-stockCost),propertyValue,debt,gross,net,profit:amount(net-state.contributed),
        monthlyNet:amount(state.properties.reduce((sum,p)=>sum+p.monthlyIncome-p.monthlyCost-Math.round(p.debt*p.interestRate/1200),0)) };
}
export function tradeQuote(state,config,side,symbol,quantity,limit) {
    if(!['buy','sell'].includes(side)||!state.markets[symbol])throw new Error('请选择有效股票和买卖方向。');
    number(quantity,'股数',1,100_000_000,true);
    if(side==='buy'&&!config.stocks.some(stock=>stock.symbol===symbol))throw new Error('这只股票已从设定移除，只能卖出现有持仓。');
    const raw=state.markets[symbol].price;
    if(limit!==undefined) { amount(limit,'限价',1);if(side==='buy'?raw>limit:raw<limit)return null; }
    let price=boundedPrice(raw*(1+(side==='buy'?1:-1)*config.spreadBps/10000));
    if(limit!==undefined)price=side==='buy'?Math.min(price,limit):Math.max(price,limit);
    const gross=amount(price*quantity,'成交额',0),fee=amount(Math.round(gross*config.feeBps/10000),'手续费',0);
    return { price,gross,fee,delta:side==='buy'?-(gross+fee):gross-fee };
}
function execute(state,config,side,symbol,quantity,limit) {
    const q=tradeQuote(state,config,side,symbol,quantity,limit);if(!q)return false;
    const p=state.positions[symbol]??{quantity:0,cost:0};
    // A rejected pending order must not leave behind part of a trade.
    const fees=amount(state.fees+q.fee);amount(state.cash+q.delta);
    let position,realized=state.realized;
    if(side==='buy') {
        if(state.cash < -q.delta)throw new Error('可用现金不足（包含手续费与滑点）。');
        number(p.quantity+quantity,'总股数',1,100_000_000,true);
        position={quantity:p.quantity+quantity,cost:amount(p.cost-q.delta)};
    } else {
        if(p.quantity<quantity)throw new Error('持仓不足，无法卖空。');
        const cost=quantity===p.quantity?p.cost:Math.round(p.cost*quantity/p.quantity);
        realized=amount(state.realized+q.delta-cost);
        if(p.quantity!==quantity)position={quantity:p.quantity-quantity,cost:p.cost-cost};
    }
    if(position)state.positions[symbol]=position;else delete state.positions[symbol];
    state.realized=realized;state.fees=fees;
    record(state,side==='buy'?'买入':'卖出',symbol+' · '+quantity+' 股 @ '+money(q.price)+' · 费用 '+money(q.fee),q.delta);return true;
}
export function placeTrade(input,config,{side,symbol,quantity,limit}) {
    const state=cloneJSON(input);
    if(limit===undefined)execute(state,config,side,symbol,quantity);
    else {
        const quote=tradeQuote(state,config,side,symbol,quantity,limit);
        if(quote)execute(state,config,side,symbol,quantity,limit);
        else {
            if(state.orders.length>=LIMITS.orders)throw new Error('未成交委托最多 100 笔。');
            state.orders.push({id:++state.sequence,day:state.day,side,symbol,quantity,limit});
            record(state,'挂单',symbol+' · '+(side==='buy'?'买入':'卖出')+' '+quantity+' 股 · 限价 '+money(limit));
        }
    }
    return validateFinanceState(state);
}
export function cancelOrder(input,id) { const s=cloneJSON(input),o=s.orders.find(o=>o.id===id);if(!o)throw new Error('委托不存在。');s.orders=s.orders.filter(o=>o.id!==id);record(s,'撤单',o.symbol+' · 委托 #'+id);return s; }
export function gmCash(input,value) { const s=cloneJSON(input),delta=amount(cents(value)-s.cash);s.contributed=amount(s.contributed+delta);record(s,'GM 调整','将现金设为 '+money(cents(value)),delta);return validateFinanceState(s); }
export function setRunning(input,running) { const s=cloneJSON(input);s.running=Boolean(running);return s; }
export function acquireProperty(input,definition,grant = false) {
    const p=validateProperty(definition),s=cloneJSON(input);
    if(s.properties.some(item=>item.id===p.id))throw new Error('本聊天已拥有此资产。');
    if(s.properties.length>=LIMITS.properties)throw new Error('名下资产最多 128 项。');
    const equity=cents(p.value)-cents(p.debt);
    if(!grant&&s.cash<equity)throw new Error('现金不足以支付资产净价。');
    s.properties.push({...p,value:cents(p.value),debt:cents(p.debt),monthlyIncome:cents(p.monthlyIncome),monthlyCost:cents(p.monthlyCost),cost:cents(p.value)});
    if(grant)s.contributed=amount(s.contributed+equity);
    record(s,grant?'GM 授予':'购入资产',p.name+' · 估值 '+money(cents(p.value))+' · 承接负债 '+money(cents(p.debt)),grant?0:-equity);
    return validateFinanceState(s);
}
export function sellProperty(input,id) {
    const s=cloneJSON(input),p=s.properties.find(p=>p.id===id);if(!p)throw new Error('未持有此资产。');
    const delta=p.value-p.debt;if(s.cash+delta<0)throw new Error('出售所得不足以还清负债，需要补足现金。');
    s.properties=s.properties.filter(p=>p.id!==id);record(s,'出售资产',p.name+' · 已清偿关联负债',delta);return validateFinanceState(s);
}
export function updateProperty(input,id,changes) {
    const s=cloneJSON(input),p=s.properties.find(p=>p.id===id);if(!p)throw new Error('未持有此资产。');
    const oldEquity=p.value-p.debt;
    for(const key of ['value','debt','monthlyIncome','monthlyCost'])if(changes[key]!==undefined)p[key]=cents(changes[key]);
    for(const key of ['annualGrowth','interestRate'])if(changes[key]!==undefined)p[key]=changes[key];
    s.contributed=amount(s.contributed+(p.value-p.debt-oldEquity));record(s,'GM 调整',p.name+' · 更新经营状态');return validateFinanceState(s);
}
export function advanceMarket(input,config,days=1) {
    number(days,'推进天数',1,100,true);const s=cloneJSON(input);
    for(let i=0;i<days;i++) {
        s.day++; if(s.day>1e9)throw new Error('交易日已达上限。');
        if(random(s)<0.08)s.regime=Math.floor(random(s)*3)-1;
        const shock=normal(s),sectors=new Map();let jump=0;
        if(random(s)<0.08)jump=(random(s)-0.5)*0.08;
        s.news=jump<-0.01?'模拟快讯：风险偏好回落，市场承压。':jump>0.01?'模拟快讯：增长预期改善，资金回流。':s.regime>0?'模拟盘面：风险偏好偏强，关注板块轮动。':s.regime<0?'模拟盘面：市场偏谨慎，波动可能扩大。':'模拟盘面：多空交织，个股表现分化。';
        let dividend=0;
        for(const [symbol,m] of Object.entries(s.markets)) {
            const stock=m.stock,vol=stock.volatility/100;
            if(!sectors.has(stock.sector))sectors.set(stock.sector,normal(s));
            const z=0.55*shock+0.35*sectors.get(stock.sector)+Math.sqrt(1-0.55**2-0.35**2)*normal(s);
            const change=(stock.annualReturn/100-vol*vol/2)/252+s.regime*0.0005+vol/Math.sqrt(252)*z+jump;
            const previous=m.price,open=boundedPrice(previous*Math.exp(vol/Math.sqrt(252)*normal(s)*0.15));
            let close=boundedPrice(previous*Math.exp(Math.max(-0.5,Math.min(0.5,change))));
            // Quarterly distribution with an ex-dividend adjustment to the simulated price.
            if(s.day%63===0) {
                const perShare=Math.min(close-1,Math.round(previous*stock.dividendYield/400));
                if(perShare>0){close-=perShare;dividend+=perShare*(s.positions[symbol]?.quantity??0);}
            }
            const width=Math.abs(normal(s))*vol/Math.sqrt(252)*0.4;
            const bar={day:s.day,open,close,high:boundedPrice(Math.max(open,close)*(1+width)),low:boundedPrice(Math.min(open,close)/(1+width)),volume:Math.round((1+Math.abs(z))*500000*(0.5+random(s)))};
            m.previous=previous;m.price=close;m.bars.push(bar);m.bars=m.bars.slice(-LIMITS.bars);
        }
        if(dividend){s.income=amount(s.income+dividend);record(s,'股票分红','季度现金分红（价格已除息）',dividend);}
        let operating=0;
        for(const p of s.properties) {
            // One simulated trading session is also one operating day; a month uses 30 sessions.
            operating+=Math.round((p.monthlyIncome-p.monthlyCost)/30-p.debt*p.interestRate/100/360);
            p.value=amount(Math.max(0,Math.round(p.value*Math.exp(Math.log1p(p.annualGrowth/100)/360))));
        }
        if(s.properties.length){s.income=amount(s.income+operating);record(s,'经营结算','名下资产日收入 − 日成本 − 负债利息',operating);}
        for(const order of [...s.orders]) {
            try { if(!execute(s,config,order.side,order.symbol,order.quantity,order.limit))continue; }
            catch(error) { record(s,'委托失效',order.symbol+' · #'+order.id+' · '+error.message); }
            s.orders=s.orders.filter(o=>o.id!==order.id);
        }
        financeTotals(s);
    }
    return validateFinanceState(s);
}
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function assetPrompt(state,config,user='用户') {
    const t=financeTotals(state),lines=['<asset>','账户：'+escape(user)+'；计价单位：'+escape(config.currency)+'；模拟交易日：'+state.day,
        '现金：'+money(t.cash)+'；股票市值：'+money(t.stocks)+'；商业资产估值：'+money(t.propertyValue),
        '负债：'+money(t.debt)+'；净资产：'+money(t.net),
        '持仓浮动盈亏：'+money(t.unrealized)+'；已实现交易盈亏：'+money(state.realized),'<stocks>'];
    for(const [symbol,p] of Object.entries(state.positions))lines.push(escape(state.markets[symbol].stock.name)+' ('+symbol+')：'+p.quantity+' 股；均价（含买入费）'+money(Math.round(p.cost/p.quantity))+'；现价 '+money(state.markets[symbol].price)+'；市值 '+money(state.markets[symbol].price*p.quantity));
    if(!Object.keys(state.positions).length)lines.push('无持仓');
    lines.push('</stocks>','<business_assets>');
    for(const p of state.properties)lines.push(escape(p.name)+' ['+escape(p.type)+']：估值 '+money(p.value)+'；负债 '+money(p.debt)+'；月收入 '+money(p.monthlyIncome)+'；月成本 '+money(p.monthlyCost)+'；负债年利率 '+p.interestRate+'%'+(p.description?'；'+escape(p.description):''));
    if(!state.properties.length)lines.push('无名下商业资产');
    lines.push('</business_assets>','未成交委托：'+state.orders.length+' 笔','</asset>');return lines.join('\n');
}
