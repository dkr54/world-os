import { CHARACTERS_KEY } from '../characters-core.js';
import { createSnapshot,validateSnapshot } from '../snapshots.js';
import { WORLD_KEY,announceWorldChange } from '../world-state.js';

export async function runCGChecks({check,assert,waitFor,delay,emit,getContext,setContext,macros,mainId}) {
    const q=id=>document.getElementById(id), ctx=getContext(), owner='character:directory-guide.png';
    const list=()=>ctx.extensionSettings[CHARACTERS_KEY].cards[owner];
    const person=()=>list().find(item=>item.id===mainId);
    const submit=async()=>{q('wo-ch-definition-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await delay(70);};
    const openMain=()=>{
        q('wo-open-characters').click();document.querySelector('[data-ch-tab="list"]').click();
        q('wo-ch-search').value=String(person().cgId);q('wo-ch-search').dispatchEvent(new Event('input'));
        q('wo-ch-list').querySelector('.wo-ch-contact').click();
    };
    const choose=async(row,name,color)=>{
        const canvas=document.createElement('canvas');canvas.width=240;canvas.height=140;
        const paint=canvas.getContext('2d');paint.fillStyle=color;paint.fillRect(0,0,240,140);
        paint.fillStyle='#ffffff';paint.font='28px sans-serif';paint.fillText(name,30,80);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const transfer=new DataTransfer();transfer.items.add(new File([blob],name+'.png',{type:'image/png'}));
        const input=row.querySelector('[data-cg-file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
        await waitFor(()=>row.cgValue.src.startsWith('data:image/'),'CG file upload');
    };
    let source,tokenInput;
    await check('角色 CG 从手机文件选择、保存并随快照保留，数字 ID 稳定，预设只列出命中角色',async()=>{
        assert(person().cgId===0,'first character ID not 0');
        openMain();assert(q('wo-ch-id').readOnly&&q('wo-ch-id').value==='0','numeric ID not visible and stable');
        q('wo-ch-cg-section').open=true;
        q('wo-ch-cg-add').click();await choose(q('wo-ch-cgs').lastElementChild,'晨光','#385f73');
        q('wo-ch-cg-add').click();await choose(q('wo-ch-cgs').lastElementChild,'重逢','#79624e');
        q('wo-ch-description').value+=' 可用图片 {{0.晨光}}。';
        await submit();assert(person().cgs.length===2,q('wo-ch-status').textContent);source=person().cgs[0].src;
        assert(person().cgId===0,'save changed numeric ID');
        ctx.chat=[{mes:'我遇见示例角色甲',is_user:true}];
        const cg=macros.get('CG')();
        assert(cg==='<0_示例角色甲>\n{{0.晨光}}\n{{0.重逢}}\n</0_示例角色甲>','CG listing mismatch');
        assert(!cg.includes('data:image')&&!cg.includes('苏岚'),'CG leaked sources or uncalled characters');
        assert(macros.get('character')().includes('{{0.晨光}}'),'state macro expansion ate image macro');
        const snap=validateSnapshot(createSnapshot(ctx));
        assert(snap.settings[CHARACTERS_KEY].cards[owner].find(p=>p.id===mainId).cgs[0].src===source,'snapshot lost image');
        q('wo-ch-cg-section').open=true;
        const body=q('world-os').querySelector('.wo-window-body');
        assert(body.scrollWidth<=body.clientWidth+1,'mobile CG form overflow');
    });
    await check('设定预览 Token 使用实际阶段和状态，切换角色后不显示上一次异步结果',async()=>{
        ctx.getTokenCountAsync=async(text,padding)=>{tokenInput=text;assert(padding===0,'token padding wrong');return 73;};
        q('wo-ch-preview-section').open=true;q('wo-ch-tokens-refresh').click();
        await waitFor(()=>q('wo-ch-tokens').textContent.includes('73'),'token count display');
        assert(tokenInput.includes('<示例角色甲>')&&tokenInput.includes('年龄 21')&&tokenInput.includes('信赖你'),'token text missed current state/stage');
        assert(!tokenInput.includes('{{age}}')&&!tokenInput.includes('"relationship"'),'token text not assembled');
        let resolve;
        ctx.getTokenCountAsync=()=>new Promise(r=>{resolve=r;});q('wo-ch-tokens-refresh').click();
        q('wo-ch-list-back').click();q('wo-ch-add').click();resolve(999);await delay(30);
        assert(!q('wo-ch-tokens').textContent.includes('999'),'old count leaked into another character');
        ctx.getTokenCountAsync=async()=>73;openMain();
    });
    await check('同名角色可以保存并获得不同数字 ID，CG 宏按 ID 准确区分',async()=>{
        q('wo-ch-list-back').click();q('wo-ch-add').click();q('wo-ch-name').value='示例角色甲';q('wo-ch-keywords').value='第二位';
        q('wo-ch-description').value='同名角色';q('wo-ch-cg-add').click();await choose(q('wo-ch-cgs').lastElementChild,'晨光','#5d7456');
        await submit();const duplicate=list().find(p=>p.id!==mainId&&p.name==='示例角色甲');
        assert(duplicate?.cgId===2,q('wo-ch-status').textContent);
        ctx.chat=[{mes:'示例角色甲 第二位',is_user:true}];const manifest=macros.get('CG')();
        assert(manifest.includes('{{0.晨光}}')&&manifest.includes('{{2.晨光}}'),'duplicate names confused manifest');
        // Keep the directory fixture easy to scan in subsequent screenshots.
        q('wo-ch-name').value='筱禾';await submit();openMain();
    });
    let chat=document.getElementById('chat');
    if(!chat){chat=document.createElement('div');chat.id='chat';document.querySelector('main').append(chat);}
    const outside=document.createElement('div');outside.id='cg-outside';outside.textContent='{{0.晨光}}';document.body.append(outside);
    function block(index,text) {
        const row=document.createElement('div');row.className='mes';row.setAttribute('mesid',String(index));
        const box=document.createElement('div');box.className='mes_text';box.textContent=text;row.append(box);return row;
    }
    const boxes=()=>[...chat.querySelectorAll('.mes_text')],images=()=>chat.querySelectorAll('.wo-cg-image');
    const setLimit=async n=>{
        document.querySelector('[data-ch-tab="list"]').click();
        q('wo-ch-cg-floors').value=n;q('wo-ch-cg-floors').dispatchEvent(new Event('change',{bubbles:true}));await delay(80);
    };
    await check('只有最近 N 条用户或 AI 消息渲染 CG；范围外、输入框与原始消息保留宏',async()=>{
        ctx.chat=[{mes:'旧 {{0.晨光}}',is_user:true},{mes:'旧回复 {{0.晨光}}'},{mes:'新 {{0.晨光}}',is_user:true},{mes:'新回复 {{0.晨光}}'}];
        const before=JSON.stringify(ctx.chat);chat.replaceChildren(...ctx.chat.map((m,i)=>block(i,m.mes)));emit('CHAT_LOADED');
        await setLimit(2);
        await waitFor(()=>images().length===2,'N=2 rendering');
        assert(!boxes()[0].querySelector('img')&&!boxes()[1].querySelector('img'),'old images were retained');
        assert(boxes()[0].textContent.includes('{{0.晨光}}'),'old macro disappeared');
        assert(images()[0].src===source,'wrong CG source');
        assert(JSON.stringify(ctx.chat)===before,'renderer changed raw messages');
        assert(outside.textContent==='{{0.晨光}}'&&!outside.querySelector('img'),'CG rendered outside chat');
        assert(ctx.extensionSettings[CHARACTERS_KEY].cgRenderCount===2,'N did not persist');
        const snapshot=validateSnapshot(createSnapshot(ctx));assert(snapshot.settings[CHARACTERS_KEY].cgRenderCount===2,'N missing from snapshot');
    });
    await check('新楼层出现后移除过期图片，流式宏只在完整时渲染，编辑与重绘不改原文',async()=>{
        ctx.chat.push({mes:'后续 {{0.重',is_user:false});const row=block(4,ctx.chat[4].mes);chat.append(row);
        await waitFor(()=>!boxes()[2].querySelector('img'),'expired CG removed');
        assert(!boxes()[4].querySelector('img'),'partial macro rendered');
        ctx.chat[4].mes='后续 {{0.重逢}}';boxes()[4].firstChild.nodeValue=ctx.chat[4].mes;
        await waitFor(()=>boxes()[4].querySelector('img'),'streamed complete macro');
        const textarea=document.createElement('textarea');textarea.id='curEditTextarea';textarea.value=ctx.chat[4].mes;
        boxes()[4].replaceChildren(textarea);await delay(60);
        assert(textarea.value==='后续 {{0.重逢}}'&&!boxes()[4].querySelector('img'),'editor was transformed');
        boxes()[4].textContent=ctx.chat[4].mes;emit('MESSAGE_UPDATED',4);
        await waitFor(()=>boxes()[4].querySelector('img'),'edit completion rerender');
        assert(ctx.chat[4].mes==='后续 {{0.重逢}}','saved message lost macro');
        // Simulate a mobile virtualized chat reusing and replacing DOM elements.
        boxes()[3].closest('.mes').replaceWith(block(0,ctx.chat[0].mes));
        await delay(60);assert(!boxes()[3].querySelector('img'),'old recycled floor rendered outside range');
    });
    await check('宿主 Markdown 拆分的图片宏仍可渲染，不跨段落拼接，多个同段图片不丢字',async()=>{
        const box=boxes()[4];box.replaceChildren();
        const p=document.createElement('p'),em=document.createElement('em');
        p.append(document.createTextNode('前 {{0.'));em.textContent='晨光';p.append(em,document.createTextNode('}} 中 {{0.重逢}} 后'));box.append(p);
        await waitFor(()=>box.querySelectorAll('img').length===2,'inline split CG macros');
        assert(box.textContent==='前  中  后','CG render lost adjacent text');
        const left=document.createElement('p'),right=document.createElement('p');
        left.textContent='{{0.';right.textContent='晨光}}';box.replaceChildren(left,right);await delay(70);
        assert(!box.querySelector('img'),'renderer merged unrelated paragraphs');
        box.textContent=ctx.chat[4].mes;emit('MESSAGE_UPDATED',4);await waitFor(()=>box.querySelector('img'),'restored ordinary macro');
    });
    await check('修改 N 或设为 0 立即更新；关闭总开关移除图片，恢复后重新渲染',async()=>{
        await setLimit(0);await waitFor(()=>images().length===0,'N=0 disables CG');
        assert(boxes()[4].textContent.includes('{{0.重逢}}'),'N=0 did not restore macro');
        await setLimit(5);await waitFor(()=>images().length===5,'increasing N restores eligible CG');
        ctx.extensionSettings[WORLD_KEY].enabled=false;announceWorldChange();
        await waitFor(()=>images().length===0,'master disables CG');assert(macros.get('CG')()==='','disabled CG manifest active');
        ctx.extensionSettings[WORLD_KEY].enabled=true;announceWorldChange();
        await waitFor(()=>images().length===5,'master re-enable CG');
    });
    await check('切换角色卡同编号不会沿用旧图；缺失 CG 与加载失败保持可读宏，不反复加载',async()=>{
        const different={...ctx,characters:[{avatar:'no-cg.png'}],chatId:'other',chatMetadata:{}};
        setContext(different);emit('CHAT_CHANGED');await waitFor(()=>images().length===0,'CG leaked into other card');
        setContext(ctx);emit('CHAT_CHANGED');await waitFor(()=>images().length===5,'original CG did not return');
        boxes()[4].textContent='{{999.未找到}} {{0.晨光}}';
        await waitFor(()=>boxes()[4].querySelector('img'),'known and unknown macros');
        assert(boxes()[4].textContent.includes('{{999.未找到}}'),'unknown macro vanished');
        const image=boxes()[4].querySelector('img');image.dispatchEvent(new Event('error'));
        await delay(100);assert(!boxes()[4].querySelector('img')&&boxes()[4].textContent.includes('{{0.晨光}}'),'broken image retried or lost macro');
        boxes()[4].append(document.createTextNode(' 新文字'));await delay(60);
        assert(!boxes()[4].querySelector('img'),'failed source endlessly retries');
    });
    await setLimit(2);
    chat.replaceChildren();outside.remove();ctx.chat=[{mes:'我和示例角色甲谈起苏岚。',is_user:true}];emit('CHAT_CHANGED');
    q('wo-ch-search').value='';q('wo-ch-search').dispatchEvent(new Event('input'));
    globalThis.__showCGFixture=()=>{
        setContext(ctx);emit('CHAT_CHANGED');if(!q('world-os').open)q('wo-launcher').click();openMain();
        q('wo-ch-cg-section').open=true;q('wo-ch-cg-section').scrollIntoView({block:'start'});
    };
    globalThis.__showCGChatFixture=()=>{
        setContext(ctx);ctx.chat=[{mes:'旧日 {{0.晨光}}',is_user:true},{mes:'清晨 {{0.晨光}}'},{mes:'再次相遇 {{0.重逢}}'}];
        chat.replaceChildren(...ctx.chat.map((m,i)=>block(i,m.mes)));emit('CHAT_CHANGED');
        if(q('world-os').open)q('world-os').close();
        q('browser-test-result').hidden=true;chat.scrollIntoView({block:'start'});
    };
}
