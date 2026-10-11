import { calendarOwner, calendarChat } from './calendar-core.js';
import { worldEnabled, WORLD_EVENT } from './world-state.js';
import { FINANCE_KEY, financeConfig, financeState, validateFinanceConfig, validateStock, validateProperty,
    financeTotals, advanceMarket, placeTrade, cancelOrder, tradeQuote, gmCash, setRunning,
    acquireProperty, sellProperty, updateProperty, assetPrompt, money, cents } from './finance-core.js';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const button=(text,handler)=>{const b=el('button','menu_button',text);b.type='button';b.addEventListener('click',handler);return b;};
const percent=value=>(value>=0?'+':'')+value.toFixed(2)+'%';
const TEMPLATE=`
  <header class="wo-fin-masthead"><div><small>WORLD OS · PRIVATE WEALTH</small><h3>金融终端</h3></div><span class="wo-fin-badge">模拟市场</span></header>
  <div class="wo-fin-master"><label class="checkbox_label"><input id="wo-fin-master-enabled" type="checkbox">启用金融功能</label><small id="wo-fin-master-status"></small></div>
  <p id="wo-fin-scope" class="fm-hint"></p>
  <div class="wo-fin-summary" id="wo-fin-summary"></div>
  <div class="wo-fin-session"><span id="wo-fin-session"></span><button id="wo-fin-run" type="button" class="menu_button">暂停</button><button id="wo-fin-step" type="button" class="menu_button">推进 1 日</button></div>
  <p id="wo-fin-status" class="fm-status" role="status" aria-live="polite"></p>
  <nav class="wo-fin-nav" aria-label="金融功能"><button type="button" data-fin-tab="market">行情交易</button><button type="button" data-fin-tab="portfolio">投资组合</button><button type="button" data-fin-tab="property">商业资产</button><button type="button" data-fin-tab="ledger">资金流水</button><button type="button" data-fin-tab="settings">设置 / GM</button></nav>
  <section data-fin-view="market">
    <p id="wo-fin-news" class="wo-fin-news"></p>
    <div id="wo-fin-ticker" class="wo-fin-ticker"></div>
    <div class="wo-fin-market-layout"><div class="wo-fin-panel"><div class="wo-fin-section-title"><h4>市场观察</h4><small>现价 / 日涨跌</small></div><div id="wo-fin-watch"></div></div>
    <div><div class="wo-fin-panel"><div class="wo-fin-section-title"><h4 id="wo-fin-chart-title"></h4><span id="wo-fin-chart-price"></span></div><svg id="wo-fin-chart" viewBox="0 0 640 250" role="img" aria-label="股票模拟日 K 线及成交量"></svg><p id="wo-fin-ohlc" class="fm-hint"></p></div>
      <form id="wo-fin-trade" class="wo-fin-panel"><h4>交易委托</h4><div class="fm-grid fm-grid-two"><label>股票<select id="wo-fin-symbol" class="text_pole"></select></label><label>方向<select id="wo-fin-side" class="text_pole"><option value="buy">买入</option><option value="sell">卖出</option></select></label><label>订单类型<select id="wo-fin-order-type" class="text_pole"><option value="market">市价单</option><option value="limit">限价单</option></select></label><label>股数<input id="wo-fin-quantity" class="text_pole" type="number" min="1" max="100000000" step="1" value="10" required></label><label id="wo-fin-limit-label" hidden>限价<input id="wo-fin-limit" class="text_pole" type="number" min="0.01" step="0.01"></label></div><p id="wo-fin-estimate" class="fm-hint"></p><button class="menu_button wo-fin-primary" type="submit">提交模拟委托</button><p class="fm-hint">市价单即时成交；限价单在提交及每次收盘时检查，不按日内高低点撮合。挂单不冻结现金或股票，触发时不足会撤销。无杠杆、无卖空。</p></form>
    </div></div><div class="wo-fin-panel"><h4>未成交委托</h4><div id="wo-fin-orders"></div></div>
  </section>
  <section data-fin-view="portfolio" hidden><div class="wo-fin-panel"><h4>股票持仓</h4><div id="wo-fin-positions"></div></div><div class="wo-fin-panel"><h4>资产分布</h4><div id="wo-fin-allocation"></div></div><details><summary>提示词预览 · {{asset}}</summary><p class="fm-hint">在预设条目里填写 {{asset}}，按当前聊天资产展开；只有已开通金融账户的聊天才会注入。</p><pre id="wo-fin-preview" class="fm-output"></pre></details></section>
  <section data-fin-view="property" hidden><div class="wo-fin-section-title"><h4>名下资产</h4><span id="wo-fin-cashflow"></span></div><div id="wo-fin-owned"></div><div class="wo-fin-panel"><h4>资产市场</h4><p class="fm-hint">购入支付估值减负债后的净价，并承接关联负债。出售时清偿该资产负债。</p><div id="wo-fin-properties"></div></div></section>
  <section data-fin-view="ledger" hidden><div class="wo-fin-panel"><h4>账户流水</h4><p class="fm-hint">保留最近 200 笔，累计盈亏继续保留。经营结算、分红、手续费及 GM 调整均可查阅。</p><div id="wo-fin-ledger"></div></div></section>
  <section data-fin-view="settings" hidden>
    <form id="wo-fin-config-form" class="wo-fin-panel"><h4>市场设定 · 当前角色卡共享</h4><label class="checkbox_label"><input id="wo-fin-enabled" type="checkbox">启用金融与 {{asset}}</label><div class="fm-grid fm-grid-two"><label>计价单位<input id="wo-fin-currency" class="text_pole" maxlength="16" required></label><label>新聊天初始现金<input id="wo-fin-initial" class="text_pole" type="number" min="0" step="0.01" required></label><label>每多少秒推进一个模拟日<input id="wo-fin-interval" class="text_pole" type="number" min="2" max="120" step="1" required></label><label>手续费（万分比）<input id="wo-fin-fee" class="text_pole" type="number" min="0" max="1000" step="0.01" required></label><label>单边滑点（万分比）<input id="wo-fin-spread" class="text_pole" type="number" min="0" max="1000" step="0.01" required></label></div><p class="fm-hint">计价单位只是标签，不做汇率换算。只在金融页可见时自动推进；切页、锁屏、关闭窗口和聊天生成期间暂停，不补算离线时间。</p><button type="submit" class="menu_button">保存市场设定</button></form>
    <form id="wo-fin-gm-form" class="wo-fin-panel"><h4>GM 控制台 · 仅当前聊天</h4><label>设置现金余额<input id="wo-fin-gm-cash" class="text_pole" type="number" step="0.01" required></label><button type="submit" class="menu_button">应用现金余额</button><p class="fm-hint">GM 调整单独记账，不计为投资收益。经营亏损可以导致负现金，买入股票需要足够现金。</p></form>
    <details class="wo-fin-panel"><summary>自定义股票 · 新增 / 编辑</summary><label>选择股票<select id="wo-fin-stock-editor" class="text_pole"></select></label><form id="wo-fin-stock-form"><div class="fm-grid fm-grid-two" id="wo-fin-stock-fields"></div><div class="fm-actions"><button type="submit" class="menu_button">保存股票</button><button type="button" id="wo-fin-stock-remove" class="menu_button">移除股票</button></div><p class="fm-hint">初始价只用于尚未加入此股票的聊天；编辑名称或模拟参数不重置现价。移除后，其他聊天已有持仓仍可卖出。年化趋势、波动和分红都是游戏参数，不代表真实预测。</p></form></details>
    <details class="wo-fin-panel"><summary>自定义商业资产 · 当前角色卡共享</summary><label>选择资产模板<select id="wo-fin-property-editor" class="text_pole"></select></label><form id="wo-fin-property-form"><div class="fm-grid fm-grid-two" id="wo-fin-property-fields"></div><label>介绍<textarea id="wo-fin-property-description" class="text_pole" maxlength="4000" rows="3"></textarea></label><div class="fm-actions"><button type="submit" class="menu_button">保存资产模板</button><button type="button" id="wo-fin-property-remove" class="menu_button">移除模板</button></div><p class="fm-hint">模板供各聊天购入；已持有资产的经营状态独立，在“商业资产”中用 GM 调整。</p></form></details>
    <details class="wo-fin-panel"><summary>模拟规则</summary><p class="fm-hint">行情包含共同市场因素、行业联动、个股波动、牛熊状态和随机事件，保存随机进度。股票以 252 个模拟交易日折算年化参数，每 63 日分红并除息。商业经营每 30 个模拟日结算一个月的收入、成本和利息，估值增长按 360 日折算。不会改变日历日期。初始报价是虚构数值，未连接真实行情或券商。</p></details>
  </section>`;

export function mountFinance(root,{getContext}) {
    const page=root.querySelector('#wo-finance');page.innerHTML=TEMPLATE;
    const find=name=>page.querySelector('#wo-fin-'+name);
    let selected='',view='market',timer=null,busy=false,generating=false,restoring=false,scope='',metadata,settingsRef,epoch=0;
    const say=(message,error=false)=>{find('status').textContent=message;find('status').dataset.level=error?'error':'info';};
    const active=()=>root.open&&!page.hidden&&!document.hidden;
    function stop(){clearTimeout(timer);timer=null;}
    function canRun(){const ctx=getContext();return active()&&!busy&&!generating&&!restoring&&!page.querySelector('input:not([type=checkbox]):focus,textarea:focus,select:focus')&&worldEnabled(ctx)&&Boolean(calendarChat(ctx))&&financeConfig(ctx).enabled;}
    function schedule(){stop();try{const c=financeConfig(getContext());if(canRun()&&financeState(getContext(),c).running)timer=setTimeout(()=>action((s,c)=>advanceMarket(s,c),true),c.tickSeconds*1000);}catch(error){say(error.message,true);}}
    async function action(change,automatic=false) {
        if(busy||generating||restoring)return;
        const ctx=getContext(),captured=calendarChat(ctx),version=epoch;
        if(!captured){say('请先打开一段聊天。',true);return;}
        if(!worldEnabled(ctx)||!financeConfig(ctx).enabled){say('请先启用 world os 和金融功能。',true);return;}
        if(automatic&&!canRun())return;
        busy=true;stop();page.dataset.busy='true';
        const previous=ctx.chatMetadata[FINANCE_KEY];let next;
        try {
            next=change(financeState(ctx),financeConfig(ctx));
            ctx.chatMetadata[FINANCE_KEY]=next;await ctx.saveMetadata();
            if(captured===calendarChat(getContext())&&ctx.chatMetadata===getContext().chatMetadata&&version===epoch){render();if(!automatic)say('已保存到当前聊天。');}
        } catch(error) {
            if(ctx.chatMetadata[FINANCE_KEY]===next){if(previous===undefined)delete ctx.chatMetadata[FINANCE_KEY];else ctx.chatMetadata[FINANCE_KEY]=previous;}
            if(version===epoch){say('操作未保存：'+error.message,true);if(automatic)restoring=true;}
        } finally {busy=false;delete page.dataset.busy;schedule();}
    }
    function saveConfig(config,{fill=true}={}) {
        const ctx=getContext(),owner=calendarOwner(ctx);
        if(!owner||calendarChat(ctx)!==scope)throw new Error('角色或聊天已切换，请重新打开设置。');
        const value=validateFinanceConfig(config),previous=ctx.extensionSettings[FINANCE_KEY];
        ctx.extensionSettings[FINANCE_KEY]={schema:1,cards:{...previous?.cards,[owner]:value}};
        try{ctx.saveSettingsDebounced();}catch(error){ctx.extensionSettings[FINANCE_KEY]=previous;throw error;}
        settingsRef=ctx.extensionSettings[FINANCE_KEY];if(fill)fillSettings();render();schedule();say('市场设定已保存，同角色卡共享。');
    }
    function syncEnabled(){const ctx=getContext(),enabled=financeConfig(ctx).enabled;for(const name of ['enabled','master-enabled']){find(name).checked=enabled;find(name).disabled=!calendarOwner(ctx);}find('master-status').textContent=enabled?'开关立即保存 · 同角色卡共享':'已关闭：停止行情、交易及资产宏，保留已有资产';}
    function toggleEnabled(event){stop();try{const enabled=event.target.checked;saveConfig({...financeConfig(getContext()),enabled},{fill:false});say(enabled?'金融功能已启用。':'金融功能已关闭，已有资产保留。');if(enabled&&active()&&!getContext().chatMetadata?.[FINANCE_KEY])void action(s=>s,true);}catch(error){say(error.message,true);}finally{syncEnabled();schedule();}}
    const guarded=fn=>event=>{event?.preventDefault();try{fn();}catch(error){say(error.message,true);}};
    function setView(name){view=name;for(const p of page.querySelectorAll('[data-fin-view]'))p.hidden=p.dataset.finView!==name;for(const b of page.querySelectorAll('[data-fin-tab]'))b.setAttribute('aria-current',b.dataset.finTab===name?'page':'false');render();}
    function card(title,value,sub,cls='') {const node=el('div','wo-fin-metric '+cls);node.append(el('small','',title),el('strong','',value));if(sub)node.append(el('small','',sub));return node;}
    function row(title,subtitle,value,extra) {const node=el('div','wo-fin-row'),left=el('div');left.append(el('strong','',title),el('small','',subtitle));const right=el('div','wo-fin-row-value');right.append(el('strong','',value));if(extra)right.append(extra);node.append(left,right);return node;}
    function options(select,entries,current) {select.replaceChildren(...entries.map(([id,name])=>new Option(name,id)));if(entries.some(([id])=>id===current))select.value=current;}
    function renderChart(m,symbol) {
        const svg=find('chart');svg.replaceChildren();if(!m){find('chart-title').textContent='请先添加股票';find('chart-price').textContent='';find('ohlc').textContent='';return;}
        const bars=m.bars.slice(-50),lo=Math.min(...bars.map(b=>b.low)),hi=Math.max(...bars.map(b=>b.high)),range=Math.max(hi-lo,hi*0.01,1),bottom=lo-range*0.05,top=hi+range*0.05;
        const y=value=>20+(top-value)/(top-bottom)*165,x=i=>45+(i+0.5)*570/bars.length;
        const shape=(name,attrs,text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text)n.textContent=text;svg.append(n);};
        for(let i=0;i<4;i++){const value=bottom+(top-bottom)*i/3;shape('line',{x1:40,y1:y(value),x2:630,y2:y(value),stroke:'#24323a','stroke-width':1});shape('text',{x:0,y:y(value)+4,fill:'#90a5b2','font-size':10},money(value));}
        const maxVolume=Math.max(1,...bars.map(b=>b.volume));
        bars.forEach((b,i)=>{const color=b.close>=b.open?'#50cf9b':'#ef7b78',width=Math.max(2,Math.min(14,570/bars.length*0.7));shape('line',{x1:x(i),x2:x(i),y1:y(b.high),y2:y(b.low),stroke:color});shape('rect',{x:x(i)-width/2,y:Math.min(y(b.open),y(b.close)),width,height:Math.max(1,Math.abs(y(b.open)-y(b.close))),fill:color});shape('rect',{x:x(i)-width/2,y:237-b.volume/maxVolume*37,width,height:b.volume/maxVolume*37,fill:color,opacity:0.4});});
        const last=bars.at(-1);find('chart-title').textContent=symbol+' · '+m.stock.name;find('chart-price').textContent=money(m.price)+'  '+percent((m.price/m.previous-1)*100);find('chart-price').className=m.price>=m.previous?'wo-fin-up':'wo-fin-down';
        find('ohlc').textContent='第 '+last.day+' 日 · 开 '+money(last.open)+' / 高 '+money(last.high)+' / 低 '+money(last.low)+' / 收 '+money(last.close)+' · 量 '+last.volume.toLocaleString();
    }
    function renderOrders(s,c) {
        const list=find('orders');list.replaceChildren();for(const o of s.orders)list.append(row(o.symbol+' · '+(o.side==='buy'?'买入':'卖出')+' '+o.quantity+' 股','第 '+o.day+' 日 · #'+o.id,money(o.limit)+' '+c.currency,button('撤销',()=>action(s=>cancelOrder(s,o.id)))));
        if(!s.orders.length)list.append(el('p','fm-hint','暂无未成交委托。'));
    }
    function estimate() {
        find('limit-label').hidden=find('order-type').value!=='limit';
        try{const c=financeConfig(getContext()),s=financeState(getContext(),c),side=find('side').value,symbol=find('symbol').value,qty=Number(find('quantity').value),limit=find('order-type').value==='limit'?cents(Number(find('limit').value)):undefined;
            const q=tradeQuote(s,c,side,symbol,qty,limit);find('estimate').textContent=q?'预计'+(side==='buy'?'支出 ':'收入 ')+money(Math.abs(q.delta))+' '+c.currency+' · 手续费 '+money(q.fee):'尚未达到限价，提交后进入未成交委托。';
        }catch(error){find('estimate').textContent=error.message;}
    }
    function render() {
        try {
            const ctx=getContext(),c=financeConfig(ctx),s=financeState(ctx,c),t=financeTotals(s),ready=Boolean(calendarChat(ctx));
            syncEnabled();
            find('scope').textContent=ready?'当前账户：'+(ctx.name1??'用户')+' · '+c.currency+' · 当前聊天独立保存':'请先打开角色卡和聊天。';
            find('summary').replaceChildren(card('净资产',money(t.net),c.currency),card('可用现金',money(t.cash),'证券 '+money(t.stocks)),card('累计资产收益',money(t.profit),'已扣除 GM 资金与资产调整',t.profit>=0?'wo-fin-up':'wo-fin-down'));
            find('session').textContent='第 '+s.day+' 个模拟交易日 · '+(!worldEnabled(ctx)||!c.enabled?'已停用':generating?'聊天生成中':s.running?'自动行情':'已暂停');find('run').textContent=s.running?'暂停行情':'继续行情';
            find('step').disabled=find('run').disabled=!ready||!worldEnabled(ctx)||!c.enabled||generating;find('news').textContent=s.news;
            if(!s.markets[selected])selected=Object.keys(s.markets)[0]??'';
            const entries=Object.entries(s.markets);options(find('symbol'),entries.map(([id,m])=>[id,id+' · '+m.stock.name]),selected);
            const watch=find('watch'),ticker=find('ticker');watch.replaceChildren();ticker.replaceChildren();
            for(const [symbol,m]of entries){const change=(m.price/m.previous-1)*100,cls=change>=0?'wo-fin-up':'wo-fin-down',b=button('',()=>{selected=symbol;render();});b.className='wo-fin-watch-row';if(symbol===selected)b.setAttribute('aria-current','true');b.append(el('strong','',symbol),el('span','',money(m.price)),el('span',cls,percent(change)));b.title=m.stock.name;watch.append(b);if(ticker.children.length<6)ticker.append(card(symbol,money(m.price),percent(change),cls));}
            renderChart(s.markets[selected],selected);estimate();renderOrders(s,c);
            const positions=find('positions');positions.replaceChildren();
            for(const[symbol,p]of Object.entries(s.positions)){const value=s.markets[symbol].price*p.quantity,delta=value-p.cost;const info=el('small',delta>=0?'wo-fin-up':'wo-fin-down','浮动 '+money(delta)+' · '+percent(p.cost?delta/p.cost*100:0));positions.append(row(symbol+' · '+s.markets[symbol].stock.name,p.quantity+' 股 · 均价 '+money(Math.round(p.cost/p.quantity)),money(value),info));}
            if(!positions.children.length)positions.append(el('p','fm-hint','尚未持有股票。'));
            find('allocation').replaceChildren(...[['现金',t.cash],['股票',t.stocks],['商业资产',t.propertyValue],['负债',-t.debt]].map(([name,value])=>row(name,'',money(value)+' '+c.currency)));
            find('preview').textContent=assetPrompt(s,c,ctx.name1);
            find('cashflow').textContent='预计月净现金流 '+money(t.monthlyNet)+' '+c.currency;
            const owned=find('owned');owned.replaceChildren();
            for(const p of s.properties){const n=el('div','wo-fin-panel');n.append(row(p.name,p.type,money(p.value)+' '+c.currency),el('p','fm-hint',p.description),el('p','fm-hint','负债 '+money(p.debt)+' · 月收入 '+money(p.monthlyIncome)+' · 月成本 '+money(p.monthlyCost)));
                const actions=el('div','fm-actions');actions.append(button('按估值出售并还债',()=>action(s=>sellProperty(s,p.id))));n.append(actions);
                const details=el('details'),form=el('form');details.append(el('summary','','GM 调整经营状态'));const fields={};
                for(const[key,title]of Object.entries({value:'估值',debt:'负债',monthlyIncome:'月收入',monthlyCost:'月成本',annualGrowth:'估值年增长率 %',interestRate:'负债年利率 %'})){const label=el('label','',title),input=el('input','text_pole');input.type='number';input.step='0.01';input.value=key==='annualGrowth'||key==='interestRate'?p[key]:p[key]/100;input.required=true;fields[key]=input;label.append(input);form.append(label);}
                const save=button('应用本聊天经营状态',()=>action(s=>updateProperty(s,p.id,Object.fromEntries(Object.entries(fields).map(([k,i])=>[k,Number(i.value)])))));form.append(save);form.addEventListener('submit',event=>event.preventDefault());details.append(form);n.append(details);owned.append(n);
            }
            if(!s.properties.length)owned.append(el('p','fm-hint','尚未拥有商业资产，可在下方购入或用 GM 授予。'));
            const properties=find('properties');properties.replaceChildren();for(const p of c.properties){const actions=el('div','fm-actions');if(!s.properties.some(item=>item.id===p.id))actions.append(button('购入',()=>action(s=>acquireProperty(s,p))),button('GM 授予',()=>action(s=>acquireProperty(s,p,true))));else actions.append(el('small','','已持有'));properties.append(row(p.name,p.type+' · 月收入 '+money(cents(p.monthlyIncome))+' / 月成本 '+money(cents(p.monthlyCost)),money(cents(p.value))+' '+c.currency,actions));}
            const ledger=find('ledger');ledger.replaceChildren();for(const e of [...s.ledger].reverse())ledger.append(row(e.kind+' · 第 '+e.day+' 日',e.note,(e.amount>=0?'+':'')+money(e.amount),el('small','','余额 '+money(e.balance))));if(!s.ledger.length)ledger.append(el('p','fm-hint','暂无流水。'));
        }catch(error){say(error.message,true);}
    }
    const stockFields={symbol:['股票代码','text',''],name:['名称','text',''],sector:['行业','text','自定义'],price:['初始股价','number',100],volatility:['年化波动率 %','number',30],annualReturn:['年化趋势 %','number',6],dividendYield:['年化分红率 %','number',0]};
    const propertyFields={id:['资产标识','text',''],name:['名称','text',''],type:['类别','text','商业地产'],value:['估值','number',100000],monthlyIncome:['月收入','number',1000],monthlyCost:['月成本','number',100],annualGrowth:['估值年增长率 %','number',2],debt:['负债','number',0],interestRate:['负债年利率 %','number',0]};
    for(const[kind,fields]of [['stock',stockFields],['property',propertyFields]])for(const[key,[title,type]]of Object.entries(fields)){const label=el('label','',title),input=el('input','text_pole');input.id='wo-fin-'+kind+'-'+key;input.type=type;input.required=true;if(type==='number')input.step='0.01';label.append(input);find(kind+'-fields').append(label);}
    function fillEditor(kind){const c=financeConfig(getContext()),value=(kind==='stock'?c.stocks:c.properties).find(v=>(kind==='stock'?v.symbol:v.id)===find(kind+'-editor').value);for(const[key,[,,fallback]]of Object.entries(kind==='stock'?stockFields:propertyFields))find(kind+'-'+key).value=value?.[key]??fallback;find(kind+'-'+(kind==='stock'?'symbol':'id')).readOnly=Boolean(value);find(kind+'-remove').disabled=!value;if(kind==='property')find('property-description').value=value?.description??'';}
    function fillSettings(){const c=financeConfig(getContext());find('enabled').checked=c.enabled;for(const[id,key]of [['currency','currency'],['initial','initialCash'],['interval','tickSeconds'],['fee','feeBps'],['spread','spreadBps']])find(id).value=c[key];find('gm-cash').value=financeState(getContext(),c).cash/100;for(const kind of ['stock','property']){const current=find(kind+'-editor').value;options(find(kind+'-editor'),[['','＋ 新建'],...(kind==='stock'?c.stocks.map(v=>[v.symbol,v.symbol+' · '+v.name]):c.properties.map(v=>[v.id,v.name]))],current);fillEditor(kind);}}
    function refresh(force=false){const ctx=getContext(),next=calendarChat(ctx);if(force||next!==scope||metadata!==ctx.chatMetadata||settingsRef!==ctx.extensionSettings[FINANCE_KEY]){epoch++;stop();scope=next;metadata=ctx.chatMetadata;settingsRef=ctx.extensionSettings[FINANCE_KEY];restoring=false;try{fillSettings();}catch(error){say(error.message,true);}}if(active())render();schedule();}
    for(const tab of page.querySelectorAll('[data-fin-tab]'))tab.addEventListener('click',()=>setView(tab.dataset.finTab));
    find('run').addEventListener('click',()=>{restoring=false;void action(s=>setRunning(s,!s.running));});find('step').addEventListener('click',()=>action((s,c)=>advanceMarket(s,c)));
    find('symbol').addEventListener('change',()=>{selected=find('symbol').value;renderChart(financeState(getContext()).markets[selected],selected);estimate();});
    for(const name of ['side','order-type','quantity','limit'])find(name).addEventListener('input',estimate);
    find('trade').addEventListener('submit',event=>{event.preventDefault();void action((s,c)=>placeTrade(s,c,{side:find('side').value,symbol:find('symbol').value,quantity:Number(find('quantity').value),limit:find('order-type').value==='limit'?cents(Number(find('limit').value)):undefined}));});
    find('gm-form').addEventListener('submit',event=>{event.preventDefault();void action(s=>gmCash(s,Number(find('gm-cash').value)));});
    find('config-form').addEventListener('submit',guarded(()=>saveConfig({...financeConfig(getContext()),enabled:find('enabled').checked,currency:find('currency').value,initialCash:Number(find('initial').value),tickSeconds:Number(find('interval').value),feeBps:Number(find('fee').value),spreadBps:Number(find('spread').value)})));
    for(const name of ['enabled','master-enabled'])find(name).addEventListener('change',toggleEnabled);
    for(const kind of ['stock','property']){
        find(kind+'-editor').addEventListener('change',()=>fillEditor(kind));
        find(kind+'-form').addEventListener('submit',guarded(()=>{const raw=Object.fromEntries(Object.entries(kind==='stock'?stockFields:propertyFields).map(([key,[,type]])=>[key,type==='number'?Number(find(kind+'-'+key).value):find(kind+'-'+key).value]));if(kind==='property')raw.description=find('property-description').value;const value=(kind==='stock'?validateStock:validateProperty)(raw),key=kind==='stock'?'symbol':'id',collection=kind==='stock'?'stocks':'properties',c=financeConfig(getContext());if(!find(kind+'-editor').value&&c[collection].some(v=>v[key]===value[key]))throw new Error('此标识已存在，请从下拉列表选择后编辑。');saveConfig({...c,[collection]:[...c[collection].filter(v=>v[key]!==value[key]),value]});find(kind+'-editor').value=value[key];fillEditor(kind);}));
        find(kind+'-remove').addEventListener('click',guarded(()=>{const c=financeConfig(getContext()),key=kind==='stock'?'symbol':'id',collection=kind==='stock'?'stocks':'properties',id=find(kind+'-editor').value;saveConfig({...c,[collection]:c[collection].filter(v=>v[key]!==id)});}));
    }
    const ctx=getContext(),macro=()=>{try{const ctx=getContext();if(!worldEnabled(ctx)||!calendarChat(ctx)||!financeConfig(ctx).enabled||!ctx.chatMetadata?.[FINANCE_KEY])return '';return assetPrompt(financeState(ctx),financeConfig(ctx),ctx.name1);}catch(error){say('资产宏未注入：'+error.message,true);return '';}};
    if(typeof ctx.registerMacro==='function')ctx.registerMacro('asset',macro,'当前聊天的金融资产、持仓与商业经营状态');else if(ctx.macros?.register)ctx.macros.register('asset',{handler:macro,description:'当前聊天金融资产'});else say('当前宿主不支持宏注册。',true);
    root.addEventListener('world-os:page',()=>{refresh();if(active()&&!getContext().chatMetadata?.[FINANCE_KEY])void action(s=>s,true);});root.addEventListener('close',stop);root.addEventListener('beforetoggle',event=>{if(event.newState==='closed')stop();});document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else schedule();});
    page.addEventListener('focusin',event=>{if(event.target.matches('input:not([type=checkbox]),textarea,select'))stop();});page.addEventListener('focusout',()=>queueMicrotask(schedule));
    for(const name of ['CHAT_CHANGED','CHAT_LOADED','CHARACTER_SELECTED'])if(ctx.eventTypes[name])ctx.eventSource.on(ctx.eventTypes[name],()=>refresh(true));
    if(ctx.eventTypes.GENERATION_STARTED)ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED,()=>{generating=true;stop();if(active())render();});
    for(const name of ['GENERATION_ENDED','GENERATION_STOPPED'])if(ctx.eventTypes[name])ctx.eventSource.on(ctx.eventTypes[name],()=>{generating=false;if(active())render();schedule();});
    document.addEventListener(WORLD_EVENT,event=>{if(event.detail?.kind==='before-restore'){epoch++;restoring=true;stop();}else refresh(event.detail?.kind==='restore');});
    refresh(true);setView('market');
}
