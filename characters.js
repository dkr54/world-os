import { calendarOwner, calendarChat } from './calendar-core.js';
import { CHARACTERS_KEY, cloneJSON, directoryOf, currentState, validateCharacter, validateDirectory, validateState,
    sortedCharacters, characterInitial, renderCharacter, stateFields, valueType, relationshipsOf, stateDifference, CONDITION_OPS } from './characters-core.js';
import { DEFAULT_STATE_API, DEFAULT_STATE_PROMPTS, validateStateAPI, requestStateUpdate } from './character-api.js';
import { CharacterEngine } from './characters-engine.js';
import { requestModels } from './embeddings.js';
import { worldEnabled, WORLD_EVENT } from './world-state.js';

const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const id = () => globalThis.crypto?.randomUUID?.() ?? 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
function button(text, action) { const node = el('button','menu_button',text); node.type = 'button'; node.addEventListener('click',action); return node; }
function field(parent, title, value = '', multiline = false) {
    const label = el('label','',title), input = el(multiline ? 'textarea' : 'input','text_pole');
    input.value = value; if (multiline) input.rows = 3; label.append(input); parent.append(label); return input;
}
function selectField(parent, title, options, value) {
    const label = el('label','',title), select = el('select','text_pole');
    for (const option of options) select.append(new Option(option,option)); select.value = value;
    label.append(select); parent.append(label); return select;
}
const jsonText = value => JSON.stringify(value,null,2);
function parseJSON(text, label) { try { return JSON.parse(text); } catch { throw new Error(label + '不是合法 JSON。'); } }
function avatar(container, character) {
    container.replaceChildren();
    if (!character?.avatar) { const icon = el('i','fa-solid fa-user'); icon.setAttribute('aria-hidden','true'); container.append(icon); return; }
    const img = el('img'); img.alt = character.name; img.src = character.avatar; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error',() => { container.replaceChildren(el('i','fa-solid fa-user')); },{ once:true }); container.append(img);
}
export function mountCharacters(root, { getContext }) {
    const page = root.querySelector('#wo-characters'), find = name => page.querySelector('#wo-ch-' + name);
    let selected = '', owner = calendarOwner(getContext()), view = 'list', definitionOwner = '', stateScope = '';
    let pickerJob = null, testJob = null, pickerTimer, busy = false;
    let sessionKey = '';
    try { sessionKey = sessionStorage.getItem('world_os_characters.apiKey') ?? ''; } catch {}
    const key = config => config.rememberKey ? config.apiKey : sessionKey;
    const config = () => validateStateAPI(getContext().extensionSettings?.[CHARACTERS_KEY]?.api ?? {});
    const say = (message, level = 'info') => { find('status').textContent = message; find('status').dataset.level = level; };
    const engine = new CharacterEngine({ getContext, getKey:key, onChange:error => {
        if (error) say(error,'error');
        renderDebug();
        if (view === 'relations') renderRelations();
        if (view === 'detail' && !engine?.job && document.activeElement !== find('current-state')) refreshState(false);
    } });
    async function action(fn) {
        if (busy) return;
        busy = true;
        try { await fn(); }
        catch (error) { say(error.name === 'AbortError' ? '操作已取消。' : error.message,'error'); }
        finally { busy = false; }
    }
    function setView(name) {
        view = name;
        for (const panel of page.querySelectorAll('[data-ch-view]')) panel.hidden = panel.dataset.chView !== name;
        for (const tab of page.querySelectorAll('[data-ch-tab]')) {
            if (tab.dataset.chTab === (name === 'detail' ? 'list' : name)) tab.setAttribute('aria-current','page');
            else tab.removeAttribute('aria-current');
        }
        if (name === 'list') renderList();
        if (name === 'relations') renderRelations();
        if (name === 'debug') renderDebug();
        root.querySelector('.wo-window-body').scrollTop = 0;
    }
    function renderList() {
        const list = find('list'); list.replaceChildren();
        const characters = sortedCharacters(directoryOf(getContext()));
        const search = find('search').value.trim().toLocaleLowerCase();
        const filtered = characters.filter(item => [item.name,...item.keywords].some(text => text.toLocaleLowerCase().includes(search)));
        find('count').textContent = characters.length + ' 个角色 · ' + (calendarOwner(getContext()) ? '当前角色卡共享' : '请先打开角色卡');
        find('add').disabled = !calendarOwner(getContext());
        let initial = '';
        for (const character of filtered) {
            const letter = characterInitial(character);
            if (letter !== initial) { initial = letter; list.append(el('p','wo-ch-letter',letter)); }
            const row = button('',() => openCharacter(character.id)); row.className = 'wo-ch-contact';
            const picture = el('span','wo-ch-avatar'); avatar(picture,character);
            const words = el('span','wo-ch-contact-text'); words.append(el('strong','',character.name),el('small','',character.keywords.join(',') || '未设置关键词'));
            row.append(picture,words,el('span','wo-ch-chevron','›')); list.append(row);
        }
        if (!filtered.length) list.append(el('p','wo-ch-empty',characters.length ? '没有找到匹配的角色。' : '还没有角色。点击“新建角色”，为这个世界添加一位人物。'));
    }
    function orderButtons(row) {
        const actions = el('div','fm-actions');
        actions.append(button('↑',() => { if (row.previousElementSibling) row.previousElementSibling.before(row); }),
            button('↓',() => { if (row.nextElementSibling) row.nextElementSibling.after(row); }),button('移除',() => row.remove()));
        return actions;
    }
    function addCondition(parent, value = { path:'affection',op:'>=',value:50 }) {
        const row = el('div','wo-ch-condition'); row.dataset.condition = '';
        const path = field(row,'状态字段',value.path); path.dataset.conditionPath = '';
        const op = selectField(row,'条件',CONDITION_OPS,value.op); op.dataset.conditionOp = '';
        const expected = field(row,'比较值（JSON，如 50 或 "朋友"）',jsonText(value.value ?? null)); expected.dataset.conditionValue = '';
        const toggle = () => { expected.parentElement.hidden = ['exists','missing'].includes(op.value); };
        op.addEventListener('change',toggle); toggle();
        row.append(button('移除条件',() => row.remove())); parent.append(row);
    }
    function addStage(value = { id:id(),name:'新阶段',content:'',conditions:[] }) {
        const row = el('div','fm-rule wo-ch-stage'); row.dataset.stageId = value.id;
        row.append(orderButtons(row));
        field(row,'阶段名',value.name).dataset.stageName = '';
        field(row,'阶段设定',value.content,true).dataset.stageContent = '';
        const conditions = el('div','wo-ch-conditions'); row.append(conditions);
        for (const condition of value.conditions) addCondition(conditions,condition);
        row.append(button('＋ 添加条件',() => addCondition(conditions)));
        find('stages').append(row);
    }
    function addPolicy(value = { path:'',type:'string',allow:['update'] }) {
        const row = el('div','fm-rule wo-ch-policy');
        field(row,'状态路径',value.path).dataset.policyPath = '';
        selectField(row,'值类型',['string','number','boolean','object','array','null'],value.type).dataset.policyType = '';
        const actions = el('div','wo-ch-permissions');
        for (const [op,title] of [['update','允许更新'],['add','允许新增'],['delete','允许删除']]) {
            const label = el('label','checkbox_label',title), input = el('input'); input.type = 'checkbox'; input.dataset.permission = op; input.checked = value.allow.includes(op); label.prepend(input); actions.append(label);
        }
        row.append(actions,button('移除此权限配置',() => row.remove())); find('policies').append(row);
    }
    function readDefinition() {
        const existing = directoryOf(getContext()).find(item => item.id === selected);
        const result = { id:selected || id(),name:find('name').value,sortName:find('sort').value,enabled:find('enabled').checked,
            avatar:find('avatar').value,keywords:find('keywords').value,description:find('description').value,
            baseState:parseJSON(find('base-state').value,'基础状态'), policies:[...find('policies').children].map(row => ({
                path:row.querySelector('[data-policy-path]').value, type:row.querySelector('[data-policy-type]').value,
                allow:[...row.querySelectorAll('[data-permission]:checked')].map(input => input.dataset.permission),
            })),stages:[...find('stages').children].map(row => ({
                id:row.dataset.stageId,name:row.querySelector('[data-stage-name]').value,content:row.querySelector('[data-stage-content]').value,
                conditions:[...row.querySelectorAll('[data-condition]')].map(condition => {
                    const op = condition.querySelector('[data-condition-op]').value;
                    return { path:condition.querySelector('[data-condition-path]').value,op,
                        value:['exists','missing'].includes(op) ? null : parseJSON(condition.querySelector('[data-condition-value]').value,'阶段比较值') };
                }),
            })) };
        return validateCharacter({ ...existing,...result });
    }
    function openCharacter(characterId = '') {
        if (!calendarOwner(getContext())) { say('请先打开角色卡。','warning'); return; }
        selected = characterId;
        const character = directoryOf(getContext()).find(item => item.id === selected) ?? {
            name:'',sortName:'',avatar:'',keywords:[],enabled:true,description:'',
            baseState:{ age:20,heigh:'165cm',affection:0,relationship:[] },stages:[],policies:[],
        };
        definitionOwner = calendarOwner(getContext());
        find('name').value = character.name; find('sort').value = character.sortName ?? '';
        find('avatar').value = character.avatar; find('avatar-file').value = '';
        find('enabled').checked = character.enabled !== false; find('keywords').value = character.keywords.join(',');
        find('description').value = character.description; find('base-state').value = jsonText(character.baseState);
        find('detail-name').textContent = character.name || '新角色'; avatar(find('avatar-preview'),character);
        find('stages').replaceChildren(); character.stages.forEach(addStage);
        find('policies').replaceChildren(); character.policies.forEach(addPolicy);
        find('delete').disabled = !selected;
        find('manual-requirements').value = '';
        for (const details of find('definition-form').querySelectorAll('details')) details.open = false;
        refreshState(true); setView('detail');
    }
    function refreshState(force = false) {
        const character = directoryOf(getContext()).find(item => item.id === selected);
        stateScope = calendarChat(getContext());
        const controls = [...find('state-form').querySelectorAll('input,textarea,button'),find('manual-update')];
        controls.forEach(control => { control.disabled = !character || !stateScope || Boolean(engine.job); });
        if (!character) { find('current-state').value = ''; find('stage-current').textContent = '先保存角色，再编辑聊天状态。'; find('preview').textContent = ''; return; }
        const state = currentState(getContext(),character);
        if (force || find('current-state').dataset.persisted === find('current-state').value || !find('current-state').dataset.persisted) {
            find('current-state').value = jsonText(state); find('current-state').dataset.persisted = find('current-state').value;
        }
        const preview = renderCharacter(character,state);
        find('stage-current').textContent = '当前阶段：' + preview.stage;
        find('preview').textContent = preview.content || '还没有角色设定。';
    }
    function saveDirectory(characters) {
        const ctx = getContext(), currentOwner = calendarOwner(ctx);
        if (!currentOwner || currentOwner !== definitionOwner) throw new Error('角色卡已切换，请重新打开详情。');
        const next = validateDirectory(characters), previous = ctx.extensionSettings[CHARACTERS_KEY] ?? {};
        engine.changed();
        ctx.extensionSettings[CHARACTERS_KEY] = { ...previous, schema:1,cards:{ ...previous.cards,[currentOwner]:next } };
        ctx.saveSettingsDebounced(); renderList();
    }
    async function saveCurrentState(value) {
        const ctx = getContext();
        if (!stateScope || stateScope !== calendarChat(ctx) || !directoryOf(ctx).some(item => item.id === selected)) throw new Error('聊天已变化，请重新打开角色。');
        engine.changed();
        const old = ctx.chatMetadata[CHARACTERS_KEY], next = { ...old,schema:1,states:{ ...old?.states,[selected]:validateState(value) } };
        ctx.chatMetadata[CHARACTERS_KEY] = next;
        try { await ctx.saveMetadata(); }
        catch (error) { if (ctx.chatMetadata[CHARACTERS_KEY] === next) ctx.chatMetadata[CHARACTERS_KEY] = old; throw error; }
        if (ctx.chatMetadata === getContext().chatMetadata) refreshState(true);
    }
    function renderRelations() {
        const characters = sortedCharacters(directoryOf(getContext())), states = Object.fromEntries(characters.map(item => [item.id,currentState(getContext(),item)]));
        const edges = relationshipsOf(characters,states), graph = find('graph'), list = find('relations');
        graph.replaceChildren(); list.replaceChildren();
        if (!characters.length) { graph.append(el('p','wo-ch-empty','添加角色及 relationship 状态后，这里会显示有向关系图。')); return; }
        const nodes = characters.map(item => ({ id:item.id,name:item.name }));
        for (const edge of edges) if (!edge.target && !nodes.some(item => item.id === 'external:' + edge.name)) nodes.push({ id:'external:' + edge.name,name:edge.name,external:true });
        const size = Math.max(320,graph.clientWidth || 520,nodes.length * 50), radius = size / 2 - 75;
        const positions = new Map(nodes.map((node,index) => {
            const angle = 2 * Math.PI * index / nodes.length - Math.PI / 2;
            return [node.id,{ x:size / 2 + radius * Math.cos(angle),y:size / 2 + radius * Math.sin(angle) }];
        }));
        const svgEl = (tag,attrs = {}) => { const node = document.createElementNS('http://www.w3.org/2000/svg',tag); for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value)); return node; };
        const svg = svgEl('svg',{ viewBox:'0 0 ' + size + ' ' + size,role:'img','aria-label':'角色有向关系图',width:size,height:size });
        const defs = svgEl('defs'), marker = svgEl('marker',{ id:'wo-ch-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse' });
        marker.append(svgEl('path',{ d:'M 0 0 L 10 5 L 0 10 z',fill:'currentColor' })); defs.append(marker); svg.append(defs);
        for (const edge of edges) {
            const start = positions.get(edge.source), end = positions.get(edge.target ?? 'external:' + edge.name);
            const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx,dy) || 1;
            const self = edge.source === edge.target;
            const d = self ? 'M ' + (start.x-20) + ' ' + (start.y-20) + ' c -65 -80 105 -80 45 0'
                : 'M ' + (start.x + dx*30/length) + ' ' + (start.y + dy*30/length) + ' Q ' + ((start.x+end.x)/2-dy*.08) + ' ' + ((start.y+end.y)/2+dx*.08) + ' ' + (end.x-dx*32/length) + ' ' + (end.y-dy*32/length);
            const path = svgEl('path',{ d,fill:'none',stroke:'currentColor','stroke-width':1.5,'marker-end':'url(#wo-ch-arrow)',opacity:.65 });
            const title = svgEl('title'); title.textContent = edge.description; path.append(title); svg.append(path);
            const row = el('div','wo-ch-relation-row'); row.append(el('strong','',characters.find(item => item.id === edge.source)?.name + ' → ' + edge.name),el('p','',edge.description)); list.append(row);
        }
        for (const node of nodes) {
            const point = positions.get(node.id), group = svgEl('g',{ transform:'translate(' + point.x + ' ' + point.y + ')',tabindex:node.external ? -1 : 0,role:'button','aria-label':'查看 ' + node.name });
            group.append(svgEl('circle',{ r:28,class:node.external ? 'wo-ch-node-external' : 'wo-ch-node' }));
            const text = svgEl('text',{ y:48,'text-anchor':'middle',fill:'currentColor' }); text.textContent = node.name; group.append(text);
            const icon = svgEl('text',{ y:6,'text-anchor':'middle',fill:'currentColor' }); icon.textContent = node.name[0]; group.append(icon);
            const open = () => { if (!node.external) openCharacter(node.id); }; group.addEventListener('click',open);
            group.addEventListener('keydown',event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }); svg.append(group);
        }
        graph.append(svg);
        if (!edges.length) list.append(el('p','fm-hint','还没有关系。可在角色状态中加入 relationship，例如 [{"苏岚":"朋友"}]。'));
    }
    function renderDebug() {
        const box = find('debug'); if (!box) return; box.replaceChildren();
        const report = engine.report(), run = engine.run;
        if (run && !run.done && run.selection) box.append(el('p','fm-hint','本次生成：关键词命中 ' + (run.selection.items.map(item => item.name).join('、') || '无')
            + '；实际进入上下文 ' + (run.confirmed ? (run.called.map(id => run.selection.items.find(item => item.id === id)?.name).join('、') || '无') : '等待最终提示词确认')));
        if (!report) { box.append(el('p','wo-ch-empty','还没有真实回复的状态记录。配置角色并在预设加入 {{character}} 后发送消息。')); return; }
        box.append(el('p','',report.status),el('p','fm-hint',new Date(report.time).toLocaleString() + ' · ' + (report.mode === 'auto' ? '回复后记录' : '手动更新')),
            el('p','', '本轮角色：' + (report.matched.map(item => item.name + '（' + item.stage + '）').join('、') || '无')));
        const query = el('details'); query.append(el('summary','','查询文本与真实回复'),el('pre','fm-output',report.query + '\n\n模型回复：\n' + report.reply)); box.append(query);
        for (const item of report.matched) {
            const section = el('details'); section.append(el('summary','',item.name + ' · 状态前后对比'));
            const changes = stateDifference(report.previous[item.id] ?? {},report.current[item.id] ?? {});
            if (!changes.length) section.append(el('p','fm-hint','本轮没有状态变化。'));
            for (const change of changes) section.append(el('pre','fm-output',change.path + '\n上一轮：' + (jsonText(change.before) ?? '不存在') + '\n当前：' + (jsonText(change.after) ?? '不存在')));
            section.append(el('pre','fm-output','上一轮完整状态：\n' + jsonText(report.previous[item.id] ?? {}) + '\n\n当前完整状态：\n' + jsonText(report.current[item.id] ?? {}))); box.append(section);
        }
        if (report.ignored?.length) {
            const rejected = el('details'); rejected.append(el('summary','','被忽略的 AI 指令（' + report.ignored.length + '）'));
            rejected.append(el('pre','fm-output',jsonText(report.ignored))); box.append(rejected);
        }
    }
    function addPrompt(value = { role:'user',content:'' }) {
        const row = el('div','fm-rule'); row.append(orderButtons(row));
        selectField(row,'role',['system','user','assistant'],value.role).dataset.promptRole = '';
        field(row,'提示词',value.content,true).dataset.promptContent = ''; find('prompts').append(row);
    }
    function fillAPI() {
        const value = config(), form = find('api-form');
        for (const element of form.elements) if (element.name && Object.hasOwn(value,element.name)) {
            if (element.type === 'checkbox') element.checked = Boolean(value[element.name]);
            else element.value = element.name === 'apiKey' ? key(value) : value[element.name];
        }
        find('prompts').replaceChildren(); value.prompts.forEach(addPrompt);
    }
    function readAPI() {
        const form = find('api-form'), value = { ...config() };
        for (const element of form.elements) if (element.name) value[element.name] = element.type === 'checkbox' ? element.checked
            : element.type === 'number' ? Number(element.value) : element.value;
        value.prompts = [...find('prompts').children].map(row => ({ role:row.querySelector('[data-prompt-role]').value,content:row.querySelector('[data-prompt-content]').value }));
        return validateStateAPI(value);
    }
    async function loadModels(automatic = false) {
        pickerJob?.abort(); const controller = new AbortController(); pickerJob = controller;
        const form = find('api-form'), endpoint = form.elements.endpoint.value.trim(), apiKey = form.elements.apiKey.value;
        if (!endpoint || (automatic && !apiKey.trim())) return;
        find('model-status').textContent = '正在拉取…';
        try {
            const models = await requestModels({ endpoint,timeoutSeconds:Math.max(5,Number(form.elements.timeoutSeconds.value) || 30) },apiKey,{ signal:controller.signal });
            if (controller.signal.aborted || endpoint !== form.elements.endpoint.value.trim() || apiKey !== form.elements.apiKey.value) return;
            const select = find('model-select'); select.replaceChildren(new Option('选择模型或手动填写',''));
            for (const model of models) select.append(new Option(model,model));
            if (models.includes(form.elements.model.value)) select.value = form.elements.model.value;
            find('model-status').textContent = '已获取 ' + models.length + ' 个模型。';
        } catch (error) { if (error.name !== 'AbortError') find('model-status').textContent = error.message; }
        finally { if (pickerJob === controller) pickerJob = null; }
    }
    find('definition-form').addEventListener('submit',event => { event.preventDefault(); void action(() => {
        const next = readDefinition(), characters = directoryOf(getContext()).filter(item => item.id !== selected); characters.push(next);
        saveDirectory(characters); selected = next.id; openCharacter(selected); say('角色设定已保存，这张角色卡的所有聊天共享。');
    }); });
    find('state-form').addEventListener('submit',event => { event.preventDefault(); void action(async () => {
        await saveCurrentState(parseJSON(find('current-state').value,'当前状态')); say('当前聊天状态已保存。');
    }); });
    find('reset-state').addEventListener('click',() => void action(async () => {
        const character = directoryOf(getContext()).find(item => item.id === selected);
        if (!character || !globalThis.confirm('恢复此角色在当前聊天中的全部基础状态？')) return;
        await saveCurrentState(character.baseState); say('已恢复当前角色的基础状态。');
    }));
    find('delete').addEventListener('click',() => void action(() => {
        const character = directoryOf(getContext()).find(item => item.id === selected);
        if (!character || !globalThis.confirm('删除角色“' + character.name + '”的共享设定？')) return;
        saveDirectory(directoryOf(getContext()).filter(item => item.id !== selected)); selected = ''; setView('list'); say('角色已删除。');
    }));
    find('avatar').addEventListener('change',() => avatar(find('avatar-preview'),{ name:find('name').value,avatar:find('avatar').value }));
    find('avatar-clear').addEventListener('click',() => { find('avatar').value = ''; find('avatar-file').value = ''; avatar(find('avatar-preview')); });
    find('avatar-file').addEventListener('change',() => void action(async () => {
        const file = find('avatar-file').files[0], capturedOwner = definitionOwner, capturedId = selected;
        if (!file) return;
        if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size > 12*1024*1024) throw new Error('请选择不超过 12 MB 的 PNG/JPEG/WebP/GIF 图片。');
        const url = URL.createObjectURL(file);
        try {
            const image = new Image(); image.src = url; await image.decode();
            const ratio = Math.min(1,512/Math.max(image.width,image.height));
            const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(image.width*ratio)); canvas.height = Math.max(1,Math.round(image.height*ratio));
            canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
            if (capturedOwner !== calendarOwner(getContext()) || capturedId !== selected) throw new DOMException('角色已变化','AbortError');
            find('avatar').value = canvas.toDataURL('image/webp',.82);
            avatar(find('avatar-preview'),{ name:find('name').value,avatar:find('avatar').value });
            say('图片已载入，保存角色后生效。');
        } finally { URL.revokeObjectURL(url); }
    }));
    find('add').addEventListener('click',() => openCharacter());
    find('list-back').addEventListener('click',() => setView('list'));
    find('search').addEventListener('input',renderList);
    find('add-stage').addEventListener('click',() => addStage());
    find('add-policy').addEventListener('click',() => addPolicy());
    find('permissions-from-state').addEventListener('click',() => void action(() => {
        const state = validateState(parseJSON(find('base-state').value,'基础状态'));
        const existing = new Set([...find('policies').querySelectorAll('[data-policy-path]')].map(input => input.value));
        for (const item of stateFields(state)) if (!existing.has(item.path)) addPolicy({ path:item.path,type:valueType(item.value),allow:['update'] });
    }));
    find('manual-update').addEventListener('click',() => void action(async () => {
        await engine.manual([selected],find('manual-requirements').value); refreshState(true); say(engine.report().status);
    }));
    for (const tab of page.querySelectorAll('[data-ch-tab]')) tab.addEventListener('click',() => setView(tab.dataset.chTab));
    find('debug-refresh').addEventListener('click',renderDebug);
    find('copy-macro').addEventListener('click',() => void action(async () => {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText('{{character}}'); say('已复制 {{character}}。'); }
        else { say('请复制此占位符：{{character}}'); }
    }));
    find('models').addEventListener('click',() => void loadModels());
    find('model-select').addEventListener('change',() => { if (find('model-select').value) find('api-form').elements.model.value = find('model-select').value; });
    for (const name of ['endpoint','apiKey']) find('api-form').elements[name].addEventListener('input',() => {
        pickerJob?.abort(); clearTimeout(pickerTimer); pickerTimer = setTimeout(() => { void loadModels(true); },800);
    });
    find('add-prompt').addEventListener('click',() => addPrompt());
    find('reset-prompts').addEventListener('click',() => { find('prompts').replaceChildren(); DEFAULT_STATE_PROMPTS.forEach(addPrompt); });
    find('api-form').addEventListener('submit',event => { event.preventDefault(); void action(() => {
        const value = readAPI(), ctx = getContext(); engine.changed(); sessionKey = value.apiKey;
        try { sessionStorage.setItem('world_os_characters.apiKey',sessionKey); } catch {}
        ctx.extensionSettings[CHARACTERS_KEY] = { ...ctx.extensionSettings[CHARACTERS_KEY],schema:1,api:{ ...value,apiKey:value.rememberKey ? value.apiKey : '' } };
        ctx.saveSettingsDebounced(); say('状态接口与预设已保存。');
    }); });
    find('test-api').addEventListener('click',() => void action(async () => {
        const value = readAPI(); testJob?.abort(); testJob = new AbortController();
        say('正在测试状态接口…');
        const result = await requestStateUpdate(value,value.apiKey,{
            characters:[{ id:'test',name:'测试角色',state:{ affection:0 },permissions:[{ path:'affection',type:'number',allow:['update'] }] }],
            query:'测试角色收到帮助。',reply:'测试角色表示感谢。',requirements:'这是连接测试，只需返回 {"operations":[]}。',
        },{ signal:testJob.signal });
        say('状态接口测试成功，返回 ' + result.operations.length + ' 项操作；测试未写入聊天。'); testJob = null;
    }));
    find('cancel').addEventListener('click',() => { pickerJob?.abort(); testJob?.abort(); engine.cancel(); say('已取消请求。'); });
    function refresh() {
        const currentOwner = calendarOwner(getContext());
        if (owner !== currentOwner) { owner = currentOwner; selected = ''; setView('list'); }
        renderList(); if (view === 'detail') refreshState(true);
        if (view === 'relations') renderRelations(); if (view === 'debug') renderDebug();
    }
    root.addEventListener('world-os:page',event => { if (event.detail.name === 'characters') refresh(); });
    const ctx = getContext();
    for (const name of ['CHAT_CHANGED','CHAT_LOADED','CHARACTER_SELECTED']) if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name],refresh);
    document.addEventListener(WORLD_EVENT,event => { refresh(); if (event.detail?.kind === 'restore') { selected = ''; setView('list'); fillAPI(); } });
    fillAPI(); renderList(); engine.mount();
    return { engine,refresh };
}
