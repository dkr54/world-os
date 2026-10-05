import { calendarOwner, calendarChat } from './calendar-core.js';
import { LAB_KEY, packageActive, cardPackage, configurePackage, packageState, savePackageState, labSettings } from './laboratory-core.js';

// Serialized into a sandboxed opaque-origin iframe; no host globals or credentials enter this scope.
export function packageBootstrap(pkg,token,theme) {
    const pending=new Map(),listeners=new Map();let sequence=0,readyResolve,readyReject;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const timeout=setTimeout(()=>readyReject(new Error('功能包连接超时，请重新打开。')),12000);
    function send(method,args={}){
        return ready.then(()=>new Promise((resolve,reject)=>{
            const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('功能包请求超时。'));},15000);
            pending.set(id,{resolve,reject,timer});parent.postMessage({type:'world-os-package',token,id,method,args},'*');
        }));
    }
    window.addEventListener('message',event=>{
        if(event.source!==parent||event.data?.type!=='world-os-host'||event.data.token!==token)return;
        const data=event.data;
        if(data.event==='connected'){clearTimeout(timeout);readyResolve();return;}
        if(data.event){for(const fn of listeners.get(data.event)??[])try{fn(data.value);}catch{}return;}
        const request=pending.get(data.id);if(!request)return;pending.delete(data.id);clearTimeout(request.timer);
        data.error?request.reject(new Error(data.error)):request.resolve(data.value);
    });
    const api=Object.freeze({
        ready,getContext:()=>send('context'),getSettings:()=>send('settings.get'),setSettings:value=>send('settings.set',{value}),
        getState:()=>send('state.get'),setState:value=>send('state.set',{value}),getChat:(limit=20)=>send('chat.get',{limit}),
        setInput:(text,mode='prepend')=>send('input.set',{text,mode}),notify:text=>send('notify',{text}),
        getFile:path=>Promise.resolve(pkg.files[path]??null),
        on(name,fn){if(typeof fn!=='function')throw new Error('事件回调需要函数');if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name)?.delete(fn);},
    });
    Object.defineProperty(window,'worldOS',{value:api,writable:false,configurable:false});
    const style=document.createElement('style');
    style.textContent=':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:12px;background:'+theme.background+';color:'+theme.color+';font:15px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}input,textarea,select,button{font:inherit;color:inherit;max-width:100%;border:1px solid #66717b;border-radius:7px;padding:10px;background:rgba(128,128,128,.12)}input,textarea,select{display:block;width:100%;margin:6px 0 12px}button{cursor:pointer;min-height:44px;margin:4px 6px 10px 0}label{display:block}pre{white-space:pre-wrap}';
    document.head.append(style);
    const resolve=(path,base=pkg.entry)=>{
        if(/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(path))throw new Error('资源需要包内相对路径：'+path);
        const parts=base.split('/');parts.pop();
        for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw new Error('资源路径越界');parts.pop();}else parts.push(part);}
        const name=parts.join('/');if(!Object.hasOwn(pkg.files,name))throw new Error('找不到包内资源：'+name);return name;
    };
    const css=(text,base)=>text.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,(_all,_quote,path)=>{
        try{if(path.startsWith('data:image/'))return 'url("'+path+'")';const value=pkg.files[resolve(path,base)];return value.startsWith('data:image/')?'url("'+value+'")':'url("")';}catch{return 'url("")';}
    });
    try{
        const template=document.createElement('template');template.innerHTML=pkg.files[pkg.entry];
        for(const node of template.content.querySelectorAll('meta,base,iframe,object,embed'))node.remove();
        for(const node of template.content.querySelectorAll('link')){
            if(node.rel==='stylesheet'){const path=resolve(node.getAttribute('href')??'');const replacement=document.createElement('style');replacement.textContent=css(pkg.files[path],path);node.replaceWith(replacement);}
            else node.remove();
        }
        for(const node of template.content.querySelectorAll('style'))node.textContent=css(node.textContent,pkg.entry);
        for(const node of template.content.querySelectorAll('[style]'))node.setAttribute('style',css(node.getAttribute('style'),pkg.entry));
        for(const node of template.content.querySelectorAll('img')){
            const source=node.getAttribute('src')??'';node.removeAttribute('srcset');
            if(!source.startsWith('data:image/')){try{const value=pkg.files[resolve(source)];if(!value.startsWith('data:image/'))throw new Error();node.src=value;}catch{node.removeAttribute('src');}}
        }
        const scripts=[];
        for(const node of template.content.querySelectorAll('script')){
            if(node.type&&node.type!=='text/javascript'&&node.type!=='application/javascript')throw new Error('请将脚本打包为普通 JavaScript，不使用 module 或远程依赖。');
            scripts.push(node.hasAttribute('src')?pkg.files[resolve(node.getAttribute('src'))]:node.textContent);node.remove();
        }
        document.body.append(template.content);
        for(const source of scripts){const node=document.createElement('script');node.textContent=source;document.body.append(node);}
    }catch(error){document.body.replaceChildren();const p=document.createElement('p');p.textContent=error.message;document.body.append(p);ready.then(()=>api.notify(error.message)).catch(()=>{});}
    document.addEventListener('submit',event=>event.preventDefault(),true);
    document.addEventListener('click',event=>{const a=event.target.closest?.('a');if(a&&!(a.getAttribute('href')??'').startsWith('#'))event.preventDefault();},true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();send('close').catch(()=>{});}});
    parent.postMessage({type:'world-os-package',token,event:'ready'},'*');
}
export function sandboxDocument(pkg,token,theme={background:'#20262c',color:'#edf4f1'}) {
    const encode=value=>JSON.stringify(value).replace(/</g,'\\u003c');
    const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+policy+'"></head><body><script>('+packageBootstrap.toString()+')('+encode(pkg)+','+encode(token)+','+encode(theme)+');<\/script></body></html>';
}
export class LaboratoryRuntime {
    constructor({getContext,onStatus=()=>{},onBack=()=>{},onSettings=()=>{},isOpen=()=>true}){
        this.getContext=getContext;this.onStatus=onStatus;this.onBack=onBack;this.onSettings=onSettings;this.isOpen=isOpen;this.current=null;this.queue=Promise.resolve();
        this.listener=event=>this.receive(event);globalThis.addEventListener('message',this.listener);
    }
    stop(){const run=this.current;this.current=null;if(run){clearTimeout(run.timer);run.frame.remove();}}
    valid(run){const ctx=this.getContext();return this.current===run&&(this.isOpen?.(run.pkg.id)??true)&&calendarOwner(ctx)===run.owner&&calendarChat(ctx)===run.scope&&ctx.chatMetadata===run.metadata
        &&packageActive(ctx,run.pkg.id)&&labSettings(ctx).packages[run.pkg.id]===run.pkg;}
    open(pkg,container){
        this.stop();const ctx=this.getContext();if(!packageActive(ctx,pkg.id))throw new Error('请启用 world os，并在当前角色卡启用此功能包。');
        const frame=document.createElement('iframe');frame.className='wo-lab-frame';frame.title=pkg.name;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');
        const token=crypto.randomUUID(),style=getComputedStyle(container),run={frame,pkg,token,owner:calendarOwner(ctx),scope:calendarChat(ctx),metadata:ctx.chatMetadata,connected:false,loads:0,count:0,since:Date.now()};
        this.current=run;this.queue=Promise.resolve();
        run.timer=setTimeout(()=>{if(this.current===run&&!run.connected){this.stop();this.onStatus('功能包启动超时，请重新打开或检查包内脚本。');}},15000);
        frame.addEventListener('load',()=>{if(++run.loads>1&&this.current===run){this.stop();this.onStatus('功能包离开了本地页面，已停止运行。');}});
        frame.srcdoc=sandboxDocument(pkg,token,{color:style.color||'#edf4f1',background:'#20262c'});
        container.replaceChildren(frame);return run;
    }
    post(run,data){if(this.valid(run))run.frame.contentWindow.postMessage({type:'world-os-host',token:run.token,...data},'*');}
    receive(event){
        const run=this.current,data=event.data;
        if(!run||event.source!==run.frame.contentWindow||data?.type!=='world-os-package'||data.token!==run.token||!this.valid(run))return;
        if(data.event==='ready'){run.connected=true;clearTimeout(run.timer);this.post(run,{event:'connected'});return;}
        if(!Number.isSafeInteger(data.id)||data.id<1||typeof data.method!=='string')return;
        if(Date.now()-run.since>10000){run.count=0;run.since=Date.now();}
        if(++run.count>200){this.post(run,{id:data.id,error:'功能包请求过于频繁，请稍后重试。'});return;}
        try{if(JSON.stringify(data).length>300000)throw new Error();}catch{this.post(run,{id:data.id,error:'功能包请求过大或格式无效。'});return;}
        this.queue=this.queue.then(async()=>{
            if(!this.valid(run))return;
            try{const value=await this.request(run,data.method,data.args??{});this.post(run,{id:data.id,value});}
            catch(error){this.post(run,{id:data.id,error:error.message});}
        });
    }
    async request(run,method,args){
        if(!this.valid(run))throw new Error('功能包已停止或上下文已切换。');
        const ctx=this.getContext(),id=run.pkg.id;
        const permit=name=>{if(!run.pkg.permissions.includes(name))throw new Error('功能包未声明权限：'+name);};
        switch(method){
            case 'context': return {packageId:id,version:run.pkg.version,owner:run.owner,chatId:ctx.chatId??ctx.getCurrentChatId?.()??'',characterName:ctx.characters?.[ctx.characterId]?.name||ctx.name2||'群聊'};
            case 'settings.get': return cardPackage(ctx,id).settings;
            case 'settings.set': {const value=configurePackage(ctx,id,{settings:args.value}).settings;this.onSettings(id);return value;}
            case 'state.get': return packageState(ctx,id);
            case 'state.set': return savePackageState(ctx,id,args.value,{getContext:this.getContext,valid:()=>this.valid(run)});
            case 'chat.get': {
                permit('chat.read');const limit=args.limit??20;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('查询消息数量需要 1～100。');
                const messages=ctx.chat.filter(m=>!m.is_system&&m.role!=='tool'&&!m.tool_calls?.length&&!m.extra?.tool_invocations?.length&&typeof m.mes==='string').slice(-limit);
                let remaining=200000;return messages.map(m=>{const text=m.mes.slice(0,remaining);remaining-=text.length;return {role:m.is_user?'user':'assistant',name:String(m.name??''),text};});
            }
            case 'input.set': {
                permit('input.write');if(typeof args.text!=='string'||args.text.length>20000||!['prepend','append'].includes(args.mode))throw new Error('输入只支持 prepend/append，文本最多 20000 字。');
                const input=document.querySelector('#send_textarea');if(!input)throw new Error('找不到聊天输入框。');
                input.value=args.mode==='append'?input.value+args.text:args.text+input.value;input.dispatchEvent(new Event('input',{bubbles:true}));return true;
            }
            case 'notify': if(typeof args.text!=='string'||args.text.length>1000)throw new Error('通知文本无效。');this.onStatus(args.text);return true;
            case 'close': this.onBack();return true;
            default: throw new Error('不支持的功能包接口。');
        }
    }
    chatChanged(index){
        const run=this.current;if(!run||!this.valid(run)||!run.pkg.permissions.includes('chat.read'))return;
        this.post(run,{event:'chat.changed',value:{index:Number.isInteger(index)?index:null}});
    }
    destroy(){this.stop();globalThis.removeEventListener('message',this.listener);}
}
