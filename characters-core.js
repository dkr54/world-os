import { calendarOwner, calendarChat } from './calendar-core.js';
import { normalizeText, splitKeywords, compileRegex } from './core.js';
import { validateCGs, isCGMacro, cgPrompt } from './character-cg.js';

export const CHARACTERS_KEY = 'world_os_characters';
export const cloneJSON = value => JSON.parse(JSON.stringify(value));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
export function safeJSON(value, depth = 0) {
    if (depth > 12) throw new Error('JSON 层级不能超过 12 层。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 2000000) return value;
    if (Array.isArray(value) && value.length <= 100000) return value.map(item => safeJSON(item, depth + 1));
    if (plainObject(value) && Object.keys(value).length <= 2000) {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (!key || forbidden.has(key) || key.length > 200) throw new Error('JSON 包含不支持的字段名。');
            output[key] = safeJSON(item, depth + 1);
        }
        return output;
    }
    throw new Error('JSON 包含不支持的值或超出大小限制。');
}
export function validateState(value) {
    if (!plainObject(value)) throw new Error('角色状态必须是 JSON 对象。');
    const state = safeJSON(value);
    if (JSON.stringify(state).length > 500000) throw new Error('单个角色状态过大。');
    if (Object.hasOwn(state, 'relationship')) {
        if (!Array.isArray(state.relationship)) throw new Error('relationship 必须是对象数组。');
        const names = new Set();
        for (const item of state.relationship) {
            if (!plainObject(item) || Object.keys(item).length !== 1) throw new Error('每个关系项需要一个角色名和一段描述。');
            const [name, description] = Object.entries(item)[0];
            if (names.has(name) || !name.trim() || typeof description !== 'string') throw new Error('关系名重复或关系描述不是文本。');
            names.add(name);
        }
    }
    return state;
}
export const DEFAULT_CHARACTER_STATE = Object.freeze({ age:20,heigh:'165cm',affection:0,relationship:Object.freeze([]) });
export function defaultCharacterState(ctx) {
    const owner = calendarOwner(ctx);
    const template = ctx.extensionSettings?.[CHARACTERS_KEY]?.defaultStates?.[owner] ?? DEFAULT_CHARACTER_STATE;
    return validateState(template);
}
export function saveDefaultCharacterState(ctx, value) {
    const owner = calendarOwner(ctx);
    if (!owner) throw new Error('请先打开角色卡，再设置默认状态。');
    const template = validateState(value), config = ctx.extensionSettings[CHARACTERS_KEY] ?? {};
    ctx.extensionSettings[CHARACTERS_KEY] = { ...config,defaultStates:{ ...config.defaultStates,[owner]:template } };
    ctx.saveSettingsDebounced();
}
export function statePath(path) {
    if (typeof path !== 'string' || !path || path.length > 500) throw new Error('状态路径无效。');
    const parts = path.startsWith('relationship.') ? ['relationship', path.slice(13)] : path.split('.');
    if (parts.some(part => !part || forbidden.has(part) || /[\r\n{}]/.test(part))) throw new Error('状态路径无效。');
    return parts;
}
export function getStateValue(state, path) {
    const parts = statePath(path);
    if (parts[0] === 'relationship' && parts.length === 2) {
        return state.relationship?.find(item => Object.hasOwn(item, parts[1]))?.[parts[1]];
    }
    let value = state;
    for (const part of parts) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
    }
    return value;
}
export function stateFields(state, prefix = '') {
    const fields = [];
    for (const [key, value] of Object.entries(state)) {
        const path = prefix + key;
        if (path === 'relationship') {
            for (const item of value) for (const [name, description] of Object.entries(item)) fields.push({ path:'relationship.' + name, value:description });
        } else if (plainObject(value) || Array.isArray(value)) fields.push(...stateFields(value, path + '.'));
        else fields.push({ path, value });
    }
    return fields;
}
export const CONDITION_OPS = ['>=', '>', '<=', '<', '==', '!=', 'contains', 'exists', 'missing'];
export function matchesCondition(state, condition) {
    const actual = getStateValue(state, condition.path), expected = condition.value;
    switch (condition.op) {
        case 'exists': return actual !== undefined;
        case 'missing': return actual === undefined;
        case '==': return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected);
        case '!=': return actual !== undefined && JSON.stringify(actual) !== JSON.stringify(expected);
        case 'contains': return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
        default:
            if (typeof actual !== 'number' || typeof expected !== 'number') return false;
            if (condition.op === '>=') return actual >= expected;
            if (condition.op === '>') return actual > expected;
            if (condition.op === '<=') return actual <= expected;
            if (condition.op === '<') return actual < expected;
            return false;
    }
}
export function selectedStage(character, state) {
    return character.stages.findLast(stage => stage.conditions.every(condition => matchesCondition(state, condition))) ?? null;
}
export function renderCharacter(character, state) {
    const stage = selectedStage(character, state);
    const template = [character.description, stage?.content].filter(Boolean).join('\n\n');
    const content = template.replace(/\{\{([^{}]+)\}\}/g, (match, path) => {
        path = path.trim();
        if (['user', 'char'].includes(path) || isCGMacro(match)) return match;
        let value;
        try { value = getStateValue(state, path); } catch { return ''; }
        return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    });
    return { id:character.id, cgId:character.cgId, cgs:character.cgs ?? [], name:character.name, stage:stage?.name ?? '基础设定', content, state:cloneJSON(state) };
}
export function validateCharacter(input) {
    const value = safeJSON(input);
    if (!plainObject(value) || typeof value.id !== 'string' || !/^[\w-]{1,100}$/.test(value.id)) throw new Error('角色标识无效。');
    const name = String(value.name ?? '').trim();
    if (!name || name.length > 100 || /[\r\n<>]/.test(name)) throw new Error('角色名需要 1～100 字且不包含换行或尖括号。');
    const avatar = String(value.avatar ?? '');
    if (avatar && !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(avatar)) {
        let url;
        try { url = new URL(avatar); } catch { throw new Error('头像需要 HTTP(S) 图片地址，或上传一张图片。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('头像地址不支持此格式。');
    }
    if (avatar.length > 2000000) throw new Error('头像过大，请使用较小的图片。');
    if (value.cgId !== undefined && value.cgId !== null && (!Number.isSafeInteger(value.cgId) || value.cgId < 0 || value.cgId >= Number.MAX_SAFE_INTEGER)) throw new Error('角色数字 ID 必须是非负安全整数。');
    const cgs = validateCGs(value.cgs);
    const baseState = validateState(value.baseState ?? {});
    const policies = value.policies ?? [];
    const seen = new Set();
    if (!Array.isArray(policies) || policies.length > 2000) throw new Error('状态权限格式无效。');
    for (const policy of policies) {
        statePath(policy.path);
        if (seen.has(policy.path)) throw new Error('状态权限路径重复：' + policy.path);
        seen.add(policy.path);
        if (policy.path.includes('*') && policy.path !== 'relationship.*') throw new Error('仅 relationship.* 支持关系条目的通配权限。');
        if (!Array.isArray(policy.allow) || policy.allow.some(op => !['add', 'update', 'delete'].includes(op))) throw new Error('状态权限仅支持 add、update、delete。');
        if (!['string', 'number', 'boolean', 'object', 'array', 'null'].includes(policy.type)) throw new Error('请选择状态值类型。');
    }
    const stages = value.stages ?? [];
    if (!Array.isArray(stages) || stages.length > 100) throw new Error('阶段数量不能超过 100。');
    const stageIds = new Set();
    for (const stage of stages) {
        if (typeof stage.id !== 'string' || !stage.id || stageIds.has(stage.id) || typeof stage.name !== 'string' || typeof stage.content !== 'string') throw new Error('阶段标识或内容无效。');
        stageIds.add(stage.id);
        if (!Array.isArray(stage.conditions) || stage.conditions.length > 50) throw new Error('阶段条件无效。');
        for (const condition of stage.conditions) {
            statePath(condition.path);
            if (!CONDITION_OPS.includes(condition.op)) throw new Error('阶段比较方式无效。');
            if (!['exists', 'missing'].includes(condition.op)) safeJSON(condition.value);
        }
    }
    return { id:value.id, cgId:value.cgId ?? null, cgs, name, sortName:String(value.sortName ?? '').trim(), avatar,
        keywords:splitKeywords(String(value.keywords ?? '')), description:String(value.description ?? ''),
        baseState, policies:cloneJSON(policies), stages:cloneJSON(stages), enabled:value.enabled !== false };
}
export function validateDirectory(value, firstId = 0) {
    if (!Array.isArray(value) || value.length > 1000) throw new Error('角色目录最多支持 1000 个角色。');
    const ids = new Set(), numbers = new Set();
    const characters = value.map(item => {
        const character = validateCharacter({ ...item, keywords:Array.isArray(item.keywords) ? item.keywords.join(',') : item.keywords });
        if (ids.has(character.id)) throw new Error('同一张角色卡下不能有重复的角色标识。');
        ids.add(character.id);
        if (character.cgId !== null) {
            if (numbers.has(character.cgId)) throw new Error('角色数字 ID 不能重复。');
            numbers.add(character.cgId);
        }
        return character;
    });
    let next = Math.max(firstId,...characters.map(item => (item.cgId ?? -1) + 1));
    for (const character of characters) if (character.cgId === null) {
        if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) throw new Error('角色数字 ID 已超出范围。');
        character.cgId = next++;
    }
    return characters;
}
export function nextCharacterID(ctx) {
    const owner = calendarOwner(ctx), config = ctx.extensionSettings?.[CHARACTERS_KEY];
    return Math.max(config?.nextIds?.[owner] ?? 0,...(config?.cards?.[owner] ?? []).map(item => (item.cgId ?? -1) + 1));
}
/** Upgrade legacy definitions once without changing internal IDs or per-chat state keys. */
export function ensureCharacterIDs(ctx) {
    const config = ctx.extensionSettings?.[CHARACTERS_KEY];
    if (!config?.cards) return;
    let changed = false;
    const cards = { ...config.cards }, nextIds = { ...config.nextIds };
    for (const [owner,items] of Object.entries(cards)) {
        const first = Number.isSafeInteger(nextIds[owner]) && nextIds[owner] >= 0 ? nextIds[owner] : 0;
        if (items.some(item => item.cgId === undefined || item.cgId === null || !Array.isArray(item.cgs))) {
            cards[owner] = validateDirectory(items,first); changed = true;
        }
        const next = Math.max(first,...cards[owner].map(item => item.cgId + 1));
        if (nextIds[owner] !== next) { nextIds[owner] = next; changed = true; }
    }
    if (changed) {
        ctx.extensionSettings[CHARACTERS_KEY] = { ...config,cards,nextIds };
        ctx.saveSettingsDebounced();
    }
}
const EMPTY_DIRECTORY = [];
export function directoryOf(ctx) { return ctx.extensionSettings?.[CHARACTERS_KEY]?.cards?.[calendarOwner(ctx)] ?? EMPTY_DIRECTORY; }
export function characterTag(character, directory = []) {
    return directory.filter(item => item.name === character.name).length > 1 ? character.cgId + '_' + character.name : character.name;
}
export function characterPrompt(item) {
    const tag = item.tag ?? item.name;
    return item.content.trim() ? '<' + tag + '>\n' + item.content + '\n</' + tag + '>' : '';
}
/** Count the assembled segment using the current host tokenizer, with no extra padding. */
export async function characterTokenCount(ctx, item) {
    let text = characterPrompt(item);
    if (!text) return 0;
    // renderCharacter deliberately preserves these two standard host macros.
    text = text.replace(/\{\{(user|char)\}\}/gi,(_,name) => String(name.toLowerCase() === 'user' ? ctx.name1 ?? '' : ctx.name2 ?? ''));
    const count = typeof ctx.getTokenCountAsync === 'function' ? await ctx.getTokenCountAsync(text,0)
        : typeof ctx.getTokenCount === 'function' ? await ctx.getTokenCount(text,0) : null;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('宿主未能返回有效的 Token 数。');
    return count;
}
export function currentState(ctx, character) {
    return cloneJSON(ctx.chatMetadata?.[CHARACTERS_KEY]?.states?.[character.id] ?? character.baseState);
}
export function recentCharacterQuery(chat) {
    return (chat ?? []).filter(message => !message.is_system && message.role !== 'tool'
        && !(message.extra?.tool_invocations?.length) && typeof message.mes === 'string' && message.mes.trim())
        .slice(-2).map(message => message.mes).join('\n\n');
}
export function validateCharacterQueryCleanup(value = {}) {
    if (!plainObject(value)) throw new Error('角色查询清洗设置无效。');
    const rule = { pattern:value.pattern ?? '',flags:value.flags ?? 'gi',replacement:value.replacement ?? '' };
    if (Object.values(rule).some(text => typeof text !== 'string' || text.length > 10000)) throw new Error('查询清洗规则需要文本，且每项不超过 10000 字。');
    if (rule.pattern) {
        try { compileRegex(rule.pattern,rule.flags); }
        catch (error) { throw new Error('角色查询清洗正则：' + error.message); }
    }
    return rule;
}
export function selectCharacters(ctx, chat = ctx.chat, query = recentCharacterQuery(chat)) {
    const normalized = normalizeText(query);
    const directory = directoryOf(ctx);
    const items = directory.filter(character => character.enabled !== false && character.keywords?.some(keyword =>
        keyword.trim() && normalized.includes(normalizeText(keyword)))).map(character => ({ ...renderCharacter(character, currentState(ctx, character)),tag:characterTag(character,directory) }));
    return { scope:calendarChat(ctx), query, items,
        content:items.map(characterPrompt).filter(Boolean).join('\n\n'), cgContent:cgPrompt(items) };
}
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity:'base', numeric:true });
export function sortedCharacters(characters) {
    return [...characters].sort((a,b) => {
        const left = characterInitial(a), right = characterInitial(b);
        if (left !== right) return left === '#' ? 1 : right === '#' ? -1 : left.charCodeAt(0) - right.charCodeAt(0);
        return collator.compare(a.sortName || a.name, b.sortName || b.name);
    });
}
export function characterInitial(character) {
    const text = character.sortName || character.name;
    if (/^[a-z]/i.test(text)) return text[0].toUpperCase();
    if (!/^[\u3400-\u9fff]/.test(text)) return '#';
    const boundaries = [['A','阿'],['B','八'],['C','擦'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']];
    return boundaries.findLast(([,word]) => collator.compare(text, word) >= 0)?.[0] ?? 'A';
}
function permission(character, path) {
    return character.policies.find(item => item.path === path)
        ?? (path.startsWith('relationship.') ? character.policies.find(item => item.path === 'relationship.*') : undefined);
}
/** No inferred operations, unknown targets, type coercion, or parent replacement that bypasses child permissions. */
export function applyStateOperations(characters, states, operations) {
    if (!Array.isArray(operations) || operations.length > 1000) throw new Error('AI 状态结果必须包含 operations 数组，且不超过 1000 项。');
    const result = cloneJSON(states), accepted = [], ignored = [], touched = new Set();
    const byId = new Map(characters.map(character => [character.id, character]));
    for (const operation of operations) {
        const reject = reason => ignored.push({ operation:cloneJSON(operation ?? null), reason });
        try {
            if (!plainObject(operation) || !['add','update','delete'].includes(operation.op)) { reject('不允许的操作'); continue; }
            if (Object.keys(operation).some(key => !['op','characterId','path','value'].includes(key))) { reject('包含未知指令字段'); continue; }
            const character = byId.get(operation.characterId);
            if (!character || !Object.hasOwn(result, character.id)) { reject('角色未被本次调用'); continue; }
            const parts = statePath(operation.path), old = getStateValue(result[character.id], operation.path);
            const policy = permission(character, operation.path);
            const allow = policy?.allow ?? ['update'];
            if (!allow.includes(operation.op)) { reject('此状态未开放 ' + operation.op); continue; }
            if ((operation.op === 'add') !== (old === undefined)) { reject(operation.op === 'add' ? '字段已存在' : '字段不存在'); continue; }
            const key = character.id + '\n' + operation.path;
            if (touched.has(key)) { reject('同一结果重复修改同一字段'); continue; }
            if (operation.op !== 'delete') {
                if (!Object.hasOwn(operation, 'value')) { reject('缺少 value'); continue; }
                safeJSON(operation.value);
                const requiredType = old === undefined ? policy?.type : valueType(old);
                if (valueType(operation.value) !== requiredType || (policy && policy.type !== valueType(operation.value))) { reject('值类型不符'); continue; }
                if (operation.op === 'update' && typeof old === 'object' && old !== null) { reject('请修改具体子字段，不能整体替换对象或数组'); continue; }
            } else if (Object.hasOwn(operation, 'value')) { reject('delete 不应携带 value'); continue; }
            const next = cloneJSON(result[character.id]);
            if (parts[0] === 'relationship' && parts.length === 2) {
                if (operation.op !== 'delete' && typeof operation.value !== 'string') { reject('关系描述必须是文本'); continue; }
                if (!next.relationship) next.relationship = [];
                const index = next.relationship.findIndex(item => Object.hasOwn(item, parts[1]));
                if (operation.op === 'add') next.relationship.push({ [parts[1]]:operation.value });
                else if (operation.op === 'delete') next.relationship.splice(index,1);
                else next.relationship[index][parts[1]] = operation.value;
            } else {
                if (operation.path === 'relationship') { reject('请通过 relationship.角色名 修改关系'); continue; }
                let parent = next;
                for (const part of parts.slice(0,-1)) {
                    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent,part)) throw new Error('父字段不存在');
                    parent = parent[part];
                }
                if (!plainObject(parent) && !Array.isArray(parent)) { reject('父字段不是对象'); continue; }
                if (Array.isArray(parent) && (operation.op !== 'update' || !/^(0|[1-9]\d*)$/.test(parts.at(-1)))) { reject('数组仅支持更新现有元素'); continue; }
                if (operation.op === 'delete') delete parent[parts.at(-1)];
                else parent[parts.at(-1)] = cloneJSON(operation.value);
            }
            result[character.id] = validateState(next);
            touched.add(key); accepted.push(cloneJSON(operation));
        } catch (error) { reject(error.message); }
    }
    return { states:result, accepted, ignored };
}
export function relationshipsOf(characters, states) {
    const byName = new Map(characters.filter(character => characters.filter(item => item.name === character.name).length === 1).map(character => [character.name, character.id]));
    return characters.flatMap(character => (states[character.id]?.relationship ?? []).flatMap(item =>
        Object.entries(item).map(([name, description]) => ({ source:character.id, target:byName.get(name) ?? null, name, description }))));
}
export function stateDifference(before, after) {
    const left = new Map(stateFields(before).map(item => [item.path,item.value]));
    const right = new Map(stateFields(after).map(item => [item.path,item.value]));
    return [...new Set([...left.keys(),...right.keys()])].filter(path => JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path)))
        .map(path => ({ path, before:left.get(path), after:right.get(path) }));
}
