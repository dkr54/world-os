import { calendarOwner, calendarChat } from './calendar-core.js';
import { LAB_KEY, labSettings, installedPackages, cardPackage, installPackage, configurePackage, uninstallPackage } from './laboratory-core.js';
import { readPackageFile, examplePackage } from './laboratory-package.js';
import { LaboratoryRuntime } from './laboratory-runtime.js';
import { downloadMemory } from './host-runtime.js';
import { WORLD_EVENT, worldEnabled } from './world-state.js';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const button=(text,fn)=>{const node=el('button','menu_button',text);node.type='button';node.addEventListener('click',fn);return node;};
export function mountLaboratory(root,{getContext,shell}) {
    const page=root.querySelector('#wo-laboratory'),find=name=>page.querySelector('#wo-lab-'+name),apps=new Map();
    let pending=null,editing=null,busy=false,active='',owner=calendarOwner(getContext()),scope=calendarChat(getContext()),metadata=getContext().chatMetadata;
    const say=text=>{find('status').textContent=text;const view=apps.get(active);if(view)view.status.textContent=text;};
    const runtime=new LaboratoryRuntime({getContext,onStatus:say,onBack:()=>shell.openApp('home'),isOpen:id=>root.open&&root.dataset.page==='lab:'+id});
    async function action(fn){if(busy)return;busy=true;try{await fn();}catch(error){say(error.message);}finally{busy=false;}}
    function stop(){runtime.stop();active='';}
    function syncApps(){
        const ctx=getContext(),enabled=installedPackages(ctx).filter(pkg=>cardPackage(ctx,pkg.id).enabled),ids=new Set(enabled.map(pkg=>pkg.id));
        for(const [id,app]of apps)if(!ids.has(id)){if(active===id)stop();shell.unregisterApp('lab:'+id);apps.delete(id);app.button.remove();app.page.remove();}
        for(const pkg of enabled){
            let app=apps.get(pkg.id);
            if(!app){
                const appPage=el('section','wo-lab-app');appPage.hidden=true;appPage.id='wo-lab-app-'+pkg.id;appPage.dataset.woTitle=pkg.name;
                const status=el('p','fm-status'),frame=el('div','wo-lab-frame-host');
                const reload=button('重新载入页面',()=>open(pkg.id));
                appPage.append(reload,status,frame);root.querySelector('.wo-window-body').append(appPage);
                const iconButton=el('button','wo-app');iconButton.type='button';iconButton.setAttribute('aria-controls',appPage.id);
                const icon=el('span','wo-app-icon wo-lab-package-icon'),glyph=el('i','fa-solid '+pkg.icon);glyph.setAttribute('aria-hidden','true');icon.append(glyph);
                const label=el('span','wo-app-label',pkg.name);iconButton.append(icon,label);root.querySelector('#wo-lab-home-apps').append(iconButton);
                shell.registerApp('lab:'+pkg.id,{button:iconButton,page:appPage});
                app={page:appPage,button:iconButton,status,frame,label,glyph};apps.set(pkg.id,app);
            }
            app.page.dataset.woTitle=pkg.name;app.label.textContent=pkg.name;app.glyph.className='fa-solid '+pkg.icon;
        }
        root.querySelector('#wo-lab-home-section').hidden=!enabled.length;
    }
    function open(id){
        stop();const pkg=labSettings(getContext()).packages?.[id],view=apps.get(id);if(!pkg||!view)return;
        active=id;view.status.textContent='';
        try{runtime.open(pkg,view.frame);}catch(error){say(error.message);}
    }
    function edit(pkg){
        editing={id:pkg.id,owner:calendarOwner(getContext())};if(!editing.owner){say('请先打开角色卡。');return;}
        find('settings-title').textContent=pkg.name+' · 当前角色卡配置';
        find('settings-json').value=JSON.stringify(cardPackage(getContext(),pkg.id).settings,null,2);
        find('settings-editor').hidden=false;find('settings-editor').scrollIntoView({block:'nearest'});
    }
    function render(){
        const ctx=getContext(),owner=calendarOwner(ctx),packages=installedPackages(ctx),list=find('list');list.replaceChildren();
        find('scope').textContent=owner?'当前角色卡：'+(ctx.characters?.[ctx.characterId]?.name||ctx.name2||'群聊')+'。开关与配置由该卡的所有聊天共享。':'尚未打开角色卡；仍可全局导入、导出和卸载功能包。';
        find('count').textContent='已导入 '+packages.length+' 个功能包 · '+packages.filter(pkg=>cardPackage(ctx,pkg.id).enabled).length+' 个在本卡启用';
        for(const pkg of packages){
            const row=el('article','wo-lab-card'),header=el('div','wo-lab-card-header'),icon=el('i','fa-solid '+pkg.icon),title=el('strong','',pkg.name);
            header.append(icon,title);row.append(header,el('p','fm-hint',pkg.id+' · '+pkg.version+(pkg.author?' · '+pkg.author:'')),el('p','',pkg.description||'未填写说明'));
            const label=el('label','checkbox_label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=cardPackage(ctx,pkg.id).enabled;toggle.disabled=!owner;
            label.append(toggle,document.createTextNode('在当前角色卡启用'));row.append(label);
            toggle.addEventListener('change',()=>void action(()=>{stop();configurePackage(getContext(),pkg.id,{enabled:toggle.checked});syncApps();render();say(toggle.checked?'已在本卡启用。':'已在本卡关闭，配置和聊天数据仍保留。');}));
            row.append(el('p','fm-hint','权限：'+(pkg.permissions.map(p=>p==='chat.read'?'读取最近聊天':'向输入框添加文字').join('、')||'仅自身设置与状态')));
            const actions=el('div','fm-actions');
            const openButton=button('打开',()=>shell.openApp('lab:'+pkg.id));openButton.disabled=!cardPackage(ctx,pkg.id).enabled;
            const settingsButton=button('本卡配置',()=>edit(pkg));settingsButton.disabled=!owner;
            const exportButton=button('导出包',()=>void action(async()=>{const result=await downloadMemory(pkg,pkg.id+'-'+pkg.version+'.worldos.json');say('功能包已导出。'+(result?.savedPath||''));}));
            let armed=false;
            const removeButton=button('全局卸载',()=>void action(()=>{
                if(!armed){armed=true;removeButton.textContent='再次点击确认卸载';say('卸载会移除所有角色卡的入口，保留各卡配置与聊天数据，重新导入后可继续使用。');return;}
                stop();uninstallPackage(getContext(),pkg.id);if(editing?.id===pkg.id){editing=null;find('settings-editor').hidden=true;}syncApps();render();say('已全局卸载；没有删除原有数据。');
            }));
            actions.append(openButton,settingsButton,exportButton,removeButton);row.append(actions);list.append(row);
        }
        if(!packages.length)list.append(el('p','wo-ch-empty','还没有功能包。可以先下载“示例笔记”，再导入体验。'));
    }
    find('file').addEventListener('change',()=>void action(async()=>{
        pending=null;find('install').disabled=true;find('preview').textContent='';
        const file=find('file').files[0];if(!file)return;
        pending=await readPackageFile(file);const previous=labSettings(getContext()).packages?.[pending.id];
        const added=previous&&pending.permissions.filter(p=>!previous.permissions.includes(p));
        find('preview').textContent=pending.name+' · '+pending.version+'\nID：'+pending.id+'\n'+pending.description
            +'\n权限：'+(pending.permissions.join(', ')||'仅自身设置与状态')
            +'\n'+(previous?'将更新已安装的同 ID 功能包；各角色卡的数据保留。':'将全局导入；各角色卡默认关闭。')
            +(added?.length?'\n本次新增权限，更新后所有角色卡需重新启用。':'');
        find('install').textContent=previous?'确认更新功能包':'确认全局导入';find('install').disabled=false;say('已读取功能包。检查说明后确认导入。');
    }));
    find('install').addEventListener('click',()=>void action(()=>{
        if(!pending)return;stop();const pkg=installPackage(getContext(),pending);pending=null;find('install').disabled=true;find('file').value='';find('preview').textContent='';
        syncApps();render();say(pkg.name+' 已全局导入。可在每张角色卡下单独启用。');
    }));
    find('example').addEventListener('click',()=>void action(async()=>{
        const result=await downloadMemory(examplePackage(),'demo.notes-1.0.0.worldos.json');say('示例功能包已下载。'+(result?.savedPath||''));
    }));
    find('settings-form').addEventListener('submit',event=>{event.preventDefault();void action(()=>{
        if(!editing||calendarOwner(getContext())!==editing.owner)throw new Error('角色卡已切换，请重新打开该包配置。');
        let value;try{value=JSON.parse(find('settings-json').value);}catch{throw new Error('配置不是合法 JSON。');}
        configurePackage(getContext(),editing.id,{settings:value});say('本卡配置已保存，同一卡的其他聊天会共用。');
    });});
    find('settings-close').addEventListener('click',()=>{editing=null;find('settings-editor').hidden=true;});
    root.addEventListener('world-os:page',event=>{
        const name=event.detail.name;
        if(name.startsWith('lab:'))open(name.slice(4));else stop();
        if(name==='laboratory')render();
    });
    root.addEventListener('beforetoggle',event=>{if(event.newState==='closed')stop();});
    root.addEventListener('close',()=>{if(!root.open)stop();});
    root.addEventListener('cancel',stop);
    root.querySelector('#wo-window-close').addEventListener('click',stop,true);
    new MutationObserver(()=>{if(!root.open)stop();}).observe(root,{attributes:true,attributeFilter:['open']});
    function changed(){
        const ctx=getContext(),nextOwner=calendarOwner(ctx),nextScope=calendarChat(ctx);
        if(owner!==nextOwner||scope!==nextScope||metadata!==ctx.chatMetadata){
            stop();if(editing&&owner!==nextOwner){editing=null;find('settings-editor').hidden=true;}
            owner=nextOwner;scope=nextScope;metadata=ctx.chatMetadata;
            if(root.dataset.page?.startsWith('lab:'))shell.showApp('home');
        }
        syncApps();render();
    }
    const ctx=getContext();
    for(const name of ['CHAT_CHANGED','CHAT_LOADED','CHARACTER_SELECTED'])if(ctx.eventTypes[name])ctx.eventSource.on(ctx.eventTypes[name],changed);
    for(const name of ['MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_DELETED','CHARACTER_MESSAGE_RENDERED'])if(ctx.eventTypes[name])ctx.eventSource.on(ctx.eventTypes[name],index=>runtime.chatChanged(index));
    document.addEventListener(WORLD_EVENT,event=>{
        stop();
        if(event.detail?.kind==='before-restore')return;
        changed();
        if(event.detail?.kind==='restore'){editing=null;find('settings-editor').hidden=true;if(root.dataset.page?.startsWith('lab:'))shell.showApp('home');}
        if(root.open&&root.dataset.page?.startsWith('lab:')&&worldEnabled(getContext()))open(root.dataset.page.slice(4));
    });
    syncApps();render();return {runtime,refresh:changed};
}
