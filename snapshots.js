import { MODULE_KEY, normalizeSettings } from './core.js';
import { CALENDAR_KEY, calendarOwner, calendarChat, validateCalendar, validateDate, DEFAULT_CALENDAR } from './calendar-core.js';
import { CHARACTERS_KEY, safeJSON, plainObject, cloneJSON, validateDirectory, validateState, validateCharacterQueryCleanup } from './characters-core.js';
import { validateCGFloors } from './character-cg.js';
import { validateStateAPI } from './character-api.js';
import { WORLD_KEY, announceWorldChange } from './world-state.js';
import { downloadMemory } from './host-runtime.js';

const SETTINGS_KEYS = [WORLD_KEY,MODULE_KEY,CALENDAR_KEY,CHARACTERS_KEY];
const CHAT_KEYS = [MODULE_KEY,CALENDAR_KEY,CHARACTERS_KEY];
const SECRET_PATHS = [
    [MODULE_KEY,'apiKey'],[MODULE_KEY,'rerankApiKey'],[MODULE_KEY,'aiKeywordApiKey'],[CHARACTERS_KEY,'api','apiKey'],
];
function secretContainer(settings, path, create = false) {
    let current = settings;
    for (const part of path.slice(0,-1)) {
        if (current[part] === null || current[part] === undefined) {
            if (!create) return null;
            current[part] = {};
        }
        current = current[part];
    }
    return current;
}
export function createSnapshot(ctx, includeKeys = false) {
    const owner = calendarOwner(ctx), scope = calendarChat(ctx);
    if (!owner || !scope) throw new Error('请先打开要保存状态的聊天。');
    const settings = Object.fromEntries(SETTINGS_KEYS.map(key => [key,cloneJSON(ctx.extensionSettings[key] ?? null)]));
    const metadata = Object.fromEntries(CHAT_KEYS.map(key => [key,cloneJSON(ctx.chatMetadata[key] ?? null)]));
    if (!includeKeys) for (const path of SECRET_PATHS) { const container = secretContainer(settings,path); if (container) delete container[path.at(-1)]; }
    return { format:'world-os-snapshot',schema:1,createdAt:new Date().toISOString(),owner,scope,includeKeys:Boolean(includeKeys),
        settings,metadata };
}
export function validateSnapshot(input) {
    const data = safeJSON(input);
    if (!plainObject(data) || data.format !== 'world-os-snapshot' || data.schema !== 1) throw new Error('这不是受支持的 world os 快照。');
    if (typeof data.owner !== 'string' || typeof data.scope !== 'string' || typeof data.createdAt !== 'string'
        || typeof data.includeKeys !== 'boolean' || !plainObject(data.settings) || !plainObject(data.metadata)) throw new Error('快照头或数据格式无效。');
    const [owner,chatId] = JSON.parse(data.scope);
    if (owner !== data.owner || chatId === null || chatId === undefined || chatId === '') throw new Error('快照聊天标识无效。');
    if (Object.keys(data.settings).some(key => !SETTINGS_KEYS.includes(key)) || SETTINGS_KEYS.some(key => !Object.hasOwn(data.settings,key))
        || Object.keys(data.metadata).some(key => !CHAT_KEYS.includes(key)) || CHAT_KEYS.some(key => !Object.hasOwn(data.metadata,key))) throw new Error('快照包含未知模块或缺少模块。');
    const global = data.settings[WORLD_KEY];
    if (global !== null && (!plainObject(global) || (global.enabled !== undefined && typeof global.enabled !== 'boolean'))) throw new Error('总开关配置无效。');
    const memory = data.settings[MODULE_KEY];
    if (memory !== null) { if (!plainObject(memory)) throw new Error('楼层记忆设置无效。'); normalizeSettings(memory); }
    const calendar = data.settings[CALENDAR_KEY];
    if (calendar !== null) {
        if (!plainObject(calendar.cards)) throw new Error('日历快照无效。');
        for (const [key,value] of Object.entries(calendar.cards)) calendar.cards[key] = validateCalendar(value);
    }
    const directory = data.settings[CHARACTERS_KEY];
    if (directory !== null) {
        if (directory.cards !== undefined && !plainObject(directory.cards)) throw new Error('角色目录快照无效。');
        if (directory.defaultStates !== undefined) {
            if (!plainObject(directory.defaultStates)) throw new Error('默认状态模板无效。');
            for (const [key,value] of Object.entries(directory.defaultStates)) directory.defaultStates[key] = validateState(value);
        }
        if (directory.nextIds !== undefined && (!plainObject(directory.nextIds) || Object.values(directory.nextIds).some(value => !Number.isSafeInteger(value) || value < 0))) throw new Error('角色 ID 计数器无效。');
        if (directory.cgRenderCount !== undefined) validateCGFloors(directory.cgRenderCount);
        directory.nextIds = directory.nextIds ?? {};
        for (const [key,value] of Object.entries(directory.cards ?? {})) {
            directory.cards[key] = validateDirectory(value,directory.nextIds[key] ?? 0);
            directory.nextIds[key] = Math.max(directory.nextIds[key] ?? 0,...directory.cards[key].map(item => item.cgId + 1));
        }
        if (directory.api !== undefined) validateStateAPI(directory.api);
        if (directory.queryCleanup !== undefined) directory.queryCleanup = validateCharacterQueryCleanup(directory.queryCleanup);
    }
    const date = data.metadata[CALENDAR_KEY];
    if (date !== null) validateDate(date.date,validateCalendar(calendar?.cards?.[data.owner] ?? DEFAULT_CALENDAR).months);
    const records = data.metadata[MODULE_KEY];
    if (records !== null && (!Array.isArray(records.records) || records.records.some(record =>
        !plainObject(record) || typeof record.id !== 'string' || !Number.isInteger(record.floor) || record.floor < 1
        || (record.keywords !== undefined && (!Array.isArray(record.keywords) || record.keywords.some(word => typeof word !== 'string')))))) throw new Error('楼层记忆记录无效。');
    if (records) {
        const ids = new Set(), floors = new Set();
        for (const record of records.records) {
            if (ids.has(record.id) || floors.has(record.floor) || ['name','rules','extracted','override','keywordText','keywordSource','keywordSummaryHash']
                .some(key => record[key] !== undefined && typeof record[key] !== 'string')) throw new Error('楼层记忆包含重复楼号或无效文本。');
            ids.add(record.id); floors.add(record.floor);
        }
    }
    const states = data.metadata[CHARACTERS_KEY];
    if (states !== null) {
        if (!plainObject(states.states)) throw new Error('聊天角色状态无效。');
        for (const value of Object.values(states.states)) validateState(value);
        if (states.lastCalled !== undefined && (!Array.isArray(states.lastCalled) || states.lastCalled.some(item => typeof item !== 'string'))) throw new Error('角色调用记录无效。');
        // Debug text is optional, derived data. Do not trust imported report structure.
        if (states.debug) {
            const report = states.debug;
            if (!plainObject(report) || !Array.isArray(report.matched) || !plainObject(report.previous) || !plainObject(report.current)
                || typeof report.query !== 'string' || typeof report.reply !== 'string' || typeof report.status !== 'string'
                || report.matched.some(item => typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.stage !== 'string')) throw new Error('调试记录无效。');
            for (const value of [...Object.values(report.previous),...Object.values(report.current)]) validateState(value);
        }
    }
    return data;
}
export async function restoreSnapshot(input, ctx, { allowOtherChat = false, getContext = () => ctx, beforeRestore = () => {} } = {}) {
    const data = validateSnapshot(input), scope = calendarChat(ctx);
    if (!scope || calendarOwner(ctx) !== data.owner) throw new Error('请打开快照所属的角色卡后恢复。');
    if (scope !== data.scope && !allowOtherChat) throw new Error('快照来自其他聊天，请确认“允许恢复到另一个聊天”。');
    beforeRestore();
    const oldSettings = Object.fromEntries(SETTINGS_KEYS.map(key => [key,ctx.extensionSettings[key]]));
    const oldMetadata = Object.fromEntries(CHAT_KEYS.map(key => [key,ctx.chatMetadata[key]]));
    const nextSettings = Object.fromEntries(SETTINGS_KEYS.map(key => [key,
        data.settings[key] === null ? undefined : cloneJSON(data.settings[key])]));
    if (!data.includeKeys) for (const path of SECRET_PATHS) {
        const existing = secretContainer(ctx.extensionSettings,path);
        const value = existing?.[path.at(-1)];
        if (value !== undefined && value !== '') secretContainer(nextSettings,path,true)[path.at(-1)] = value;
    }
    const nextMetadata = Object.fromEntries(CHAT_KEYS.map(key => [key,data.metadata[key] === null ? undefined : cloneJSON(data.metadata[key])]));
    const write = (object,values) => { for (const [key,value] of Object.entries(values)) if (value === undefined) delete object[key]; else object[key] = value; };
    // Save current chat first; settings only become durable once chat persistence succeeds.
    write(ctx.chatMetadata,nextMetadata);
    try {
        await ctx.saveMetadata();
        if (getContext().chatMetadata !== ctx.chatMetadata || calendarChat(getContext()) !== scope) throw new Error('保存期间聊天已切换；快照未恢复到新聊天。请返回原聊天检查。');
        if (CHAT_KEYS.some(key => ctx.chatMetadata[key] !== nextMetadata[key])) throw new Error('恢复期间状态再次被修改，本次恢复已停止。');
        write(ctx.extensionSettings,nextSettings); ctx.saveSettingsDebounced();
    } catch (error) {
        for (const key of CHAT_KEYS) if (ctx.chatMetadata[key] === nextMetadata[key]) {
            if (oldMetadata[key] === undefined) delete ctx.chatMetadata[key]; else ctx.chatMetadata[key] = oldMetadata[key];
        }
        for (const key of SETTINGS_KEYS) if (ctx.extensionSettings[key] === nextSettings[key]) {
            if (oldSettings[key] === undefined) delete ctx.extensionSettings[key]; else ctx.extensionSettings[key] = oldSettings[key];
        }
        if (getContext().chatMetadata === ctx.chatMetadata && calendarChat(getContext()) === scope) {
            try { await ctx.saveMetadata(); } catch { /* The original persistence error is shown. */ }
        }
        throw error;
    }
    return data;
}
export function mountSnapshots(root, { getContext }) {
    const page = root.querySelector('#wo-snapshot'), find = name => page.querySelector('#wo-snapshot-' + name);
    let imported = null, busy = false;
    const status = message => { find('status').textContent = message; };
    const scopeText = () => {
        const ctx = getContext();
        find('scope').textContent = calendarChat(ctx) ? '当前角色：' + (ctx.characters?.[ctx.characterId]?.name || ctx.name2 || '群聊')
            + ' · 聊天：' + (ctx.chatId ?? ctx.getCurrentChatId?.()) : '尚未打开聊天';
    };
    async function action(fn) {
        if (busy) return; busy = true;
        for (const button of page.querySelectorAll('button')) button.disabled = true;
        try { await fn(); } catch (error) { status(error.message); }
        finally { busy = false; find('export').disabled = false; find('restore').disabled = !imported; }
    }
    find('export').addEventListener('click',() => void action(async () => {
        const data = createSnapshot(getContext(),find('keys').checked);
        if (new Blob([JSON.stringify(data)]).size > 32*1024*1024) throw new Error('当前快照超过 32 MB，请缩小角色头像后导出。');
        const result = await downloadMemory(data,'world-os-snapshot-' + new Date().toISOString().replace(/[:.]/g,'-') + '.json');
        status('快照已导出。' + (result?.savedPath ? '\n保存位置：' + result.savedPath : ''));
    }));
    find('file').addEventListener('change',() => void action(async () => {
        imported = null; find('preview').textContent = '';
        const file = find('file').files[0]; if (!file) return;
        if (file.size > 32*1024*1024) throw new Error('快照文件不能超过 32 MB。');
        const text = await file.text();
        imported = validateSnapshot(JSON.parse(text));
        find('preview').textContent = '保存时间：' + new Date(imported.createdAt).toLocaleString() + '\n角色卡：' + imported.owner.replace(/^(character|group):/,'') + '\n聊天：' + JSON.parse(imported.scope)[1]
            + '\n密钥：' + (imported.includeKeys ? '包含已保存的密钥' : '不包含，恢复时保留本机已有密钥')
            + '\n角色状态：' + Object.keys(imported.metadata[CHARACTERS_KEY]?.states ?? {}).length + ' 个'
            + '\n楼层记忆：' + (imported.metadata[MODULE_KEY]?.records?.length ?? 0) + ' 楼';
        status('快照已校验。确认所示范围后，点击“恢复所选快照”。');
    }));
    find('restore').addEventListener('click',() => void action(async () => {
        if (!imported) return;
        await restoreSnapshot(imported,getContext(),{ getContext,allowOtherChat:find('other-chat').checked,
            beforeRestore:() => announceWorldChange('before-restore') });
        announceWorldChange('restore'); status('快照已恢复。当前输入框与聊天原文保持原样。'); scopeText();
    }));
    root.addEventListener('world-os:page',event => { if (event.detail.name === 'snapshot') scopeText(); });
    scopeText();
}
