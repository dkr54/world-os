/** CG assets stay in shared character settings. Only rendered chat DOM is changed. */
export const CG_PATTERN = /\{\{(0|[1-9]\d*)\.([^{}\r\n<>]{1,100})\}\}/g;
export const MAX_CG_SOURCE = 2000000;
export const DEFAULT_CG_FLOORS = 10;
export function validateCGFloors(value = DEFAULT_CG_FLOORS) {
    if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error('CG 显示楼数必须为 0～1000 的整数。');
    return value;
}
export function recentCGIndices(chat, count = DEFAULT_CG_FLOORS) {
    validateCGFloors(count);
    const indices = new Set();
    for (let index = (chat?.length ?? 0) - 1; index >= 0 && indices.size < count; index--) {
        const message = chat[index];
        if (message && !message.is_system && message.role !== 'tool' && !message.extra?.tool_invocations?.length
            && !message.tool_calls?.length && typeof message.mes === 'string' && message.mes.trim()) indices.add(index);
    }
    return indices;
}
export function isCGMacro(text) {
    return /^\{\{(0|[1-9]\d*)\.([^{}\r\n<>]{1,100})\}\}$/.test(text);
}
export function validateCGSource(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_CG_SOURCE) throw new Error('CG 图片地址为空或图片过大。');
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value)) return value;
    let url;
    try { url = new URL(value); } catch { throw new Error('CG 需要 HTTP(S) 图片地址或从手机上传的图片。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('CG 图片地址格式不受支持。');
    return value;
}
export function validateCGs(value = []) {
    if (!Array.isArray(value) || value.length > 200) throw new Error('每个角色最多设置 200 张 CG。');
    const seen = new Set();
    return value.map(item => {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()
            || item.name !== item.name.trim() || item.name.length > 100 || /[{}<>\u0000-\u001f\u007f]/.test(item.name)) {
            throw new Error('CG 名称需要 1～100 个字，不能含花括号、尖括号、控制字符或首尾空格。');
        }
        if (seen.has(item.name)) throw new Error('同一个角色的 CG 名称不能重复：' + item.name);
        seen.add(item.name);
        return { name:item.name,src:validateCGSource(item.src) };
    });
}
export function cgMacro(character, cg) { return '{{' + character.cgId + '.' + cg.name + '}}'; }
export function cgCharacterPrompt(character) {
    if (!Number.isSafeInteger(character.cgId) || character.cgId < 0 || !character.cgs?.length) return '';
    const tag = character.cgId + '_' + character.name;
    return '<' + tag + '>\n' + character.cgs.map(cg => cgMacro(character,cg)).join('\n') + '\n</' + tag + '>';
}
export function cgPrompt(characters) { return characters.map(cgCharacterPrompt).filter(Boolean).join('\n\n'); }
export function cgLookup(characters) {
    const lookup = new Map();
    for (const character of characters) for (const cg of character.cgs ?? []) {
        if (!Number.isSafeInteger(character.cgId) || character.cgId < 0) continue;
        try { lookup.set(cgMacro(character,cg),{ src:validateCGSource(cg.src),name:character.name,cg:cg.name }); } catch { /* Keep invalid assets as text. */ }
    }
    return lookup;
}
export async function readCGFile(file) {
    if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size > 12 * 1024 * 1024) {
        throw new Error('请选择不超过 12 MB 的 PNG/JPEG/WebP/GIF 图片。');
    }
    const source = await new Promise((resolve,reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('无法读取 CG 图片。')); reader.onabort = reader.onerror; reader.readAsDataURL(file);
    });
    // Preserve small originals, including animated GIF/WebP. Large still images get a mobile-friendly copy.
    if (source.length <= MAX_CG_SOURCE) return validateCGSource(source);
    if (file.type === 'image/gif') throw new Error('GIF 需小于约 1.4 MB 以保留动画；较大的动图可填写 HTTP(S) 图片地址。');
    const image = new Image(); image.src = source; await image.decode();
    let edge = 2048;
    for (let attempt = 0; attempt < 4; attempt++, edge = Math.round(edge * .75)) {
        const ratio = Math.min(1,edge / Math.max(image.width,image.height)), canvas = document.createElement('canvas');
        canvas.width = Math.max(1,Math.round(image.width*ratio)); canvas.height = Math.max(1,Math.round(image.height*ratio));
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        const result = canvas.toDataURL('image/webp',.86 - attempt*.08);
        if (result.length <= MAX_CG_SOURCE) return validateCGSource(result);
    }
    throw new Error('CG 图片仍然过大，请选择较小的图片或填写图片地址。');
}

export function mountCGRenderer({ getContext, getDirectory, getLimit = () => DEFAULT_CG_FLOORS, enabled, changeEvent }) {
    let chatRoot = null, frame = null, force = false, scope = '', lookup = new Map(), directory = null;
    const dirty = new Set(), owned = new WeakMap();
    let visible = new Set(), windowKey = '';
    const scopeOf = ctx => JSON.stringify([ctx.groupId ?? null,ctx.characterId,ctx.characters?.[ctx.characterId]?.avatar,ctx.chatId]);
    function restore(box) {
        for (const wrapper of box.querySelectorAll('.wo-cg-render')) {
            const info = owned.get(wrapper);
            if (info) wrapper.replaceWith(document.createTextNode(info.macro));
        }
    }
    function render(box, ctx, reset) {
        if (!box.isConnected || !chatRoot?.contains(box)) return;
        const message = box.closest('.mes'), index = Number(message?.getAttribute('mesid'));
        if (!message || !message.hasAttribute('mesid') || !Number.isInteger(index) || !ctx.chat?.[index] || ctx.chat[index].is_system) {
            restore(box); return;
        }
        if (box.querySelector('textarea,input,[contenteditable="true"]')) return;
        if (!enabled(ctx) || !visible.has(index)) { restore(box); return; }
        // Refresh owned nodes on card switches, changed settings, or recycled mobile message elements.
        for (const wrapper of box.querySelectorAll('.wo-cg-render')) {
            const info = owned.get(wrapper), asset = info && lookup.get(info.macro);
            if (info && (reset || info.index !== index || !asset || asset.src !== info.src)) {
                wrapper.replaceWith(document.createTextNode(info.macro));
            }
        }
        // Markdown may split a name like scene_soft_smile across inline emphasis nodes.
        // Join only contiguous inline text; never cross paragraph, editor or image boundaries.
        const runs = []; let run = null;
        const boundary = () => { run = null; };
        function gather(parent) {
            for (const node of parent.childNodes) {
                if (node.nodeType === 3) {
                    if (!run) { run = { text:'',nodes:[] }; runs.push(run); }
                    const start = run.text.length; run.text += node.nodeValue;
                    run.nodes.push({node,start,end:run.text.length}); continue;
                }
                if (node.nodeType !== 1) continue;
                if (node.matches('textarea,input,script,style,.wo-cg-render,[contenteditable="true"],img,svg')) { boundary(); continue; }
                const block = /^(P|DIV|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6]|TABLE|TD|TH|TR|BR|HR)$/.test(node.tagName);
                if (block) boundary();
                gather(node);
                if (block) boundary();
            }
        }
        gather(box);
        for (const run of runs) for (const match of [...run.text.matchAll(CG_PATTERN)].reverse()) {
            const asset = lookup.get(match[0]); if (!asset) continue;
            const begin = run.nodes.find(item => match.index >= item.start && match.index < item.end);
            const finish = run.nodes.find(item => match.index + match[0].length > item.start && match.index + match[0].length <= item.end);
            if (!begin || !finish) continue;
            const wrapper = document.createElement('span'), img = document.createElement('img');
            wrapper.className = 'wo-cg-render'; wrapper.title = match[0];
            owned.set(wrapper,{ macro:match[0],src:asset.src,index });
            img.className = 'wo-cg-image'; img.alt = asset.name + ' · ' + asset.cg;
            img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
            img.addEventListener('error',() => {
                // Leave a readable macro on failure. Do not repeatedly reload a broken image.
                wrapper.replaceChildren(document.createTextNode(match[0]));
                wrapper.classList.add('wo-cg-unavailable'); wrapper.title = 'CG 图片加载失败：' + match[0];
            },{once:true});
            img.src = asset.src; wrapper.append(img);
            const range = document.createRange();
            range.setStart(begin.node,match.index-begin.start);
            range.setEnd(finish.node,match.index+match[0].length-finish.start);
            range.deleteContents(); range.insertNode(wrapper);
        }
    }
    function collect(node) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element || element.closest('.wo-cg-render')) return;
        const box = element.closest('.mes_text');
        if (box) dirty.add(box);
        if (element.matches('.mes_text')) dirty.add(element);
        for (const child of element.querySelectorAll?.('.mes_text') ?? []) dirty.add(child);
    }
    const observer = new MutationObserver(records => {
        for (const record of records) {
            collect(record.target);
            for (const node of record.addedNodes) collect(node);
        }
        schedule();
    });
    function observe() {
        if (chatRoot) observer.observe(chatRoot,{ subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['mesid'] });
    }
    function attach() {
        const current = document.querySelector('#chat');
        if (current === chatRoot) return;
        observer.disconnect(); chatRoot = current; observe();
        if (chatRoot) collect(chatRoot);
    }
    function flush() {
        frame = null; attach();
        const ctx = getContext(), nextScope = scopeOf(ctx), nextDirectory = getDirectory(ctx);
        const nextVisible = recentCGIndices(ctx.chat,getLimit(ctx)), nextWindow = [...nextVisible].join(',');
        if (nextWindow !== windowKey) { windowKey = nextWindow; if (chatRoot) collect(chatRoot); }
        visible = nextVisible;
        const reset = force || scope !== nextScope || directory !== nextDirectory;
        if (reset) {
            scope = nextScope; directory = nextDirectory; lookup = cgLookup(directory);
            if (chatRoot) collect(chatRoot);
        }
        force = false;
        observer.disconnect();
        try { for (const box of dirty) render(box,ctx,reset); }
        finally { dirty.clear(); observe(); }
    }
    function schedule() { if (frame === null) frame = requestAnimationFrame(flush); }
    function refresh() { force = true; attach(); schedule(); }
    const ctx = getContext();
    for (const name of ['CHAT_CHANGED','CHAT_LOADED','CHARACTER_SELECTED','MESSAGE_UPDATED','MESSAGE_EDITED',
        'MESSAGE_SWIPED','MESSAGE_DELETED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED']) {
        if (ctx.eventTypes?.[name]) ctx.eventSource.on(ctx.eventTypes[name],() => {
            attach(); if (chatRoot) collect(chatRoot); schedule();
        });
    }
    if (changeEvent) document.addEventListener(changeEvent,refresh);
    refresh();
    return { refresh, dispose() { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); } };
}
