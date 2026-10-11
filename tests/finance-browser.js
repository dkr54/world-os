import { FINANCE_KEY, financeState, financeConfig, createFinanceState, validateFinanceConfig, placeTrade, acquireProperty, advanceMarket, setRunning } from '../finance-core.js';
import { WORLD_KEY, announceWorldChange } from '../world-state.js';
import { createSnapshot, restoreSnapshot } from '../snapshots.js';

export async function runFinanceChecks({check,assert,waitFor,delay,emit,getContext,setContext,macros}) {
    const q=id=>document.querySelector('#wo-fin-'+id),original=getContext();let saves=0;
    const ctx={...original,characterId:0,characters:[{avatar:'finance-test.png',name:'金融测试'}],chatId:'finance-chat',name1:'投资者',chat:[],chatMetadata:{foreign:{keep:true}},
        extensionSettings:{...original.extensionSettings,[WORLD_KEY]:{enabled:true},[FINANCE_KEY]:{cards:{'character:finance-test.png':validateFinanceConfig({tickSeconds:2})}}},
        saveMetadata:async()=>{saves++;},saveSettingsDebounced:()=>{}};
    const open=()=>{if(!document.querySelector('#world-os').open)document.querySelector('#wo-launcher').click();document.querySelector('#wo-back').click();document.querySelector('#wo-open-finance').click();};
    const tab=name=>document.querySelector('[data-fin-tab="'+name+'"]').click();
    const submit=async name=>{q(name).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await delay(80);};
    setContext(ctx);emit('CHAT_CHANGED');
    await check('金融首页入口、独立账户与资产宏就绪，未开通聊天不注入资产',async()=>{
        assert(macros.has('asset'),'asset macro missing');assert(macros.get('asset')()==='','unopened account injected');open();
        await waitFor(()=>Boolean(ctx.chatMetadata[FINANCE_KEY]),'account persisted');assert(q('summary').children.length===3,'wealth overview missing');assert(q('watch').children.length>=12,'default stock catalog missing');
        assert(macros.get('asset')().includes('<asset>')&&macros.get('asset')().includes('100,000.00'),'asset macro not populated');
        q('run').click();await waitFor(()=>!financeState(ctx).running,'pause');
    });
    await check('金融交易、GM 现金、商业资产与流水在真实页面保存并同步宏',async()=>{
        q('symbol').value='AAPL';q('quantity').value='10';await submit('trade');assert(financeState(ctx).positions.AAPL?.quantity===10,q('status').textContent);
        assert(macros.get('asset')().includes('AAPL'),'holding missing from macro');
        tab('settings');q('gm-cash').value='500000';await submit('gm-form');assert(financeState(ctx).cash===50000000,'GM cash not saved');
        q('currency').value='金币';await submit('config-form');assert(financeConfig(ctx).currency==='金币','card settings not saved');
        tab('property');[...q('properties').querySelectorAll('button')].find(b=>b.textContent==='购入').click();await waitFor(()=>financeState(ctx).properties.length===1,'property acquired');
        q('step').click();await waitFor(()=>financeState(ctx).day===1,'manual advance');assert(financeState(ctx).ledger.some(e=>e.kind==='经营结算'),'business did not settle');
        assert(macros.get('asset')().includes('中央公园公寓'),'property missing from macro');tab('ledger');assert(q('ledger').children.length>=4,'ledger empty');
    });
    await check('金融支持股票与商业资产自定义，界面将名称按纯文本显示',async()=>{
        tab('settings');q('stock-editor').value='';q('stock-editor').dispatchEvent(new Event('change'));q('stock-symbol').value='WOS';q('stock-name').value='<img src=x onerror=alert(1)>';q('stock-sector').value='测试行业';await submit('stock-form');
        assert(financeConfig(ctx).stocks.some(s=>s.symbol==='WOS'),'custom stock not saved');assert(!document.querySelector('#wo-finance img'),'stock name parsed as HTML');
        q('property-id').value='test-shop';q('property-name').value='测试商店';await submit('property-form');assert(financeConfig(ctx).properties.some(p=>p.id==='test-shop'),'custom property not saved');
        tab('market');assert([...q('symbol').options].some(o=>o.value==='WOS'),'new stock missing from trading list');
    });
    await check('行情仅在金融页可见时自动推进，暂停、离页和生成回复都会停止结算',async()=>{
        const before=financeState(ctx).day;q('run').click();await waitFor(()=>financeState(ctx).day>before,'automatic tick',5000);q('run').click();await waitFor(()=>!financeState(ctx).running,'pause again');
        let day=financeState(ctx).day;await delay(2200);assert(financeState(ctx).day===day,'paused market advanced');
        q('run').click();await delay(60);document.querySelector('#wo-back').click();day=financeState(ctx).day;await delay(2200);assert(financeState(ctx).day===day,'market advanced outside app');
        document.querySelector('#wo-open-finance').click();emit('GENERATION_STARTED','normal',{},false);await delay(2200);assert(financeState(ctx).day===day,'market advanced during generation');emit('GENERATION_ENDED');
        q('run').click();await waitFor(()=>!financeState(ctx).running,'pause after generation');
    });
    await check('金融保存失败回滚，切聊天期间保存不会写入另一聊天',async()=>{
        const prior=ctx.chatMetadata[FINANCE_KEY];ctx.saveMetadata=async()=>{throw new Error('模拟写入失败');};tab('settings');q('gm-cash').value='1';await submit('gm-form');assert(ctx.chatMetadata[FINANCE_KEY]===prior,'failed save not rolled back');assert(q('status').textContent.includes('模拟写入失败'),'save error hidden');
        let finish;ctx.saveMetadata=()=>new Promise(resolve=>{finish=resolve;});q('gm-cash').value='1234';q('gm-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await delay(30);
        const other={...ctx,chatId:'other',chatMetadata:{},saveMetadata:async()=>{}};setContext(other);document.querySelector('#wo-back').click();emit('CHAT_CHANGED');finish();await delay(60);assert(!other.chatMetadata[FINANCE_KEY],'old save contaminated another chat');assert(financeConfig(other).currency==='金币','settings not shared');assert(macros.get('asset')()==='','empty chat injected old assets');
        setContext(ctx);ctx.saveMetadata=async()=>{saves++;};emit('CHAT_CHANGED');open();
    });
    await check('金融快照恢复账户与模拟进度，总开关关闭后资产宏为空',async()=>{
        const snapshot=createSnapshot(ctx),cash=financeState(ctx).cash;tab('settings');q('gm-cash').value='10';await submit('gm-form');announceWorldChange('before-restore');await restoreSnapshot(snapshot,ctx);announceWorldChange('restore');assert(financeState(ctx).cash===cash,'snapshot finance not restored');
        ctx.extensionSettings[WORLD_KEY].enabled=false;announceWorldChange('master');assert(macros.get('asset')()==='','master off still injected');ctx.extensionSettings[WORLD_KEY].enabled=true;announceWorldChange('master');
        q('enabled').click();assert(macros.get('asset')()==='','finance off still injected');q('enabled').click();
    });
    await check('金融顶部总开关即时生效，停用全部结算并保留账户与设置草稿，同卡共享',async()=>{
        tab('settings');q('currency').value='尚未保存的单位';
        if(!financeState(ctx).running){q('run').click();await waitFor(()=>financeState(ctx).running,'enable automatic before switch');}
        const before=JSON.stringify(ctx.chatMetadata[FINANCE_KEY]);q('master-enabled').click();
        assert(!financeConfig(ctx).enabled&&!q('enabled').checked,'top switch not synced or saved');assert(q('currency').value==='尚未保存的单位'&&financeConfig(ctx).currency==='金币','switch saved or discarded another draft');
        assert(macros.get('asset')()==='','disabled macro not empty');q('gm-cash').value='999';await submit('gm-form');await submit('trade');q('step').click();await delay(2200);
        assert(JSON.stringify(ctx.chatMetadata[FINANCE_KEY])===before,'disabled account changed');
        const other={...ctx,chatId:'same-card',chatMetadata:{}};setContext(other);emit('CHAT_CHANGED');assert(!q('master-enabled').checked&&!financeConfig(other).enabled,'same card switch not shared');
        const otherCard={...other,characters:[{avatar:'other-finance-card.png'}]};setContext(otherCard);emit('CHAT_CHANGED');assert(q('master-enabled').checked,'other card inherited disabled setting');
        setContext(ctx);emit('CHAT_CHANGED');q('master-enabled').click();assert(financeConfig(ctx).enabled&&q('enabled').checked,'reenable failed');assert(JSON.stringify(ctx.chatMetadata[FINANCE_KEY])===before,'reenable reset account');
        await waitFor(()=>financeState(ctx).day>JSON.parse(before).day,'automatic resumes after enable',5000);
        q('run').click();await waitFor(()=>!financeState(ctx).running,'pause resumed market');
    });
    await check('金融手机布局不横向溢出，行情图和所有子页均可访问',async()=>{
        for(const name of ['market','portfolio','property','ledger','settings']){tab(name);const body=document.querySelector('.wo-window-body');assert(body.scrollWidth<=body.clientWidth+1,'finance overflow: '+name);}
        tab('market');assert(q('chart').querySelector('rect'),'candles missing');assert(saves>0,'financial actions not persisted');
    });
    globalThis.__showFinanceFixture=()=>{
        const c=financeConfig(ctx);let s=createFinanceState(c,'finance-fixture');s=placeTrade(s,c,{side:'buy',symbol:'AAPL',quantity:80});s=placeTrade(s,c,{side:'buy',symbol:'NVDA',quantity:120});s=acquireProperty(s,c.properties[1],true);s=advanceMarket(s,c,45);ctx.chatMetadata[FINANCE_KEY]=setRunning(s,false);
        setContext(ctx);emit('CHAT_CHANGED');open();tab('market');document.querySelector('.wo-window-body').scrollTop=0;
    };
    document.querySelector('#wo-back').click();setContext(original);emit('CHAT_CHANGED');
}
