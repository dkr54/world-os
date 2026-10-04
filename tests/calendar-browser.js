import { CALENDAR_KEY, CALENDAR_WORLD, DEFAULT_CALENDAR, calendarChat } from '../calendar-core.js';

export async function runCalendarChecks({ check, assert, waitFor, delay, emit, getContext, setContext, tauri, testLayout, layoutListeners }) {
    const q = id => document.querySelector('#' + id);
    const originalContext = getContext();
    const settings = { ...originalContext.extensionSettings, [CALENDAR_KEY]: { cards: {} } };
    const saved = new Map();
    const persist = async () => { const ctx = getContext(); saved.set(calendarChat(ctx), structuredClone(ctx.chatMetadata)); };
    const first = { ...originalContext, characterId:0, characters:[{avatar:'calendar-guide.png',name:'日历测试角色'}], name2:'日历测试角色',
        chatId:'calendar-a', chatMetadata:{}, extensionSettings:settings, saveMetadata:persist,
        substituteParams:value=>value.replaceAll('{{user}}','旅行者') };
    first.extensionSettings = { ...settings, floor_summary_memory:{...originalContext.extensionSettings.floor_summary_memory,enabled:false,aiKeywordAuto:false} };
    setContext(first); emit('CHAT_CHANGED');
    const current = () => getContext().extensionSettings[CALENDAR_KEY]?.cards?.['character:calendar-guide.png'];
    const value = (id, text) => { q(id).value = text; };
    const submit = async id => { q(id).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await waitFor(()=>!q('wo-cal-controls').disabled,'calendar action'); };
    const openCalendar = () => { if (!q('world-os').open) q('wo-launcher').click(); q('wo-open-calendar').click(); };
    const openQuick = () => { q('world-os').close(); q('wo-calendar-quick').click(); };
    const setDate = async (year,month,day) => {
        value('wo-cal-date-year',year);value('wo-cal-date-month',month);value('wo-cal-date-day',day);await submit('wo-cal-date-form');
    };
    const scan = () => {
        const existing = { world:'existing',uid:1,position:1,order:200,content:'原有世界书后部' };
        const data={globalLore:[],characterLore:[],chatLore:[existing],personaLore:[]};
        emit('WORLDINFO_ENTRIES_LOADED',data);
        const args={state:{next:0},sortedEntries:data.chatLore,activated:{entries:new Map([['existing.1',existing]]),text:'原扫描文本'},budget:{current:20,overflowed:false}};
        emit('WORLDINFO_SCAN_DONE',args);
        const after=[];[...args.activated.entries.values()].sort((a,b)=>b.order-a.order).forEach(entry=>{if(entry.position===1)after.unshift(entry.content);});
        return {data,args,after};
    };
    await check('日历作为独立应用显示；输入框上方快捷按钮不依赖快速回复扩展', async () => {
        assert(document.querySelector('#wo-open-calendar .fa-calendar-days'),'calendar native icon missing');
        assert(q('wo-calendar-toolbar').nextElementSibling === q('nonQRFormItems'),'shortcut not immediately above composer');
        openCalendar();
        assert(q('world-os').dataset.page==='calendar' && !q('wo-calendar').hidden && q('floor-memory').hidden,'calendar routing wrong');
        q('wo-back').click();assert(q('world-os').dataset.page==='home','calendar back did not return home');openCalendar();
    });
    await check('自定义月份数组校验并保存到角色设置；未改动楼层记忆配置', async () => {
        const memory=JSON.stringify(getContext().extensionSettings.floor_summary_memory);
        value('wo-cal-name','星河历');value('wo-cal-month-count','2');value('wo-cal-months','[2,3,4]');
        await submit('wo-cal-rules-form');assert(!current(),'invalid month array was saved');
        value('wo-cal-months','[2,3]');await submit('wo-cal-rules-form');
        assert(JSON.stringify(current().months)==='[2,3]' && current().name==='星河历','calendar not saved');
        assert(JSON.stringify(getContext().extensionSettings.floor_summary_memory)===memory,'calendar changed memory settings');
    });
    await check('点击日期添加节日，支持每年重复和指定年份，同日多项并存', async () => {
        document.querySelector('#wo-cal-days [data-day="1"]').click();
        assert(q('wo-cal-holiday-panel').open && q('wo-cal-holiday-day').value==='1','day selection did not open editor');
        value('wo-cal-holiday-name','灯火节');value('wo-cal-holiday-prompt','全城点灯，欢迎 {{user}}。');await submit('wo-cal-holiday-form');
        q('wo-cal-new-holiday').click();q('wo-cal-holiday-annual').checked=false;q('wo-cal-holiday-annual').dispatchEvent(new Event('change'));
        value('wo-cal-holiday-year','8');value('wo-cal-holiday-month','1');value('wo-cal-holiday-day','1');
        value('wo-cal-holiday-name','相识纪念日');value('wo-cal-holiday-prompt','这是两人相识的纪念日。');await submit('wo-cal-holiday-form');
        assert(current().holidays.length===2 && current().holidays[1].year===8,'holidays not persisted separately');
        assert(document.querySelector('#wo-cal-days [data-day="1"] .wo-cal-dot'),'holiday marker absent');
        await setDate(7,2,3);
    });
    await check('推进跨年日期，时间和节日名严格前置，完整保留已有输入且不发送消息', async () => {
        const input=q('send_textarea'),original='  已有输入\n下一行 {{user}}';
        input.value=original;input.setSelectionRange(2,4);
        const messages=JSON.stringify(getContext().chat);let inputEvents=0;
        input.addEventListener('input',()=>inputEvents++,{once:true});
        openQuick();assert(q('wo-calendar-jump').open,'quick popup not open');
        assert(q('wo-cal-jump-preview').textContent==='1天过后，星河历8年1月1日\n灯火节、相识纪念日','advance preview wrong');
        await submit('wo-cal-jump-form');
        assert(input.value==='1天过后，星河历8年1月1日\n灯火节、相识纪念日\n'+original,'existing input was replaced, trimmed, or reordered');
        assert(inputEvents===1 && JSON.stringify(getContext().chat)===messages,'input event missing or message sent');
        assert(JSON.stringify(getContext().chatMetadata[CALENDAR_KEY].date)==='{"year":8,"month":1,"day":1}','date not advanced');
        assert(saved.get(calendarChat(getContext()))[CALENDAR_KEY].date.year===8,'date not persisted');
    });
    await check('节日设定经宿主事件加入 World Info 后末尾，展开宏且不改扫描预算', async () => {
        const {after,args}=scan();
        assert(after.length===2 && after[0]==='原有世界书后部','world info order changed');
        assert(after[1].includes('欢迎 旅行者') && after[1].includes('相识纪念日'),'holiday descriptions or macro missing');
        assert(args.budget.current===20 && args.activated.text==='原扫描文本','calendar consumed scan budget');
        emit('WORLDINFO_SCAN_DONE',args);
        assert([...args.activated.entries.values()].filter(entry=>entry.world===CALENDAR_WORLD).length===1,'duplicate holiday injected');
    });
    await check('推进到非节日后清除注入；空日历名不产生多余名称', async () => {
        openCalendar();value('wo-cal-name','');await submit('wo-cal-rules-form');
        openQuick();assert(q('wo-cal-jump-preview').textContent==='1天过后，8年1月2日','unnamed calendar prefix wrong');
        await submit('wo-cal-jump-form');assert(scan().after.length===1,'stale festival survived new date');
    });
    await check('同卡其他聊天共用规则和节日，日期独立；其他角色使用独立日历', async () => {
        const firstState=getContext(),dateA=JSON.stringify(firstState.chatMetadata[CALENDAR_KEY].date);
        const second={...firstState,chatId:'calendar-b',chatMetadata:{}};
        setContext(second);emit('CHAT_CHANGED');openCalendar();
        assert(q('wo-cal-date-year').value==='1' && q('wo-cal-month-count').value==='2','same-card new chat did not share definition and reset date');
        value('wo-cal-name','共享历');await submit('wo-cal-rules-form');await setDate(20,1,2);
        setContext(firstState);emit('CHAT_CHANGED');
        assert(q('wo-cal-name').value==='共享历' && JSON.stringify(getContext().chatMetadata[CALENDAR_KEY].date)===dateA,'dates leaked between chats or rules not shared');
        const third={...firstState,characters:[{avatar:'another-card.png',name:'另一角色'}],chatId:'other',chatMetadata:{}};
        setContext(third);emit('CHAT_CHANGED');
        assert(q('wo-cal-name').value==='' && q('wo-cal-month-count').value==='12' && !q('wo-cal-holidays').textContent.includes('灯火节'),'definitions leaked into another card');
        setContext(firstState);emit('CHAT_CHANGED');
    });
    await check('重新载入聊天恢复日期；保存失败时恢复原日期与未修改的输入', async () => {
        const ctx=getContext(),restored={...ctx,chatMetadata:structuredClone(saved.get(calendarChat(ctx)))};
        setContext(restored);emit('CHAT_LOADED');assert(q('wo-cal-date-year').value==='8','persisted date not restored');
        const previous=JSON.stringify(restored.chatMetadata[CALENDAR_KEY]);q('send_textarea').value='保存失败也不能丢失';
        restored.saveMetadata=async()=>{throw new Error('模拟保存失败');};
        openQuick();await submit('wo-cal-jump-form');
        assert(q('wo-cal-jump-status').textContent.includes('保存失败'),'save error hidden');
        assert(q('send_textarea').value==='保存失败也不能丢失' && JSON.stringify(restored.chatMetadata[CALENDAR_KEY])===previous,'failed save left a partial operation');
        q('wo-cal-jump-close').click();restored.saveMetadata=persist;
    });
    await check('保存过程中切换聊天，不会把旧日期提示词或完成状态写到新聊天', async () => {
        const old=getContext();let finish;
        old.saveMetadata=()=>new Promise(resolve=>{finish=resolve;});
        q('send_textarea').value='旧聊天草稿';openQuick();
        q('wo-cal-jump-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        assert(finish && q('send_textarea').value.endsWith('旧聊天草稿'),'advance did not begin on source chat');
        const next={...old,chatId:'new-during-save',chatMetadata:{},saveMetadata:persist};
        setContext(next);q('send_textarea').value='新聊天草稿';emit('CHAT_CHANGED');
        finish();await waitFor(()=>!q('wo-cal-controls').disabled,'old save completion');
        assert(q('send_textarea').value==='新聊天草稿' && !next.chatMetadata[CALENDAR_KEY],'late save corrupted destination chat');
        assert(!q('wo-calendar-jump').open,'chat switch left stale popup open');
        old.saveMetadata=persist;setContext(old);emit('CHAT_CHANGED');
    });
    await check('关闭日历功能停用快捷推进和节日注入，节日文本作为纯文本显示', async () => {
        openCalendar();await setDate(8,1,1);q('wo-cal-enabled').checked=false;await submit('wo-cal-rules-form');
        assert(q('wo-calendar-quick').disabled && scan().after.length===1,'disabled calendar still injects');
        q('wo-cal-enabled').checked=true;await submit('wo-cal-rules-form');
        q('wo-cal-new-holiday').click();value('wo-cal-holiday-name','<img src=x onerror=alert(1)>');
        value('wo-cal-holiday-month',1);value('wo-cal-holiday-day',2);value('wo-cal-holiday-prompt','<script>not executable</script>');
        await submit('wo-cal-holiday-form');
        assert(!q('wo-cal-holidays').querySelector('img,script') && q('wo-cal-holidays').textContent.includes('<img'),'holiday HTML executed or was interpreted');
        q('wo-calendar').querySelectorAll('.wo-cal-holiday .fm-actions button')[5].click();
        await waitFor(()=>current().holidays.length===2,'holiday delete');
    });
    if (tauri) await check('日历与推进窗口适配 Android 窄屏和键盘，原生返回关闭顶部窗口', async () => {
        openCalendar();assert(q('wo-calendar').scrollWidth<=q('wo-calendar').clientWidth+1,'calendar page overflow');
        q('wo-cal-advance-open').click();const popup=q('wo-calendar-jump');
        popup.style.setProperty('--tt-ime-bottom','300px');await delay(30);
        const rect=popup.getBoundingClientRect();assert(rect.bottom<=innerHeight-300+1,'time popup hidden by keyboard');
        const body=popup.querySelector('.wo-cal-jump-body');body.scrollTop=body.scrollHeight;
        const apply=q('wo-cal-jump-apply').getBoundingClientRect();assert(apply.bottom<=rect.bottom && apply.top>=rect.top,'apply unreachable with keyboard');
        [...document.querySelectorAll('dialog[open]')].at(-1).close();
        assert(!popup.open && q('world-os').open,'native back closed wrong window');
        popup.style.removeProperty('--tt-ime-bottom');
    });
    // A self-contained fictional calendar fixture for visual review and touch navigation.
    const demo=getContext();
    demo.extensionSettings[CALENDAR_KEY].cards['character:calendar-guide.png']={
        ...structuredClone(DEFAULT_CALENDAR),schema:1,name:'星河历',holidays:[{id:'demo-festival',name:'团圆节',year:null,month:8,day:15,prompt:'家家点灯，亲友相聚。街道上设有花灯市集。'}],
    };
    demo.chatMetadata[CALENDAR_KEY]={schema:1,date:{year:128,month:8,day:14}};
    q('send_textarea').value='我推开窗，望向城中的街道。';
    emit('CHAT_CHANGED');openCalendar();
    for(const details of q('wo-calendar').querySelectorAll('details'))details.open=false;
    q('wo-back').click();
}
