import { calendarOwner, calendarChat } from './calendar-core.js';
import { plainObject, safeJSON, cloneJSON } from './characters-core.js';
import { worldEnabled } from './world-state.js';

export const LAB_KEY = 'world_os_laboratory';
export const LAB_FORMAT = 'world-os-package';
export const LAB_LIMIT = 8 * 1024 * 1024;
export const LAB_DATA_LIMIT = 256 * 1024;
export const LAB_PERMISSIONS = Object.freeze(['chat.read', 'input.write']);
const reserved = new Set(['home','floor-memory','calendar','characters','snapshot','laboratory','constructor','prototype','__proto__']);
const bytes = text => new TextEncoder().encode(text).length;
export function packageId(id) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id) || id.length > 80 || reserved.has(id)) throw new Error('功能包 ID 需要唯一的英文小写名称，如 demo.notes，且不能占用内置应用名称。');
    return id;
}
export function packagePath(path) {
    if (typeof path !== 'string' || path.length > 160 || !/^[a-zA-Z0-9_./-]+$/.test(path)
        || path.split('/').some(part => !part || ['.','..','__proto__','constructor','prototype'].includes(part))) throw new Error('功能包文件路径无效。');
    return path;
}
export function labData(value) {
    if (!plainObject(value)) throw new Error('功能包设置或状态必须是 JSON 对象。');
    const result = safeJSON(value);
    if (bytes(JSON.stringify(result)) > LAB_DATA_LIMIT) throw new Error('单个功能包的设置或聊天状态不能超过 256 KB。');
    return result;
}
export function validatePackage(value) {
    if (!plainObject(value) || value.format !== LAB_FORMAT || value.schema !== 1) throw new Error('不是受支持的 world os 功能包。');
    const id = packageId(value.id), text = (key,max,required=false) => {
        const val = value[key] ?? '';
        if (typeof val !== 'string' || val.length > max || (required && !val.trim())) throw new Error('功能包字段无效：' + key);
        return val.trim();
    };
    const version = text('version',40,true);
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('功能包版本需要形如 1.0.0。');
    const permissions = value.permissions ?? [];
    if (!Array.isArray(permissions) || permissions.some(p => !LAB_PERMISSIONS.includes(p)) || new Set(permissions).size !== permissions.length) throw new Error('功能包声明了不支持或重复的权限。');
    const entry = packagePath(value.entry ?? 'index.html');
    if (!entry.endsWith('.html') || !plainObject(value.files) || Object.keys(value.files).length > 100) throw new Error('功能包需要 HTML 入口，且最多包含 100 个文件。');
    const files = {};
    for (const [name,content] of Object.entries(value.files)) {
        packagePath(name);
        if (typeof content !== 'string' || content.length > 1900000) throw new Error('功能包文件需要文本，且每个文件不超过 190 万字符。');
        if (/\.(?:html|css|js|json|txt)$/i.test(name)) files[name] = content;
        else if (/\.(?:png|jpe?g|webp|gif)$/i.test(name) && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(content)) files[name] = content;
        else throw new Error('不支持的功能包资源：' + name);
    }
    if (typeof files[entry] !== 'string') throw new Error('找不到功能包入口文件。');
    const icon = value.icon ?? 'fa-puzzle-piece';
    if (typeof icon !== 'string' || !/^fa-[a-z0-9-]{1,40}$/.test(icon)) throw new Error('图标需要 Font Awesome 图标名。');
    const result = { format:LAB_FORMAT,schema:1,id,name:text('name',60,true),version,description:text('description',1000),author:text('author',100),
        icon,permissions:[...permissions],entry,files,defaultSettings:labData(value.defaultSettings ?? {}) };
    if (bytes(JSON.stringify(result)) > LAB_LIMIT) throw new Error('单个功能包展开后不能超过 8 MB。');
    return result;
}
export function validateLabSettings(value) {
    if (!plainObject(value) || (value.schema !== undefined && value.schema !== 1) || !plainObject(value.packages ?? {}) || !plainObject(value.cards ?? {})) throw new Error('实验室配置无效。');
    const packages = {}, cards = {};
    if (Object.keys(value.packages ?? {}).length > 32) throw new Error('最多导入 32 个功能包。');
    for (const [id,pkg] of Object.entries(value.packages ?? {})) {
        if (packageId(id) !== pkg?.id) throw new Error('功能包 ID 与存储项不一致。');
        packages[id] = validatePackage(pkg);
    }
    if (bytes(JSON.stringify(packages)) > 16 * 1024 * 1024) throw new Error('已导入功能包总量不能超过 16 MB。');
    for (const [owner,entries] of Object.entries(value.cards ?? {})) {
        if (!owner || owner.length > 200 || !plainObject(entries)) throw new Error('实验室角色卡设置无效。');
        cards[owner] = {};
        for (const [id,entry] of Object.entries(entries)) {
            packageId(id);
            if (!plainObject(entry) || typeof entry.enabled !== 'boolean') throw new Error('功能包启用状态无效。');
            cards[owner][id] = { enabled:entry.enabled,settings:labData(entry.settings ?? {}) };
        }
    }
    return safeJSON({schema:1,packages,cards});
}
export function validateLabChat(value) {
    if (!plainObject(value) || !plainObject(value.states ?? {})) throw new Error('实验室聊天状态无效。');
    return { states:Object.fromEntries(Object.entries(value.states ?? {}).map(([id,state]) => [packageId(id),labData(state)])) };
}
export const labSettings = ctx => ctx.extensionSettings[LAB_KEY] ?? {schema:1,packages:{},cards:{}};
export const installedPackages = ctx => Object.values(labSettings(ctx).packages ?? {});
export function cardPackage(ctx,id) {
    packageId(id);
    const config = labSettings(ctx), value = config.cards?.[calendarOwner(ctx)]?.[id];
    return { enabled:value?.enabled === true,settings:cloneJSON(value?.settings ?? config.packages?.[id]?.defaultSettings ?? {}) };
}
export const packageActive = (ctx,id) => worldEnabled(ctx) && Boolean(calendarOwner(ctx)) && Boolean(labSettings(ctx).packages?.[id]) && cardPackage(ctx,id).enabled;
function save(ctx,next) {
    const old = ctx.extensionSettings[LAB_KEY];
    ctx.extensionSettings[LAB_KEY] = next;
    try { ctx.saveSettingsDebounced(); } catch (error) { ctx.extensionSettings[LAB_KEY] = old; throw error; }
}
export function installPackage(ctx,input) {
    const pkg = validatePackage(input), old = labSettings(ctx), previous = old.packages?.[pkg.id];
    const added = pkg.permissions.filter(p => !previous?.permissions?.includes(p));
    const cards = { ...old.cards };
    // A package update that adds capabilities requires explicitly enabling it again on each card.
    if (previous && added.length) for (const [owner,entries] of Object.entries(cards)) if (entries[pkg.id]) cards[owner] = { ...entries,[pkg.id]:{...entries[pkg.id],enabled:false} };
    const next = validateLabSettings({schema:1,packages:{...old.packages,[pkg.id]:pkg},cards});
    save(ctx,next); return pkg;
}
export function configurePackage(ctx,id,{ enabled,settings } = {}) {
    packageId(id); const owner = calendarOwner(ctx), old = labSettings(ctx);
    if (!owner || !old.packages?.[id]) throw new Error('请先打开角色卡并导入功能包。');
    const previous = cardPackage(ctx,id);
    const entry = { enabled:enabled === undefined ? previous.enabled : Boolean(enabled),settings:settings === undefined ? previous.settings : labData(settings) };
    save(ctx,{...old,cards:{...old.cards,[owner]:{...old.cards?.[owner],[id]:entry}}});
    return entry;
}
export function uninstallPackage(ctx,id) {
    packageId(id); const old = labSettings(ctx), packages = {...old.packages}, cards = {...old.cards};
    delete packages[id];
    for (const [owner,entries] of Object.entries(cards)) if (entries[id]) cards[owner] = {...entries,[id]:{...entries[id],enabled:false}};
    save(ctx,{...old,packages,cards});
}
export function packageState(ctx,id) { return cloneJSON(ctx.chatMetadata?.[LAB_KEY]?.states?.[packageId(id)] ?? {}); }
export async function savePackageState(ctx,id,value,{getContext=()=>ctx,valid=()=>true}={}) {
    packageId(id); const state = labData(value), scope = calendarChat(ctx), meta = ctx.chatMetadata;
    const current = () => valid() && scope && calendarChat(getContext()) === scope && getContext().chatMetadata === meta && packageActive(getContext(),id);
    if (!current()) throw new Error('功能包已停止或聊天已切换，未保存。');
    const old = meta[LAB_KEY], next = {...old,states:{...old?.states,[id]:state}};
    meta[LAB_KEY] = next;
    try {
        await ctx.saveMetadata();
        if (!current()) throw new Error('保存期间聊天已变化，结果未写入新聊天。');
    } catch (error) {
        if (meta[LAB_KEY] === next) {
            if (old === undefined) delete meta[LAB_KEY]; else meta[LAB_KEY] = old;
            if (getContext().chatMetadata === meta && calendarChat(getContext()) === scope) { try { await ctx.saveMetadata(); } catch {} }
        }
        throw error;
    }
    return cloneJSON(state);
}
