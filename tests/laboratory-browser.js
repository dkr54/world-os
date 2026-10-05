import { LAB_KEY, cardPackage, installedPackages } from '../laboratory-core.js';
import { examplePackage } from '../laboratory-package.js';
import { WORLD_KEY, announceWorldChange } from '../world-state.js';
import { createSnapshot, restoreSnapshot } from '../snapshots.js';

export async function runLaboratoryChecks({check,assert,waitFor,delay,emit,getContext,setContext,tauri}) {
    const original=getContext(),q=id=>document.getElementById(id);
    const ctx={...original,characterId:0,characters:[{avatar:'lab-card.png',name:'实验角色甲'}],name2:'实验角色甲',chatId:'lab-chat-a',chat:[{mes:'测试消息',is_user:true}],
        extensionSettings:{...original.extensionSettings,[WORLD_KEY]:{enabled:true},[LAB_KEY]:{schema:1,packages:{},cards:{}}},
        chatMetadata:{},saveMetadata:async()=>{},saveSettingsDebounced(){}};
    const pkg=examplePackage();pkg.id='test.notes';pkg.permissions=['chat.read','input.write'];
    pkg.files['app.js']+=String.raw`
window.addEventListener('message',async event=>{
 if(event.source!==parent||!event.data?.labTest)return;
 try{
  const {action,value}=event.data;let result;
  if(action==='state'){document.querySelector('#note').value=value;document.querySelector('#save-note').click();return;}
  if(action==='settings'){result=await worldOS.setSettings(value);}
  if(action==='read'){let isolated=false;try{void parent.document.body;}catch{isolated=true;}result={context:await worldOS.getContext(),settings:await worldOS.getSettings(),state:await worldOS.getState(),isolated,noOverflow:document.documentElement.scrollWidth<=innerWidth};}
  if(action==='chat')result=await worldOS.getChat();
  if(action==='input')result=await worldOS.setInput(value);
  if(action==='network'){try{await fetch('https://example.invalid/blocked');result=false;}catch{result=true;}}
  await worldOS.notify('LABTEST:'+JSON.stringify({ok:true,result}));
 }catch(error){await worldOS.notify('LABTEST:'+JSON.stringify({ok:false,error:error.message}));}
});
worldOS.ready.then(()=>worldOS.notify('LABTEST:ready'));
`;
    const lab=()=>{if(!q('world-os').open)q('wo-launcher').click();q('wo-open-laboratory').click();};
    const row=()=>q('wo-lab-list').querySelector('.wo-lab-card');
    const icon=()=>document.querySelector('[data-wo-app="lab:test.notes"]');
    const upload=async value=>{
        lab();q('wo-lab-file').closest('details').open=true;
        const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(value)],'test.worldos.json',{type:'application/json'}));
        q('wo-lab-file').files=transfer.files;q('wo-lab-file').dispatchEvent(new Event('change',{bubbles:true}));
        await waitFor(()=>!q('wo-lab-install').disabled,'package preview');q('wo-lab-install').click();
        await waitFor(()=>q('wo-lab-install').disabled,'package installed');await delay(20);
    };
    const toggle=()=>{const input=row().querySelector('input');input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}));};
    const open=async()=>{
        q('wo-lab-status').textContent='';icon().click();
        await waitFor(()=>q('wo-lab-status').textContent==='LABTEST:ready','sandbox SDK ready');
    };
    async function call(action,value){
        q('wo-lab-status').textContent='';
        const frame=rootFrame();frame.contentWindow.postMessage({labTest:true,action,value},'*');
        await waitFor(()=>q('wo-lab-status').textContent.startsWith('LABTEST:'),'package command '+action);
        return JSON.parse(q('wo-lab-status').textContent.slice(8));
    }
    const rootFrame=()=>q('world-os').querySelector('iframe.wo-lab-frame');
    setContext(ctx);emit('CHAT_CHANGED');
    await check('实验室全局导入先预览，默认关闭，开启后动态添加原生图标并打开独立功能页',async()=>{
        lab();assert(q('wo-open-laboratory').querySelector('.fa-flask'),'lab native icon missing');
        await upload(pkg);assert(installedPackages(ctx).length===1,'package not persisted globally');assert(!icon(),'new package auto enabled');
        toggle();assert(icon(),'enabled app missing from home');q('wo-back').click();await open();
        assert(q('world-os').dataset.page==='lab:test.notes','app did not open its own page');
        const result=await call('read');assert(result.ok&&result.result.isolated,'sandbox could access parent DOM');
        assert(result.result.context.characterName==='实验角色甲','scoped context missing');assert(result.result.noOverflow,'iframe mobile overflow');
        assert(!rootFrame().sandbox.contains('allow-same-origin'),'same-origin privilege enabled');
        assert((await call('network')).result===true,'sandbox network was not blocked');
    });
    await check('功能包通过 SDK 保存角色卡配置和聊天笔记，输入仅前置且不发送',async()=>{
        await call('settings',{title:'跨聊天共用'});
        assert(cardPackage(ctx,'test.notes').settings.title==='跨聊天共用','card settings not saved');
        rootFrame().contentWindow.postMessage({labTest:true,action:'state',value:'本聊天笔记'},'*');
        await waitFor(()=>ctx.chatMetadata[LAB_KEY]?.states?.['test.notes']?.note==='本聊天笔记','demo button saves chat state');
        const input=q('send_textarea');input.value='已有输入';const before=JSON.stringify(ctx.chat);
        await call('input','插入内容\n');assert(input.value==='插入内容\n已有输入','input overwrite or wrong ordering');assert(JSON.stringify(ctx.chat)===before,'package sent a message');
        const result=await call('chat');assert(result.result[0].text==='测试消息','chat SDK failed');
    });
    await check('同卡跨聊天共用开关和配置，运行数据独立；其他角色可见已导入包但默认不启用',async()=>{
        const second={...ctx,chatId:'lab-chat-b',chatMetadata:{}};setContext(second);emit('CHAT_CHANGED');
        assert(!rootFrame(),'old frame survived chat switch');await open();
        let data=(await call('read')).result;assert(data.settings.title==='跨聊天共用'&&Object.keys(data.state).length===0,'settings/state scope mixed');
        const other={...ctx,characters:[{avatar:'lab-other.png',name:'实验角色乙'}],chatId:'other',chatMetadata:{}};setContext(other);emit('CHAT_CHANGED');lab();
        assert(installedPackages(other).length===1&&!icon(),'global install or per-card flag wrong');
        toggle();await open();data=(await call('read')).result;assert(data.settings.title==='我的笔记','settings leaked across cards');
        setContext(ctx);emit('CHAT_CHANGED');await open();data=(await call('read')).result;assert(data.state.note==='本聊天笔记','original chat state lost');
    });
    await check('返回、关闭和总开关都停止包运行，旧页面迟到消息不能修改设置或聊天',async()=>{
        const stale=rootFrame().contentWindow,before=JSON.stringify(ctx.extensionSettings[LAB_KEY]);
        q('wo-back').click();assert(!rootFrame(),'frame survived home navigation');
        stale.postMessage({labTest:true,action:'settings',value:{bad:true}},'*');await delay(60);
        assert(JSON.stringify(ctx.extensionSettings[LAB_KEY])===before,'stale frame wrote settings');
        await open();q('wo-window-close').click();assert(!rootFrame(),'frame survived dialog close');
        setContext({...ctx,chatId:'closed-switch',chatMetadata:{}});emit('CHAT_CHANGED');assert(!q('world-os').open,'chat switch opened closed window');
        setContext(ctx);emit('CHAT_CHANGED');lab();await open();
        ctx.extensionSettings[WORLD_KEY].enabled=false;announceWorldChange('master');assert(!rootFrame(),'master switch left frame running');
        ctx.extensionSettings[WORLD_KEY].enabled=true;announceWorldChange('master');q('wo-back').click();
    });
    await check('更新保留原配置；新增权限需重新启用，非法包不能覆盖旧包',async()=>{
        const update={...pkg,version:'1.0.1',description:'更新后的说明'};await upload(update);
        assert(cardPackage(ctx,'test.notes').enabled&&cardPackage(ctx,'test.notes').settings.title==='跨聊天共用','update lost preferences');
        await upload({...update,version:'1.0.2',permissions:[]});assert(cardPackage(ctx,'test.notes').enabled,'removing permission disabled package unnecessarily');
        await upload({...update,version:'1.1.0'});assert(!cardPackage(ctx,'test.notes').enabled&&!icon(),'new permission did not require enabling');
        const transfer=new DataTransfer();transfer.items.add(new File(['{"format":"bad"}'],'bad.json'));q('wo-lab-file').files=transfer.files;q('wo-lab-file').dispatchEvent(new Event('change',{bubbles:true}));
        await waitFor(()=>q('wo-lab-status').textContent.includes('不是受支持'),'invalid package error');
        assert(installedPackages(ctx)[0].version==='1.1.0','invalid import replaced installed package');toggle();
    });
    await check('快照包含功能包与分范围数据，恢复不自动运行脚本；手机导出示例走原生保存',async()=>{
        const snap=createSnapshot(ctx);assert(snap.settings[LAB_KEY].packages['test.notes'],'snapshot omitted package');
        await open();await restoreSnapshot(snap,ctx,{beforeRestore:()=>announceWorldChange('before-restore')});announceWorldChange('restore');
        assert(!rootFrame(),'restoring snapshot auto-executed package');assert(cardPackage(ctx,'test.notes').enabled,'snapshot lost enabled flag');
        lab();
        if(tauri){const count=globalThis.__nativeExports?.length??0;q('wo-lab-example').click();await waitFor(()=>(globalThis.__nativeExports?.length??0)>count,'native package export');assert(globalThis.__nativeExports.at(-1).data.format==='world-os-package','wrong export content');}
        const body=q('world-os').querySelector('.wo-window-body');assert(body.scrollWidth<=body.clientWidth+1,'lab panel overflow');
    });
    await check('全局卸载移除所有首页入口，保留数据；重新导入默认关闭且可恢复配置',async()=>{
        lab();let remove=[...row().querySelectorAll('button')].find(b=>b.textContent==='全局卸载');remove.click();await delay(20);remove.click();await delay(40);
        assert(installedPackages(ctx).length===0&&!icon(),'uninstall did not remove app');
        assert(ctx.chatMetadata[LAB_KEY].states['test.notes'].note==='本聊天笔记','uninstall deleted state');
        await upload(pkg);assert(!cardPackage(ctx,'test.notes').enabled,'reimport unexpectedly enabled app');assert(cardPackage(ctx,'test.notes').settings.title==='跨聊天共用','reimport lost config');
        toggle();
    });
    globalThis.__showLaboratoryFixture=()=>{setContext(ctx);emit('CHAT_CHANGED');lab();q('wo-lab-file').closest('details').open=true;};
    globalThis.__showLaboratoryAppFixture=()=>{setContext(ctx);emit('CHAT_CHANGED');lab();icon().click();};
    setContext(original);emit('CHAT_CHANGED');q('wo-back').click();
}
