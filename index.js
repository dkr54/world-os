import {
    MODULE_KEY, DEFAULT_SETTINGS, DEFAULT_KEYWORD_PROMPTS, normalizeSettings, fingerprint, buildFloors,
    rulesFingerprint, reconcileRecords, summaryOf, splitKeywords, keywordTextOf, isVisible,
    partitionFloors, retrieveMemories, projectPrompt, composePrompt, queryInputs,
    snapshotChat, chatFingerprint, replacePrompt,
} from './core.js';
import { RegexRunner } from './regex-runner.js';
import { mountFloatingWindow } from './floating-window.js';
import { mountCalendar } from './calendar.js';
import { mountCharacters } from './characters.js';
import { mountSnapshots } from './snapshots.js';
import { WORLD_KEY, WORLD_EVENT, worldEnabled, announceWorldChange } from './world-state.js';
import { waitForHostReady, runtimeLabel, tauriPromptSource, downloadMemory } from './host-runtime.js';
import {
    VectorCache, EmbeddingIndex, requestEmbeddings, embeddingUrl, requestModels, modelsUrl,
    requestRerank, rerankVectorCandidates, rerankUrl, chatCompletionsUrl,
} from './embeddings.js';

import { needsAIKeywords, requestAIKeywords, applyAIKeywords } from './keyword-ai.js';

const context = () => globalThis.SillyTavern.getContext();
const regexRunner = new RegexRunner();
const cache = new VectorCache({ onFallback: message => status(message, 'warning') });
const vectorIndex = new EmbeddingIndex(cache);
const sessionKey = MODULE_KEY + '.sessionKey';
let sessionApiKey = '';
try { sessionApiKey = sessionStorage.getItem(sessionKey) ?? ''; } catch { /* Memory-only key still works. */ }
const rerankSessionKey = MODULE_KEY + '.rerankSessionKey';
let sessionRerankApiKey = '';
try { sessionRerankApiKey = sessionStorage.getItem(rerankSessionKey) ?? ''; } catch { /* Memory-only key still works. */ }
const aiKeywordSessionKey = MODULE_KEY + '.aiKeywordSessionKey';
let sessionAIKeywordKey = '';
try { sessionAIKeywordKey = sessionStorage.getItem(aiKeywordSessionKey) ?? ''; } catch { /* Memory-only key still works. */ }
const keywordSaves = new WeakMap();
const modelPickers = [];
const pendingAutoMessages = new Set();
let hostGenerating = false;
let root;
let floatingWindow;
let characterApp;
let recordsPage = 0;
let revision = 0;
let syncQueue = Promise.resolve();
let syncTimer;
const jobs = new Set();
let activeGeneration = false;

function settings() {
    return normalizeSettings(context().extensionSettings[MODULE_KEY] ?? DEFAULT_SETTINGS);
}
function apiKey(settingsSnapshot) { return settingsSnapshot.rememberKey ? settingsSnapshot.apiKey : sessionApiKey; }
function rerankApiKey(config) { return config.rerankRememberKey ? config.rerankApiKey : sessionRerankApiKey; }
function aiKeywordKey(config) { return config.aiKeywordRememberKey ? config.aiKeywordApiKey : sessionAIKeywordKey; }
function records() { return context().chatMetadata?.[MODULE_KEY]?.records ?? []; }
function scopeOf(ctx = context()) {
    const chatId = ctx.chatId ?? ctx.getCurrentChatId?.();
    if (!chatId) return '';
    const owner = ctx.groupId
        ? 'group:' + ctx.groupId
        : 'character:' + (ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId ?? ctx.name2 ?? '');
    return fingerprint(JSON.stringify([owner, chatId]));
}
function status(message, level = 'info') {
    const element = root?.querySelector('#fm-status');
    if (element) { element.textContent = message; element.dataset.level = level; }
}
function notice(message, level = 'error') {
    status(message, level);
    globalThis.toastr?.[level]?.(message, '楼层记忆', { preventDuplicates: true });
}
function beginJob() {
    for (const job of jobs) job.abort();
    const controller = new AbortController();
    jobs.add(controller);
    return controller;
}
function invalidate() {
    revision++;
    for (const job of jobs) job.abort();
}
function ensureCurrent(expectedRevision, expectedScope, signal) {
    if (signal?.aborted || expectedRevision !== revision || expectedScope !== scopeOf()) {
        throw new DOMException('聊天或设置已变化，操作已取消。', 'AbortError');
    }
}
async function saveRecords(next, ctx = context()) {
    ctx.chatMetadata[MODULE_KEY] = { schema: 1, records: next };
    await ctx.saveMetadata();
}

/** Start saving immediately and coalesce edits arriving during an in-flight save. */
function persistKeywords(ctx, expectedScope) {
    const metadata = ctx.chatMetadata;
    let state = keywordSaves.get(metadata);
    if (!state) { state = { pending: false, promise: null }; keywordSaves.set(metadata, state); }
    state.pending = true;
    if (!state.promise) {
        state.promise = (async () => {
            while (state.pending) {
                state.pending = false;
                if (scopeOf() !== expectedScope || context().chatMetadata !== metadata) return;
                await ctx.saveMetadata();
            }
        })().finally(() => { state.promise = null; });
    }
    return state.promise;
}

/** Serialize commits; discard all results from a chat/settings revision that moved on. */
function synchronize(signal) {
    const work = async () => {
        const ctx = context();
        const scope = scopeOf(ctx);
        const expectedRevision = revision;
        if (!scope) return [];
        const config = settings();
        const snapshot = snapshotChat(ctx.chat);
        const { floors } = buildFloors(snapshot);
        const signature = rulesFingerprint(config);
        const previous = records();
        const previousById = new Map(previous.map(record => [record.id, record]));
        const needed = floors.filter(floor => previousById.get(floor.id)?.rules !== signature);
        ensureCurrent(expectedRevision, scope, signal);
        const outputs = await regexRunner.runBatches(needed.map(floor => floor.text), config, signal,
            (done, total) => status('正在提取总结：' + done + ' / ' + total));
        ensureCurrent(expectedRevision, scope, signal);
        // A content check also catches integrations that edit messages without an event.
        if (chatFingerprint(ctx.chat) !== chatFingerprint(snapshot)) {
            throw new DOMException('消息已发生变化，请重新尝试。', 'AbortError');
        }
        const extracted = new Map(needed.map((floor, index) => [floor.id, outputs[index].summary]));
        const next = reconcileRecords(floors, previous, extracted, signature);
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
            await saveRecords(next, ctx);
            ensureCurrent(expectedRevision, scope, signal);
        }
        renderRecords();
        return next;
    };
    const promise = syncQueue.catch(() => {}).then(work);
    syncQueue = promise;
    return promise;
}

function makeRawPrompt(chat) {
    return snapshotChat(chat).filter(isVisible).map((message, index) => ({ ...message, index }));
}
function describePlan(partitions, hits, next, query, warning) {
    const floorList = floors => floors.length ? floors.map(floor => floor.floor).join('、') : '无';
    const summaryMap = new Map(next.map(record => [record.id, record]));
    const missing = partitions.middle.filter(floor => !summaryOf(summaryMap.get(floor.id)));
    const lines = [
        '这是本扩展处理后的聊天部分，不包含角色卡、世界书和其他提示词。最终仍受 SillyTavern 的上下文长度限制。',
        '',
        '最近原文 N：第 ' + floorList(partitions.recent) + ' 楼',
        '中间总结 M：第 ' + floorList(partitions.middle) + ' 楼',
        '中间缺失总结：' + floorList(missing),
        '更早候选区：' + (partitions.older.length ? '第 ' + partitions.older[0].floor + '～' + partitions.older.at(-1).floor + ' 楼' : '无'),
        '召回：' + hits.length + ' 楼',
        ...hits.map(hit => '  第 ' + hit.record.floor + ' 楼 · ' + (hit.reason === 'keyword'
            ? '关键词：' + hit.matched.join('、')
            : '向量相似度：' + hit.score.toFixed(4)
                + (Number.isFinite(hit.rerankScore) ? ' · 重排相关度：' + hit.rerankScore.toFixed(4) : ''))),
        ...(warning ? ['', warning] : []),
        '', '查询文本:', query || '（无查询文本）',
    ];
    const panel = root?.querySelector('#fm-preview-output');
    if (panel) panel.textContent = lines.join('\n');
}

async function planInjection(prompt, type, signal) {
    const expectedRevision = revision;
    const scope = scopeOf();
    if (!scope) throw new Error('请先打开一段聊天。');
    const config = settings();
    const next = await synchronize(signal);
    ensureCurrent(expectedRevision, scope, signal);
    const rawSnapshot = snapshotChat(context().chat);
    const sourceIndices = await tauriPromptSource(rawSnapshot, type, context(), { promptLength: prompt.length });
    ensureCurrent(expectedRevision, scope, signal);
    const projection = projectPrompt(prompt, rawSnapshot, type, sourceIndices);
    const partitions = partitionFloors(projection.floors, config, type);
    const oldIds = new Set(partitions.older.map(floor => floor.id));
    const oldRecords = next.filter(record => oldIds.has(record.id));
    const inputs = queryInputs(projection, config.queryFloors);
    const processedQuery = await regexRunner.runBatches(inputs, config, signal);
    const query = processedQuery.map(item => item.dialogue).filter(Boolean).join('\n\n');
    const vectorSearch = async (candidates, text, count) => {
        status('关键词不足，正在检索 ' + candidates.length + ' 楼的向量…');
        const poolSize = config.rerankEnabled ? Math.max(count, config.rerankCandidates) : count;
        const hits = await vectorIndex.search(scope, candidates, text, poolSize, config, apiKey(config), {
            signal, progress: (done, total) => status('正在向量化总结：' + done + ' / ' + total),
        });
        if (config.rerankEnabled && hits.length > count) status('正在重排 ' + hits.length + ' 楼向量候选…');
        return rerankVectorCandidates(hits, text, count, config, rerankApiKey(config), { signal });
    };
    const { hits, warning } = await retrieveMemories(oldRecords, query, config, vectorSearch);
    ensureCurrent(expectedRevision, scope, signal);
    if (chatFingerprint(context().chat) !== chatFingerprint(rawSnapshot)) {
        throw new DOMException('消息已变化，本次注入已取消。', 'AbortError');
    }
    const output = composePrompt(projection, partitions, next, hits, config);
    describePlan(partitions, hits, next, query, warning);
    const keywordCount = hits.filter(hit => hit.reason === 'keyword').length;
    status(warning || ('已保留 ' + partitions.recent.length + ' 楼原文、处理 ' + partitions.middle.length
        + ' 楼总结，召回 ' + keywordCount + ' 楼关键词记忆和 ' + (hits.length - keywordCount) + ' 楼向量记忆。'),
    warning ? 'warning' : 'info');
    if (warning) globalThis.toastr?.warning?.(warning, '楼层记忆', { preventDuplicates: true });
    return output;
}

globalThis.floorMemoryInterceptor = async (prompt, _contextSize, abort, type = 'normal') => {
    let job;
    try {
        if (!worldEnabled(context())) return;
        characterApp?.engine.prepare(type);
        if (!settings().enabled || ['quiet', 'impersonate'].includes(type) || !scopeOf()) return;
        job = beginJob();
        activeGeneration = true;
        const output = await planInjection(prompt, type, job.signal);
        // Replace the request array only. No mes or nested extra object is edited in place.
        if (prompt === context().chat) throw new Error('宿主传入了原始聊天数组，无法安全修改本次上下文。');
        replacePrompt(prompt, output);
    } catch (error) {
        abort(true);
        if (error.name === 'AbortError') status('聊天或设置已变化，本次生成已取消。', 'warning');
        else notice('本次生成已暂停：' + error.message);
    } finally {
        activeGeneration = false;
        if (job) jobs.delete(job);
    }
};

async function runAction(action) {
    const job = beginJob();
    try { await action(job.signal); }
    catch (error) {
        if (error.name === 'AbortError') status('操作已取消。');
        else notice(error.message);
    } finally { jobs.delete(job); }
}

function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}
function appendField(parent, title, value, fieldName, multiline = false) {
    const label = createElement('label', '', title);
    const input = createElement(multiline ? 'textarea' : 'input', 'text_pole fm-code');
    input.dataset.field = fieldName;
    input.value = value;
    if (multiline) input.rows = 2;
    label.append(input);
    parent.append(label);
    return input;
}
function addRule(rule = { enabled: true, pattern: '', flags: 'gi', replacement: '' }, container = '#fm-cleanup-rules') {
    const row = createElement('div', 'fm-rule');
    const header = createElement('div', 'fm-rule-head');
    const label = createElement('label', 'checkbox_label');
    const enabled = createElement('input');
    enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false; enabled.dataset.field = 'enabled';
    label.append(enabled, document.createTextNode('启用清洗规则'));
    const actions = createElement('div', 'fm-actions');
    const up = createElement('button', 'menu_button', '↑');
    up.type = 'button'; up.title = '向上移动'; up.addEventListener('click', () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); });
    const down = createElement('button', 'menu_button', '↓');
    down.type = 'button'; down.title = '向下移动'; down.addEventListener('click', () => { if (row.nextElementSibling) row.nextElementSibling.after(row); });
    const remove = createElement('button', 'menu_button', '删除');
    remove.type = 'button'; remove.addEventListener('click', () => row.remove());
    actions.append(up, down, remove); header.append(label, actions); row.append(header);
    appendField(row, '匹配正则', rule.pattern, 'pattern', true);
    appendField(row, '标志 flags', rule.flags ?? '', 'flags');
    appendField(row, '替换为（留空即删除）', rule.replacement ?? '', 'replacement');
    root.querySelector(container).append(row);
}
function addKeywordPrompt(message = { role: 'user', content: '' }) {
    const row = createElement('div', 'fm-rule fm-ai-prompt');
    const head = createElement('div', 'fm-rule-head');
    const label = createElement('label', '', '消息角色 role');
    const select = createElement('select', 'text_pole');
    select.dataset.field = 'role';
    for (const [value, title] of [['system', 'system · 系统'], ['user', 'user · 用户'], ['assistant', 'assistant · 助手']]) {
        const option = createElement('option', '', title);
        option.value = value; select.append(option);
    }
    select.value = message.role;
    label.append(select); head.append(label);
    const actions = createElement('div', 'fm-actions');
    for (const [title, action] of [
        ['↑', () => { if (row.previousElementSibling) row.previousElementSibling.before(row); }],
        ['↓', () => { if (row.nextElementSibling) row.nextElementSibling.after(row); }],
        ['删除', () => row.remove()],
    ]) {
        const button = createElement('button', 'menu_button', title);
        button.type = 'button'; button.addEventListener('click', action); actions.append(button);
    }
    head.append(actions); row.append(head);
    const content = appendField(row, '提示词内容', message.content, 'content', true);
    content.rows = 5;
    root.querySelector('#fm-ai-prompts').append(row);
}

function formSettings() {
    const form = root.querySelector('#fm-form');
    const next = { ...settings() };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const input = form.elements.namedItem(key);
        if (input) next[key] = input.type === 'checkbox' ? input.checked : input.value;
    }
    const readRules = selector => [...root.querySelectorAll(selector + ' .fm-rule')].map(row => {
        const rule = {};
        for (const input of row.querySelectorAll('[data-field]')) {
            rule[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
        }
        return rule;
    });
    next.cleanupRules = readRules('#fm-cleanup-rules');
    next.aiKeywordCleanupRules = readRules('#fm-ai-keyword-rules');
    next.aiKeywordPrompts = [...root.querySelectorAll('.fm-ai-prompt')].map(row => ({
        role: row.querySelector('[data-field="role"]').value,
        content: row.querySelector('[data-field="content"]').value,
    }));
    return normalizeSettings(next);
}
function fillForm() {
    const current = settings();
    const form = root.querySelector('#fm-form');
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const input = form.elements.namedItem(key);
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = Boolean(current[key]);
        else input.value = key === 'apiKey' ? apiKey(current) : key === 'rerankApiKey' ? rerankApiKey(current)
            : key === 'aiKeywordApiKey' ? aiKeywordKey(current) : current[key];
    }
    root.querySelector('#fm-cleanup-rules').replaceChildren();
    for (const rule of current.cleanupRules) addRule(rule);
    root.querySelector('#fm-ai-keyword-rules').replaceChildren();
    for (const rule of current.aiKeywordCleanupRules) addRule(rule, '#fm-ai-keyword-rules');
    root.querySelector('#fm-ai-prompts').replaceChildren();
    for (const message of current.aiKeywordPrompts) addKeywordPrompt(message);
}
function cancelModelLoad() { for (const picker of modelPickers) picker.cancel(); }

/** Independent model lists share behavior, but never keys, requests, or responses. */
function setupModelPicker({ prefix, panelId, endpoint, key, model, timeout, label }) {
    const form = root.querySelector('#fm-form');
    const endpointInput = form.elements.namedItem(endpoint);
    const keyInput = form.elements.namedItem(key);
    const modelInput = form.elements.namedItem(model);
    const select = root.querySelector('#' + prefix + '-model-select');
    const button = root.querySelector('#' + prefix + '-load-models');
    const setStatus = message => { root.querySelector('#' + prefix + '-model-status').textContent = message; };
    let timer, request;
    const reset = (message = '请先拉取模型列表') => {
        const option = createElement('option', '', message);
        option.value = ''; select.replaceChildren(option); select.disabled = true;
    };
    const cancel = () => {
        clearTimeout(timer); request?.abort(); request = undefined; button.disabled = false;
    };
    modelPickers.push({ cancel });
    const load = async () => {
        cancel();
        const controller = new AbortController();
        request = controller;
        const seconds = Number(form.elements.namedItem(timeout).value);
        const config = { endpoint: endpointInput.value.trim(),
            timeoutSeconds: Number.isFinite(seconds) && seconds >= 1 && seconds <= 300 ? seconds : DEFAULT_SETTINGS[timeout] };
        button.disabled = true; reset('正在拉取…'); setStatus('正在拉取模型列表…');
        try {
            const ids = await requestModels(config, keyInput.value, { signal: controller.signal });
            if (request !== controller || controller.signal.aborted) return;
            reset(ids.length ? '请选择模型' : '服务未返回可用模型');
            for (const id of ids) { const option = createElement('option', '', id); option.value = id; select.append(option); }
            select.disabled = !ids.length;
            if (ids.includes(modelInput.value)) select.value = modelInput.value;
            setStatus(ids.length
                ? '已拉取 ' + ids.length + ' 个模型。请选择支持 ' + label + ' 的模型，选择后保存设置。'
                : '服务返回的模型列表为空，可以手动填写模型名。');
        } catch (error) {
            if (request !== controller || controller.signal.aborted) return;
            reset('拉取失败，可重试或手动填写');
            setStatus(error.message + ' 也可以手动填写模型名。');
        } finally {
            if (request === controller) { request = undefined; button.disabled = false; }
        }
    };
    button.addEventListener('click', () => { void load(); });
    for (const input of [endpointInput, keyInput]) {
        input.addEventListener('input', () => {
            cancel(); reset(); setStatus('连接信息已变化，完成输入后将自动拉取模型列表。');
        });
        input.addEventListener('change', () => {
            cancel();
            if (endpointInput.value.trim()) timer = setTimeout(() => { void load(); }, 500);
        });
    }
    select.addEventListener('change', () => {
        if (!select.value) return;
        modelInput.value = select.value;
        setStatus('已选择 ' + select.value + '，点击“保存设置”后生效。');
    });
    modelInput.addEventListener('input', () => {
        select.value = [...select.options].some(option => option.value === modelInput.value) ? modelInput.value : '';
    });
    const panel = root.querySelector('#' + panelId);
    panel.addEventListener('toggle', () => {
        if (!panel.open || select.options.length > 1 || request || !endpointInput.value.trim()) return;
        try { modelsUrl(endpointInput.value); } catch { return; }
        cancel(); timer = setTimeout(() => { void load(); }, 500);
    });
}

function renderRecords(force = false) {
    if (!root) return;
    const all = records();
    const list = root.querySelector('#fm-records');
    const currentScope = scopeOf();
    const active = document.activeElement;
    // A background refresh must not replace a keyword input while it is being edited.
    if (!force && list.dataset.scope === currentScope && list.contains(active)
        && active?.dataset.field === 'keywords'
        && all.some(record => record.id === active.closest('.fm-record')?.dataset.recordId)) return;
    const search = root.querySelector('#fm-record-search').value.toLocaleLowerCase();
    const filtered = all.filter(record => [String(record.floor), summaryOf(record), ...(record.keywords ?? [])]
        .some(value => value.toLocaleLowerCase().includes(search)));
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    recordsPage = Math.min(recordsPage, pageCount - 1);
    root.querySelector('#fm-record-count').textContent = '(' + all.filter(record => summaryOf(record)).length + '/' + all.length + ')';
    list.replaceChildren();
    list.dataset.scope = currentScope;
    for (const record of filtered.slice(recordsPage * pageSize, (recordsPage + 1) * pageSize)) {
        const card = createElement('div', 'fm-record');
        card.dataset.recordId = record.id;
        const head = createElement('div', 'fm-record-head');
        head.append(createElement('strong', '', '第 ' + record.floor + ' 楼 · ' + record.name));
        card.append(head);
        const summary = appendField(card, '总结', summaryOf(record), 'summary', true);
        summary.rows = 4;
        const keywords = appendField(card, '触发关键词（自动保存；留空不参与关键词匹配）', keywordTextOf(record), 'keywords');
        keywords.placeholder = '英文逗号分隔多个词；中文逗号属于关键词';
        const saveKeywords = event => {
            if (event.isComposing) return;
            const ctx = context();
            const current = records().find(item => item.id === record.id);
            if (currentScope !== scopeOf(ctx) || !current) {
                notice('楼层已变化，请刷新后再编辑。', 'warning');
                return;
            }
            const text = keywords.value;
            if (current.keywordText === text) return;
            invalidate();
            // Replace only this record; summaries are not re-extracted or committed by keyword input.
            const next = records().map(item => item.id === record.id
                ? { ...item, keywordText: text, keywords: splitKeywords(text), keywordSource: 'manual' } : item);
            ctx.chatMetadata[MODULE_KEY] = { schema: 1, records: next };
            void persistKeywords(ctx, currentScope).then(() => {
                if (currentScope === scopeOf() && records().find(item => item.id === record.id)?.keywordText === text) {
                    status('已自动保存第 ' + record.floor + ' 楼关键词。');
                }
            }).catch(error => {
                if (currentScope === scopeOf()) notice('关键词保存失败：' + error.message);
            });
        };
        keywords.addEventListener('input', saveKeywords);
        keywords.addEventListener('compositionend', saveKeywords);
        keywords.addEventListener('change', saveKeywords);
        const buttons = createElement('div', 'fm-actions');
        const save = createElement('button', 'menu_button', '保存总结');
        const reset = createElement('button', 'menu_button', '恢复正则提取');
        for (const button of [save, reset]) button.type = 'button';
        const edit = async (restore) => {
            if (currentScope !== scopeOf() || !records().some(item => item.id === record.id)) {
                throw new Error('楼层已变化，请刷新后再编辑。');
            }
            invalidate();
            const next = structuredClone(records());
            const target = next.find(item => item.id === record.id);
            if (restore) delete target.override;
            else target.override = summary.value.trim();
            await saveRecords(next);
            renderRecords(true);
            status('已保存第 ' + record.floor + ' 楼。其向量会在下次使用时按新总结更新。');
        };
        save.addEventListener('click', () => runAction(() => edit(false)));
        reset.addEventListener('click', () => runAction(() => edit(true)));
        buttons.append(save, reset); card.append(buttons); list.append(card);
    }
    if (!filtered.length) list.append(createElement('p', 'fm-hint', '没有匹配的楼层。打开聊天后点击“提取／刷新本聊天总结”。'));
    root.querySelector('#fm-page').textContent = (recordsPage + 1) + ' / ' + pageCount;
    root.querySelector('#fm-prev-page').disabled = recordsPage === 0;
    root.querySelector('#fm-next-page').disabled = recordsPage + 1 >= pageCount;
}

function renderAIMetrics(metrics) {
    const lines = [
        '最近请求：' + metrics.floors + ' 楼 · 预设和总结共 ' + metrics.inputChars + ' 字符',
        '接口往返 ' + metrics.requestSeconds.toFixed(2) + ' 秒（含网络、排队和生成）'
            + ' · 本地解析清洗 ' + metrics.processingSeconds.toFixed(2) + ' 秒',
    ];
    const tokens = [['输入', metrics.promptTokens], ['输出', metrics.completionTokens], ['思考', metrics.reasoningTokens]]
        .filter(([, value]) => Number.isFinite(value) && value >= 0).map(([label, value]) => label + ' ' + value);
    if (tokens.length) lines.push('服务报告 token：' + tokens.join(' / '));
    if (!metrics.responseReceived) lines.push('未收到完整响应；统计为本次等待时间。');
    if (metrics.requestThinking === false) lines.push('本次请求已设置 enable_thinking=false。');
    if (metrics.hasReasoning) lines.push('服务仍返回了思考内容；可检查关闭思考参数是否生效。');
    if (metrics.jsonRepairs?.length) lines.push('JSON 兼容处理：' + metrics.jsonRepairs.join('、') + '。');
    root.querySelector('#fm-ai-diagnostics').textContent = lines.join('\n');
}

async function generateKeywords(targets, config, signal, expectedRevision, scope) {
    let done = 0;
    const chatSnapshot = chatFingerprint(context().chat);
    try {
        for (let start = 0; start < targets.length; start += config.aiKeywordBatchSize) {
            ensureCurrent(expectedRevision, scope, signal);
            const batch = targets.slice(start, start + config.aiKeywordBatchSize);
            status('AI 正在设置关键词：' + done + ' / ' + targets.length + ' 楼…');
            const waitingSince = performance.now();
            const ticker = setInterval(() => {
                if (!signal.aborted && expectedRevision === revision && scope === scopeOf()) {
                    status('AI 正在设置关键词：' + done + ' / ' + targets.length + ' 楼，本批 '
                        + batch.length + ' 楼已等待 ' + Math.floor((performance.now() - waitingSince) / 1000) + ' 秒…');
                }
            }, 1000);
            let suggestions;
            try {
                suggestions = await requestAIKeywords(batch, config, aiKeywordKey(config), {
                    signal, names: { char: context().name2, user: context().name1 },
                    onMetrics: metrics => {
                        if (!signal.aborted && expectedRevision === revision && scope === scopeOf()) renderAIMetrics(metrics);
                    },
                });
            } finally { clearInterval(ticker); }
            ensureCurrent(expectedRevision, scope, signal);
            if (chatFingerprint(context().chat) !== chatSnapshot) {
                throw new DOMException('聊天内容已变化，本批关键词已取消。', 'AbortError');
            }
            const next = applyAIKeywords(records(), batch, suggestions);
            await saveRecords(next);
            ensureCurrent(expectedRevision, scope, signal);
            done += batch.length;
            renderRecords();
        }
        status('AI 关键词已保存：' + done + ' / ' + targets.length + ' 楼。');
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('AI 关键词已完成 ' + done + ' / ' + targets.length + ' 楼；' + error.message);
    }
}

async function runAutomaticKeywords(next, config, signal) {
    if (!config.aiKeywordAuto || !pendingAutoMessages.size) return;
    const queued = new Set(pendingAutoMessages);
    const ids = new Set(buildFloors(context().chat).floors
        .filter(floor => queued.has(context().chat[floor.assistantIndex])).map(floor => floor.id));
    const targets = structuredClone(next.filter(record => ids.has(record.id) && needsAIKeywords(record, 'auto')));
    try {
        if (targets.length) await generateKeywords(targets, config, signal, revision, scopeOf());
        for (const message of queued) pendingAutoMessages.delete(message);
    } catch (error) {
        // Do not repeatedly spend tokens retrying a provider error. Manual batch processing can retry.
        if (error.name !== 'AbortError') for (const message of queued) pendingAutoMessages.delete(message);
        throw error;
    }
}

function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        if (!worldEnabled(context()) || !settings().enabled || !scopeOf() || context().streamingProcessor?.isFinished === false) return;
        // A delayed background scan must not cancel a foreground preview/index job.
        if (activeGeneration || hostGenerating || jobs.size) { scheduleSync(); return; }
        runAction(async signal => {
            const next = await synchronize(signal);
            status('已同步 ' + next.length + ' 楼，提取到 ' + next.filter(record => summaryOf(record)).length + ' 楼总结。');
            await runAutomaticKeywords(next, settings(), signal);
        });
    }, 350);
}

async function initialize() {
    await waitForHostReady();
    const ctx = context();
    ctx.extensionSettings[MODULE_KEY] ??= structuredClone(DEFAULT_SETTINGS);
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) throw new Error('无法加载楼层记忆设置面板。');
    const template = document.createElement('template');
    template.innerHTML = await response.text();
    root = template.content.firstElementChild;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host) throw new Error('找不到 SillyTavern 扩展设置区域。');
    if (document.querySelector('#world-os')) return;
    floatingWindow = mountFloatingWindow(root, {
        host, enabled: settings().enabled, masterEnabled: worldEnabled(ctx),
        onMasterChange(enabled) {
            const current = context();
            current.extensionSettings[WORLD_KEY] = { ...current.extensionSettings[WORLD_KEY], schema:1, enabled };
            current.saveSettingsDebounced(); announceWorldChange('master');
        },
        onEnabledChange(enabled) {
            invalidate();
            const current = context();
            current.extensionSettings[MODULE_KEY] = { ...current.extensionSettings[MODULE_KEY], enabled };
            if (!enabled) pendingAutoMessages.clear();
            current.saveSettingsDebounced();
            status(enabled ? '楼层记忆已启用。' : '楼层记忆已关闭。');
            scheduleSync();
        },
    });
    mountCalendar(root, { getContext: context, openApp: floatingWindow.openApp });
    characterApp = mountCharacters(root, { getContext: context });
    mountSnapshots(root, { getContext: context });
    document.addEventListener(WORLD_EVENT, event => {
        invalidate(); pendingAutoMessages.clear(); cancelModelLoad();
        floatingWindow.setWorldEnabled(worldEnabled(context()));
        if (event.detail?.kind === 'restore') { fillForm(); renderRecords(true); root.querySelector('#fm-preview-output').textContent = ''; }
        if (event.detail?.kind !== 'before-restore') scheduleSync();
    });
    fillForm();
    root.querySelector('#fm-runtime').textContent = '运行环境：' + runtimeLabel();
    for (const picker of [
        { prefix: 'fm', panelId: 'fm-embedding-panel', endpoint: 'endpoint', key: 'apiKey', model: 'model', timeout: 'timeoutSeconds', label: 'Embedding' },
        { prefix: 'fm-rerank', panelId: 'fm-rerank-panel', endpoint: 'rerankEndpoint', key: 'rerankApiKey', model: 'rerankModel', timeout: 'rerankTimeoutSeconds', label: 'Rerank' },
        { prefix: 'fm-ai', panelId: 'fm-ai-panel', endpoint: 'aiKeywordEndpoint', key: 'aiKeywordApiKey', model: 'aiKeywordModel', timeout: 'aiKeywordTimeoutSeconds', label: '聊天关键词提取' },
    ]) setupModelPicker(picker);
    root.querySelector('#fm-form').addEventListener('submit', event => {
        event.preventDefault();
        runAction(async () => {
            const next = formSettings();
            if (next.endpoint) embeddingUrl(next.endpoint);
            if (next.rerankEndpoint) rerankUrl(next.rerankEndpoint);
            if (next.aiKeywordEndpoint) chatCompletionsUrl(next.aiKeywordEndpoint);
            invalidate();
            sessionApiKey = next.apiKey;
            try { sessionStorage.setItem(sessionKey, sessionApiKey); } catch { /* Keep key in memory. */ }
            if (!next.rememberKey) next.apiKey = '';
            sessionRerankApiKey = next.rerankApiKey;
            try { sessionStorage.setItem(rerankSessionKey, sessionRerankApiKey); } catch { /* Keep key in memory. */ }
            if (!next.rerankRememberKey) next.rerankApiKey = '';
            sessionAIKeywordKey = next.aiKeywordApiKey;
            try { sessionStorage.setItem(aiKeywordSessionKey, sessionAIKeywordKey); } catch { /* Keep key in memory. */ }
            if (!next.aiKeywordRememberKey) next.aiKeywordApiKey = '';
            if (!next.aiKeywordAuto) pendingAutoMessages.clear();
            context().extensionSettings[MODULE_KEY] = next;
            floatingWindow.setEnabled(next.enabled);
            context().saveSettingsDebounced();
            status('设置已保存。' + (next.enabled ? '楼层记忆已启用。' : '楼层记忆已关闭。'));
            scheduleSync();
        });
    });
    root.querySelector('#fm-ai-add-cleanup').addEventListener('click', () => addRule(undefined, '#fm-ai-keyword-rules'));
    root.querySelector('#fm-ai-add-prompt').addEventListener('click', () => addKeywordPrompt());
    root.querySelector('#fm-ai-reset-prompts').addEventListener('click', () => {
        root.querySelector('#fm-ai-prompts').replaceChildren();
        for (const message of structuredClone(DEFAULT_KEYWORD_PROMPTS)) addKeywordPrompt(message);
        status('已恢复关键词内置预设，保存设置后生效。');
    });
    root.querySelector('#fm-ai-test').addEventListener('click', () => runAction(async signal => {
        const config = settings();
        const result = await requestAIKeywords([{ id: 'test', floor: 1, extracted: '示例角色甲在青石镇北门与苏岚会合。' }],
            config, aiKeywordKey(config), { signal, names: { char: context().name2, user: context().name1 },
                onMetrics: metrics => { if (!signal.aborted) renderAIMetrics(metrics); },
            });
        status('AI 关键词接口测试成功：' + (result[0].keywords.join(',') || '（模型未提取到关键词）') + '。测试结果未写入聊天。');
    }));
    root.querySelector('#fm-ai-generate').addEventListener('click', () => runAction(async signal => {
        const scope = scopeOf();
        if (!scope) throw new Error('请先打开一段聊天。');
        const expectedRevision = revision;
        const config = settings();
        const next = await synchronize(signal);
        ensureCurrent(expectedRevision, scope, signal);
        const mode = root.querySelector('#fm-ai-write-mode').value;
        const targets = structuredClone(next.filter(record => needsAIKeywords(record, mode)));
        if (!targets.length) { status('没有需要 AI 设置关键词的总结。当前非空关键词默认保留。'); return; }
        await generateKeywords(targets, config, signal, expectedRevision, scope);
    }));
    root.querySelector('#fm-add-rule').addEventListener('click', () => addRule());
    root.querySelector('#fm-test-regex').addEventListener('click', () => runAction(async signal => {
        const [result] = await regexRunner.run([root.querySelector('#fm-regex-input').value], formSettings(), signal);
        root.querySelector('#fm-regex-output').textContent = '清洗后：\n' + result.cleaned + '\n\n提取的总结：\n' + (result.summary || '（未匹配）');
        status('正则测试完成。');
    }));
    root.querySelector('#fm-rescan').addEventListener('click', () => runAction(async signal => {
        if (!scopeOf()) throw new Error('请先打开一段聊天。');
        const next = await synchronize(signal);
        status('已同步 ' + next.length + ' 楼，提取到 ' + next.filter(record => summaryOf(record)).length + ' 楼总结。');
        root.querySelector('#fm-records-panel').open = true;
    }));
    root.querySelector('#fm-preview').addEventListener('click', () => runAction(async signal => {
        const ctx = context();
        const snapshot = snapshotChat(ctx.chat);
        const sourceIndices = await tauriPromptSource(snapshot, 'normal', ctx);
        const prompt = sourceIndices ? sourceIndices.map((index, offset) => ({ ...snapshot[index], index: offset }))
            : makeRawPrompt(snapshot);
        await planInjection(prompt, 'normal', signal);
        root.querySelector('#fm-preview-panel').open = true;
    }));
    root.querySelector('#fm-test-embedding').addEventListener('click', () => runAction(async signal => {
        const config = settings();
        const [vector] = await requestEmbeddings(['连接测试'], config, apiKey(config), { signal });
        status('Embedding 接口连接成功，向量维数：' + vector.length + '。');
    }));
    root.querySelector('#fm-test-rerank').addEventListener('click', () => runAction(async signal => {
        const config = settings();
        const candidates = ['北门约定会合', '海边购买船票'].map((extracted, index) => ({
            record: { id: String(index), extracted }, score: 1,
        }));
        await requestRerank(candidates, '在哪里会合？', 1, config, rerankApiKey(config), { signal });
        status('Rerank 接口连接成功。');
    }));
    root.querySelector('#fm-index').addEventListener('click', () => runAction(async signal => {
        const scope = scopeOf();
        if (!scope) throw new Error('请先打开一段聊天。');
        const expectedRevision = revision;
        const config = settings();
        const next = (await synchronize(signal)).filter(record => summaryOf(record));
        const liveKeys = new Set(next.map(record => vectorIndex.cacheKey(scope, record, config)));
        await cache.prune(scope, liveKeys);
        await vectorIndex.ensure(scope, next, config, apiKey(config), {
            signal, progress: (done, total) => status('正在向量化总结：' + done + ' / ' + total),
        });
        ensureCurrent(expectedRevision, scope, signal);
        status('本聊天 ' + next.length + ' 楼总结的向量已就绪。');
    }));
    root.querySelector('#fm-clear-index').addEventListener('click', () => runAction(async () => {
        if (!scopeOf()) throw new Error('请先打开一段聊天。');
        await cache.prune(scopeOf());
        status('已清空本聊天向量缓存；总结仍已保存。');
    }));
    root.querySelector('#fm-cancel').addEventListener('click', () => { for (const job of jobs) job.abort(); pendingAutoMessages.clear(); cancelModelLoad(); status('已请求取消当前操作。'); });
    root.querySelector('#fm-export').addEventListener('click', () => runAction(async signal => {
        const next = await synchronize(signal);
        const data = { schema: 1, chatId: context().chatId, exportedAt: new Date().toISOString(), records: next };
        const result = await downloadMemory(data, 'floor-memory-' + scopeOf() + '.json');
        status('已导出本聊天总结；文件不包含密钥或向量。' + (result?.savedPath ? '\n保存位置：' + result.savedPath : ''));
    }));
    root.querySelector('#fm-record-search').addEventListener('input', () => { recordsPage = 0; renderRecords(true); });
    root.querySelector('#fm-prev-page').addEventListener('click', () => { recordsPage--; renderRecords(true); });
    root.querySelector('#fm-next-page').addEventListener('click', () => { recordsPage++; renderRecords(true); });
    const { eventSource, eventTypes } = ctx;
    for (const name of [
        'CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_UPDATED',
        'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
        'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHARACTER_MESSAGE_RENDERED',
        'TOOL_CALLS_PERFORMED', 'TOOL_CALLS_RENDERED',
    ]) {
        if (!eventTypes[name]) continue;
        eventSource.on(eventTypes[name], (messageIndex) => {
            invalidate();
            if (name === 'GENERATION_STARTED') hostGenerating = true;
            if (name === 'GENERATION_ENDED' || name === 'GENERATION_STOPPED') hostGenerating = false;
            if (name === 'GENERATION_STOPPED') pendingAutoMessages.clear();
            if (name === 'MESSAGE_RECEIVED' && worldEnabled(context()) && settings().enabled && settings().aiKeywordAuto) {
                const message = Number.isInteger(messageIndex) ? context().chat[messageIndex] : context().chat.at(-1);
                if (message && message.role !== 'tool' && !message.is_user && !message.is_system
                    && !(Array.isArray(message.tool_calls) && message.tool_calls.length)) pendingAutoMessages.add(message);
            }
            if (name === 'CHAT_CHANGED' || name === 'CHAT_LOADED') {
                pendingAutoMessages.clear();
                hostGenerating = false;
                recordsPage = 0;
                root.querySelector('#fm-preview-output').textContent = '';
                root.querySelector('#fm-ai-diagnostics').textContent = '';
                renderRecords(true);
            }
            scheduleSync();
        });
    }
    renderRecords();
    scheduleSync();
    status(runtimeLabel() + ' 准备就绪。' + (settings().enabled ? '楼层记忆已启用。' : '配置正则与楼层范围并保存后，打开“启用楼层记忆”开关。'));
}

const ready = document.readyState === 'loading'
    ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();
ready.then(initialize).catch(error => {
    globalThis.toastr?.error?.(error.message, 'world os 初始化失败');
    console.error('[world os] Initialization failed:', error.message);
});
