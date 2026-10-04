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
        const paint=canvas.getContext('2d');paint.fillStyle='#437c75';paint.fillRect(0,0,128,128);paint.fillStyle='#effaf6';paint.font='60px sans-serif';paint.fillText('罗',34,86);
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
    await check('角色详情、关系有向图和调试页提供当前与上一轮状态',async()=>{
        tab('list');q('wo-ch-list').querySelector('.wo-ch-contact').click();
        assert(q('wo-ch-current-state').value.includes('60'),'detail state stale');assert(q('wo-ch-stage-current').textContent.includes('信赖'),'stage label stale');
        tab('relations');assert(q('wo-ch-graph').querySelector('path[marker-end]'),'directed arrow missing');
        assert(q('wo-ch-relations').textContent.includes('示例角色甲 → 苏岚'),'direction description missing');
        tab('debug');const text=q('wo-ch-debug').textContent;
        assert(text.includes('上一轮：0')&&text.includes('当前：60'),'state comparison missing');
        assert(text.includes('被忽略的 AI 指令'),'rejected operation details missing');
    });
    await check('手动状态要求与当前状态编辑生效，切换聊天不会污染另一聊天',async()=>{
        tab('list');q('wo-ch-list').querySelector('.wo-ch-contact').click();
        q('wo-ch-current-state').value=JSON.stringify({age:21,heigh:'165cm',affection:30,relationship:[{苏岚:'伙伴'}]});
        await submit('wo-ch-state-form');assert(ctx.chatMetadata[CHARACTERS_KEY].states[mainId].age===21,status());
        q('wo-ch-manual-requirements').value='记录本轮帮助后的好感变化';
        q('wo-ch-manual-update').click();await waitFor(()=>currentState(ctx,characters()[0]).affection===60,'manual update');
        const calls=(await fetch('/__state').then(r=>r.json())).characterCalls;assert(calls.at(-1).messages.some(item=>item.content.includes('记录本轮帮助后的好感变化')),'manual requirements absent');
        setContext({...ctx,chatId:'different-chat',chatMetadata:{}});emit('CHAT_CHANGED');
        assert(currentState(getContext(),characters()[0]).age===20,'chat state leaked');
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
        const nav=q('wo-characters').querySelector('.wo-ch-nav');assert(nav.querySelectorAll('button').length===4,'bottom navigation incomplete');
    });
    globalThis.__showCharacterFixture=()=>{
        setContext(ctx);emit('CHAT_CHANGED');if(!q('world-os').open)q('wo-launcher').click();q('wo-open-characters').click();tab('list');
    };
    setContext(original);emit('CHAT_CHANGED');q('wo-back').click();
}
