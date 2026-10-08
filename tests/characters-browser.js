import { CHARACTERS_KEY, currentState } from '../characters-core.js';
import { WORLD_KEY } from '../world-state.js';
import { CALENDAR_KEY, CALENDAR_WORLD } from '../calendar-core.js';
import { createSnapshot, validateSnapshot } from '../snapshots.js';

export async function runCharacterChecks({ check, assert, waitFor, delay, emit, getContext, setContext, tauri, macros }) {
    const q=id=>document.querySelector('#'+id), original=getContext();
    const ctx={...original,characterId:0,characters:[{avatar:'directory-guide.png',name:'目录测试'}],name2:'目录测试',chatId:'directory-chat',
        chat:[],chatMetadata:{foreign:{keep:true}},extensionSettings:{...original.extensionSettings,[WORLD_KEY]:{enabled:true},
            floor_summary_memory:{...original.extensionSettings.floor_summary_memory,enabled:false,aiKeywordAuto:false},
            [CHARACTERS_KEY]:{schema:1,cards:{}}},saveMetadata:async()=>{},saveSettingsDebounced:()=>{}};
    setContext(ctx);emit('CHAT_CHANGED');
    if(!q('world-os').open)q('wo-launcher').click();q('wo-open-characters').click();
    const submit = async id => { q(id).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await delay(40); };
    const status=()=>q('wo-ch-status').textContent;
    const tab=name=>document.querySelector('[data-ch-tab="'+name+'"]').click();
    const characters=()=>getContext().extensionSettings[CHARACTERS_KEY].cards['character:directory-guide.png']??[];
    let mainId;
    await check('角色目录使用通讯录图标，保存头像、状态与阶段，中文按拼音排序',async()=>{
        assert(q('wo-open-characters').querySelector('.fa-address-book'),'contact icon missing');
        assert(q('world-os').dataset.page==='characters','directory page missing');
        q('wo-ch-add').click();q('wo-ch-name').value='示例角色甲';q('wo-ch-keywords').value='示例角色甲,角色甲';
        q('wo-ch-description').value='示例角色甲，年龄 {{age}}；身高 {{heigh}}；和苏岚是{{relationship.苏岚}}。';
        const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
        const paint=canvas.getContext('2d');paint.fillStyle='#437c75';paint.fillRect(0,0,128,128);paint.fillStyle='#effaf6';paint.font='60px sans-serif';paint.fillText('甲',34,86);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const picture=new DataTransfer();picture.items.add(new File([blob],'avatar.png',{type:'image/png'}));
        q('wo-ch-avatar-file').files=picture.files;q('wo-ch-avatar-file').dispatchEvent(new Event('change',{bubbles:true}));
        await waitFor(()=>q('wo-ch-avatar').value.startsWith('data:image/'),'uploaded avatar');
        assert(q('wo-ch-avatar-preview').querySelector('img'),'uploaded avatar did not render');
        q('wo-ch-base-state').value=JSON.stringify({age:20,heigh:'165cm',affection:0,relationship:[{苏岚:'初识'}]});
        q('wo-ch-add-stage').click();
        const stage=q('wo-ch-stages').firstElementChild;stage.querySelector('[data-stage-name]').value='信赖';
        stage.querySelector('[data-stage-content]').value='她已经信赖你。好感度 {{affection}}。';
        [...stage.querySelectorAll('button')].find(button=>button.textContent.includes('添加条件')).click();
        stage.querySelector('[data-condition-path]').value='affection';stage.querySelector('[data-condition-op]').value='>=';
        stage.querySelector('[data-condition-value]').value='50';
        q('wo-ch-permissions-from-state').click();await delay(40);
        assert(q('wo-ch-policies').children.length===4,'state field permissions missing');
        await submit('wo-ch-definition-form');assert(characters().length===1,status());mainId=characters()[0].id;
        q('wo-ch-list-back').click();q('wo-ch-add').click();q('wo-ch-name').value='苏岚';q('wo-ch-keywords').value='苏岚';
        q('wo-ch-description').value='苏岚，年龄 {{age}}。';await submit('wo-ch-definition-form');
        q('wo-ch-list-back').click();
        assert(q('wo-ch-list').querySelector('.wo-ch-contact strong').textContent==='示例角色甲','pinyin sorting incorrect');
        assert(q('wo-ch-list').querySelectorAll('.wo-ch-avatar').length===2,'avatars missing');
    });
    await check('列表红绿图标与匹配开关、空关键词同步，无需进入详情即可辨认',async()=>{
        const first=()=>q('wo-ch-list').querySelector('.wo-ch-contact');
        assert(first().querySelector('.wo-ch-match-status.is-enabled'),'enabled indicator missing');
        const green=getComputedStyle(first().querySelector('.wo-ch-match-status')).color;
        first().click();q('wo-ch-enabled').checked=false;await submit('wo-ch-definition-form');tab('list');
        let indicator=first().querySelector('.wo-ch-match-status');
        assert(indicator.classList.contains('is-disabled')&&indicator.getAttribute('aria-label').includes('已关闭'),'disabled status missing');
        assert(getComputedStyle(indicator).color!==green,'red and green indicators use the same color');
        first().click();q('wo-ch-enabled').checked=true;const keywords=q('wo-ch-keywords').value;q('wo-ch-keywords').value='';
        await submit('wo-ch-definition-form');tab('list');
        indicator=first().querySelector('.wo-ch-match-status');
        assert(indicator.classList.contains('is-disabled')&&indicator.getAttribute('aria-label').includes('未设置关键词'),'empty keywords shown as participating');
        first().click();q('wo-ch-keywords').value=keywords;await submit('wo-ch-definition-form');tab('list');
        assert(first().querySelector('.wo-ch-match-status.is-enabled'),'restored matching status stale');
    });
    await check('角色宏使用原始最新两条消息，阶段和状态按当前聊天组装',async()=>{
        assert(macros.has('character'),'character macro not registered');
        ctx.chat=[{mes:'旧消息提到苏岚',is_user:true},{mes:'模型说起示例角色甲',is_user:false},{mes:'我向她挥手',is_user:true}];
        const text=macros.get('character')();assert(text.includes('<示例角色甲>')&&!text.includes('<苏岚>'),'query range not last two messages');
        assert(text.includes('年龄 20')&&text.includes('初识')&&!text.includes('信赖你'),'state/stage expansion wrong');
        const another={...ctx,chatId:'second-chat',chatMetadata:{}};setContext(another);emit('CHAT_CHANGED');
        assert(characters().length===2,'definitions not shared');
        setContext(ctx);emit('CHAT_CHANGED');
    });
    await check('独立状态 API 拉取模型与测试，返回错误指令不写测试聊天',async()=>{
        tab('api');const form=q('wo-ch-api-form');
        const second=q('wo-ch-prompts').children[1];
        [...second.querySelectorAll('button')].find(button=>button.textContent==='↑').click();
        assert(q('wo-ch-prompts').firstElementChild===second,'preset message could not move up');
        [...second.querySelectorAll('button')].find(button=>button.textContent==='↓').click();
        assert(q('wo-ch-prompts').children[1]===second,'preset message could not move down');
        form.elements.endpoint.value=location.origin+'/character/v1';form.elements.apiKey.value='test-state-key';
        q('wo-ch-models').click();await waitFor(()=>q('wo-ch-model-status').textContent.includes('2 个模型'),'state models');
        q('wo-ch-model-select').value='state-small';q('wo-ch-model-select').dispatchEvent(new Event('change',{bubbles:true}));
        assert(form.elements.model.value==='state-small','model picker not applied');
        form.elements.auto.checked=true;form.elements.temperature.value='0.35';await submit('wo-ch-api-form');
        assert(ctx.extensionSettings[CHARACTERS_KEY].api.model==='state-small','api not saved');
        q('wo-ch-test-api').click();await waitFor(()=>status().includes('测试成功'),'state api test');
        assert(!ctx.chatMetadata[CHARACTERS_KEY]?.states,'test request changed live state');
        const state=await fetch('/__state').then(r=>r.json());assert(state.characterCalls.at(-1).temperature===.35,'parameter not forwarded');
        assert(!ctx.extensionSettings[CHARACTERS_KEY].api.apiKey,'session key persisted without permission');
    });
    async function arm() {
        emit('GENERATION_STARTED','normal',{},false);
        await globalThis.floorMemoryInterceptor(ctx.chat.map((message,index)=>({...message,index})),32000,()=>{throw Error('abort');},'normal');
        const content=macros.get('character')();
        emit('CHAT_COMPLETION_PROMPT_READY',{chat:[{role:'system',content}],dryRun:false});
        return content;
    }
    await check('虚拟发送不更新；真实回复后只更新本轮调用者并拒绝未授权 delete',async()=>{
        const before=(await fetch('/__state').then(r=>r.json())).characterCalls.length;
        await arm();emit('GENERATION_ENDED');await delay(300);
        assert((await fetch('/__state').then(r=>r.json())).characterCalls.length===before,'virtual generation updated characters');
        await arm();ctx.chat.push({mes:'示例角色甲点头答应。',is_user:false,send_date:Date.now()});
        emit('MESSAGE_RECEIVED',ctx.chat.length-1);emit('CHARACTER_MESSAGE_RENDERED',ctx.chat.length-1);emit('GENERATION_ENDED');
        await waitFor(()=>ctx.chatMetadata[CHARACTERS_KEY]?.states?.[mainId]?.affection===60,'automatic state update');
        assert(ctx.chatMetadata[CHARACTERS_KEY].states[mainId].age===20,'unauthorized delete was applied');
        assert(Object.keys(ctx.chatMetadata[CHARACTERS_KEY].states).length===1,'uncalled character was updated');
        assert(ctx.chatMetadata[CHARACTERS_KEY].debug.ignored.length===2,'ignored operations not recorded');
        assert(macros.get('character')().includes('她已经信赖你'),'stage did not advance');
    });
    await check('图谱入口已移除，角色详情和调试仍提供关系状态与前后对比',async()=>{
        tab('list');q('wo-ch-list').querySelector('.wo-ch-contact').click();
        assert(q('wo-ch-current-state').value.includes('60'),'detail state stale');assert(q('wo-ch-stage-current').textContent.includes('信赖'),'stage label stale');
        assert(!q('wo-ch-graph')&&!document.querySelector('[data-ch-tab="relations"]'),'removed graph still available');
        assert(document.querySelectorAll('[data-ch-tab]').length===3,'bottom navigation is not three tabs');
        assert(q('wo-ch-current-state').value.includes('relationship'),'graph removal deleted relationship state');
        tab('debug');const text=q('wo-ch-debug').textContent;
        assert(text.includes('上一轮：0')&&text.includes('当前：60'),'state comparison missing');
        assert(text.includes('被忽略的 AI 指令'),'rejected operation details missing');
    });
    await check('手动状态要求与当前状态编辑生效，切换聊天不会污染另一聊天',async()=>{
        tab('list');q('wo-ch-list').querySelector('.wo-ch-contact').click();
        q('wo-ch-current-state').value=JSON.stringify({age:21,heigh:'165cm',affection:30,relationship:[{苏岚:'伙伴'}]});
        await submit('wo-ch-state-form');assert(ctx.chatMetadata[CHARACTERS_KEY].states[mainId].age===21,status());
        q('wo-ch-manual-requirements').value='记录本轮帮助后的好感变化';
        q('wo-ch-manual-update').click();await waitFor(()=>currentState(ctx,characters().find(item=>item.id===mainId)).affection===60,'manual update');
        const calls=(await fetch('/__state').then(r=>r.json())).characterCalls;assert(calls.at(-1).messages.some(item=>item.content.includes('记录本轮帮助后的好感变化')),'manual requirements absent');
        setContext({...ctx,chatId:'different-chat',chatMetadata:{}});emit('CHAT_CHANGED');
        assert(currentState(getContext(),characters().find(item=>item.id===mainId)).age===20,'chat state leaked');
        setContext(ctx);emit('CHAT_CHANGED');
    });
    await check('world os 总开关同步首页与扩展页并停止三项功能的注入和自动调用',async()=>{
        q('wo-back').click();const master=q('wo-enabled');master.checked=false;master.dispatchEvent(new Event('change',{bubbles:true}));
        assert(!q('wo-master-enabled').checked&&!ctx.extensionSettings[WORLD_KEY].enabled,'master not synced');
        assert(macros.get('character')()==='','macro active while master disabled');
        assert(q('wo-calendar-quick').disabled,'time toolbar active while disabled');
        ctx.extensionSettings[CALENDAR_KEY]={cards:{'character:directory-guide.png':{name:'星历',enabled:true,months:[30],holidays:[{id:'f',name:'节日',year:null,month:1,day:1,prompt:'设定'}]}}};
        const lore={globalLore:[],characterLore:[],chatLore:[],personaLore:[]};emit('WORLDINFO_ENTRIES_LOADED',lore);
        assert(!lore.chatLore.some(item=>item.world===CALENDAR_WORLD),'holiday injected while master disabled');
        const before=JSON.stringify(ctx.chat);await globalThis.floorMemoryInterceptor(ctx.chat,32000,()=>{throw Error('disabled abort');});
        assert(JSON.stringify(ctx.chat)===before,'memory changed chat while disabled');
        master.checked=true;master.dispatchEvent(new Event('change',{bubbles:true}));assert(q('wo-master-enabled').checked,'master re-enable failed');
    });
    await check('全局快照文件校验、恢复与手机原生导出覆盖各模块，保留其他插件数据',async()=>{
        q('wo-open-snapshot').click();const snapshot=createSnapshot(ctx);validateSnapshot(snapshot);
        const before=ctx.chatMetadata[CHARACTERS_KEY].states[mainId].affection;
        ctx.chatMetadata[CHARACTERS_KEY].states[mainId].affection=1;
        const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(snapshot)],'snapshot.json',{type:'application/json'}));
        q('wo-snapshot-file').files=transfer.files;q('wo-snapshot-file').dispatchEvent(new Event('change',{bubbles:true}));
        await waitFor(()=>!q('wo-snapshot-restore').disabled,'snapshot import validation');
        q('wo-snapshot-restore').click();await waitFor(()=>q('wo-snapshot-status').textContent.includes('已恢复'),'snapshot restore');
        assert(ctx.chatMetadata[CHARACTERS_KEY].states[mainId].affection===before,'snapshot did not restore state');
        assert(ctx.chatMetadata.foreign.keep,'snapshot changed other plugin data');
        if(tauri){
            const count=globalThis.__nativeExports?.length??0;q('wo-snapshot-export').click();
            await waitFor(()=>(globalThis.__nativeExports?.length??0)>count,'native snapshot export');
            assert(globalThis.__nativeExports.at(-1).data.format==='world-os-snapshot','native export format wrong');
        }
    });
    await check('手机角色页和底部菜单无横向溢出，动态内容按文本显示',async()=>{
        q('wo-open-characters').click();tab('list');q('wo-ch-search').value='<img src=x onerror=alert(1)>';q('wo-ch-search').dispatchEvent(new Event('input'));
        assert(!q('wo-ch-list').querySelector('img[src="x"]'),'search injected HTML');
        q('wo-ch-search').value='';q('wo-ch-search').dispatchEvent(new Event('input'));
        const body=q('world-os').querySelector('.wo-window-body');assert(body.scrollWidth<=body.clientWidth+1,'directory horizontal overflow');
        const nav=q('wo-characters').querySelector('.wo-ch-nav');assert(nav.querySelectorAll('button').length===3,'bottom navigation incomplete');
    });
    const { runCGChecks } = await import('./character-cg-browser.js');
    await runCGChecks({check,assert,waitFor,delay,emit,getContext,setContext,macros,mainId});
    await check('默认状态按钮紧邻新建角色，JSON 保存只影响后续新建，空模板与快照可用',async()=>{
        tab('list');
        assert(q('wo-ch-add').parentElement===q('wo-ch-defaults-open').parentElement,'default button is not beside new character');
        const oldCharacters=JSON.stringify(characters()),oldStates=JSON.stringify(ctx.chatMetadata[CHARACTERS_KEY]);
        q('wo-ch-defaults-open').click();await delay(40);
        assert(!document.querySelector('[data-ch-view="defaults"]').hidden,'default settings view did not open');
        q('wo-ch-default-state').value='{"broken":}';await submit('wo-ch-default-form');
        assert(status().includes('不是合法 JSON'),'invalid JSON not reported');
        assert(!ctx.extensionSettings[CHARACTERS_KEY].defaultStates,'invalid template was stored');
        const template={mood:'平静',rank:0,profile:{guild:'守望者'},relationship:[]};
        q('wo-ch-default-state').value=JSON.stringify(template);await submit('wo-ch-default-form');
        assert(JSON.stringify(characters())===oldCharacters,'template changed existing characters');
        assert(JSON.stringify(ctx.chatMetadata[CHARACTERS_KEY])===oldStates,'template changed running states');
        q('wo-ch-defaults-back').click();q('wo-ch-add').click();
        assert(JSON.stringify(JSON.parse(q('wo-ch-base-state').value))===JSON.stringify(template),'new character did not use template');
        q('wo-ch-base-state').value='{"mood":"草稿"}';q('wo-ch-list-back').click();q('wo-ch-defaults-open').click();await delay(40);
        assert(JSON.parse(q('wo-ch-default-state').value).mood==='平静','new-character draft mutated template');
        q('wo-ch-default-state').value='{}';await submit('wo-ch-default-form');
        q('wo-ch-defaults-back').click();q('wo-ch-add').click();
        assert(q('wo-ch-base-state').value==='{}','empty default was replaced with built-in values');
        q('wo-ch-list-back').click();q('wo-ch-defaults-open').click();await delay(40);
        q('wo-ch-default-state').value=JSON.stringify(template);await submit('wo-ch-default-form');
        const snapshot=validateSnapshot(createSnapshot(ctx));
        assert(snapshot.settings[CHARACTERS_KEY].defaultStates['character:directory-guide.png'].mood==='平静','snapshot missing template');
        q('wo-ch-defaults-back').click();
    });
    await check('默认状态跨聊天共享，切换角色卡保护旧草稿，内置模板需保存才覆盖',async()=>{
        const template=JSON.stringify(ctx.extensionSettings[CHARACTERS_KEY].defaultStates);
        setContext({...ctx,chatId:'template-other-chat',chatMetadata:{}});emit('CHAT_CHANGED');
        q('wo-ch-defaults-open').click();await delay(40);
        assert(JSON.parse(q('wo-ch-default-state').value).mood==='平静','same-card chat lost template');
        q('wo-ch-default-reset').click();
        assert(JSON.parse(q('wo-ch-default-state').value).age===20,'built-in template not filled');
        assert(JSON.stringify(ctx.extensionSettings[CHARACTERS_KEY].defaultStates)===template,'reset draft persisted without save');
        setContext({...ctx,characterId:0,characters:[{avatar:'template-other-card.png'}],chatId:'other-card',chatMetadata:{}});emit('CHAT_CHANGED');
        await submit('wo-ch-default-form');assert(status().includes('角色卡已切换'),'late save did not enforce owner');
        q('wo-ch-defaults-open').click();await delay(40);
        assert(JSON.parse(q('wo-ch-default-state').value).age===20,'template leaked into different card');
        const body=q('world-os').querySelector('.wo-window-body');assert(body.scrollWidth<=body.clientWidth+1,'default JSON editor overflow');
        setContext(ctx);emit('CHAT_CHANGED');tab('list');
    });
    await check('调试页查询清洗先于角色与 CG 宏匹配，发送准备等待后台正则，原始聊天不变',async()=>{
        const rawAI='<thinking>苏岚正在别处</thinking><ui>苏岚的状态面板</ui>示例角色甲向你挥手。';
        ctx.chat=[{mes:'旧消息 第二位',is_user:true},{mes:rawAI,is_user:false},{mes:'我走过去。',is_user:true}];
        emit('CHAT_CHANGED');tab('debug');
        assert(macros.get('character')().includes('<苏岚>'),'blank rule changed existing raw matching');
        const before=JSON.stringify(ctx.chat),memory=JSON.stringify(ctx.extensionSettings.floor_memory);
        q('wo-ch-query-pattern').closest('details').open=true;
        q('wo-ch-query-pattern').value=String.raw`<(thinking|ui)\b[^>]*>[\s\S]*?<\/\1>`;
        q('wo-ch-query-flags').value='gi';q('wo-ch-query-replacement').value='';
        await submit('wo-ch-query-form');
        q('wo-ch-query-test').click();
        await waitFor(()=>q('wo-ch-query-preview').textContent==='示例角色甲向你挥手。\n\n我走过去。','clean query preview');
        // Change the text just before generation to exercise the interceptor's async preparation.
        ctx.chat[2].mes='我走过去打招呼。';
        emit('GENERATION_STARTED','normal',{},false);
        await globalThis.floorMemoryInterceptor(ctx.chat.map((message,index)=>({...message,index})),32000,()=>{throw Error('cleanup aborted generation');},'normal');
        const content=macros.get('character')(),cg=macros.get('CG')();
        assert(content.includes('<示例角色甲>')&&!content.includes('<苏岚>'),'hidden text still matched role');
        assert(cg.includes('{{0.晨光}}')&&!cg.includes('{{2.晨光}}'),'CG did not share cleaned selection');
        emit('CHAT_COMPLETION_PROMPT_READY',{chat:[{role:'system',content:content+'\n'+cg}],dryRun:false});
        assert(q('wo-ch-debug').textContent.includes('本次实际匹配查询文本：\n示例角色甲向你挥手。\n\n我走过去打招呼。'),'debug missing actual cleaned query');
        ctx.chat[2].mes='我走过去。';
        assert(JSON.stringify(ctx.chat)===before,'query cleaning modified raw chat');
        assert(JSON.stringify(ctx.extensionSettings.floor_memory)===memory,'query cleaning changed floor-memory config');
        const snapshot=validateSnapshot(createSnapshot(ctx));
        assert(snapshot.settings[CHARACTERS_KEY].queryCleanup.pattern===q('wo-ch-query-pattern').value,'snapshot lost cleanup rule');
        const body=q('world-os').querySelector('.wo-window-body');assert(body.scrollWidth<=body.clientWidth+1,'cleanup controls overflow mobile view');
        emit('GENERATION_STOPPED');
    });
    await check('查询正则无效时拒绝保存，清空后恢复原有匹配；预览按保存规则执行',async()=>{
        const saved=JSON.stringify(ctx.extensionSettings[CHARACTERS_KEY].queryCleanup);
        q('wo-ch-query-pattern').value='(';await submit('wo-ch-query-form');
        assert(status().includes('角色查询清洗正则'),'invalid regex not reported');
        assert(JSON.stringify(ctx.extensionSettings[CHARACTERS_KEY].queryCleanup)===saved,'invalid regex overwrote saved rule');
        q('wo-ch-query-preview').textContent='';q('wo-ch-query-test').click();
        await waitFor(()=>q('wo-ch-query-preview').textContent==='示例角色甲向你挥手。\n\n我走过去。','preview saved rule');
        q('wo-ch-query-pattern').value='';await submit('wo-ch-query-form');
        assert(macros.get('character')().includes('<苏岚>'),'clearing regex did not restore original behavior');
        q('wo-ch-query-test').click();await waitFor(()=>q('wo-ch-query-preview').textContent.includes('<thinking>'),'disabled cleanup preview');
        q('wo-ch-query-pattern').closest('details').open=false;
    });
    globalThis.__showDefaultStateFixture=()=>{
        setContext(ctx);emit('CHAT_CHANGED');if(!q('world-os').open)q('wo-launcher').click();q('wo-open-characters').click();tab('list');q('wo-ch-defaults-open').click();
    };
    globalThis.__showCharacterFixture=()=>{
        setContext(ctx);emit('CHAT_CHANGED');if(!q('world-os').open)q('wo-launcher').click();q('wo-open-characters').click();tab('list');
    };
    setContext(original);emit('CHAT_CHANGED');q('wo-back').click();
}
