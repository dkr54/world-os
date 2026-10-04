export const CALENDAR_KEY = 'world_os_calendar';
export const CALENDAR_WORLD = '__world_os_calendar__';
export const DEFAULT_CALENDAR = Object.freeze({
    name: '', enabled: true,
    months: Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]),
    holidays: Object.freeze([]),
});
const integer = (value, label, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(label + '必须是 ' + min + '～' + max + ' 的整数。');
    return number;
};
export function calendarOwner(ctx) {
    if (ctx.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '') return 'group:' + ctx.groupId;
    const avatar = ctx.characters?.[ctx.characterId]?.avatar;
    return avatar ? 'character:' + avatar : '';
}
export function calendarChat(ctx) {
    const id = ctx.chatId ?? ctx.getCurrentChatId?.();
    const owner = calendarOwner(ctx);
    return owner && id !== undefined && id !== null && id !== '' ? JSON.stringify([owner, id]) : '';
}
export function validateDate(date, months) {
    const year = integer(date?.year, '年份');
    const month = integer(date?.month, '月份', 1, months.length);
    const day = integer(date?.day, '日期', 1, months[month - 1]);
    return { year, month, day };
}
export function parseMonthDays(text, count) {
    let months;
    try { months = JSON.parse(text); } catch { throw new Error('每月天数需要填写数组，例如 [30,31,30]。'); }
    count = integer(count, '每年月份数', 1, 1000);
    if (!Array.isArray(months) || months.length !== count) throw new Error('月份数与天数数组长度不一致：需要 ' + count + ' 个数字。');
    return months.map((days, index) => integer(days, '第 ' + (index + 1) + ' 月天数', 1, 1000000));
}
export function validateCalendar(value = DEFAULT_CALENDAR) {
    if (!Array.isArray(value.months) || !value.months.length || value.months.length > 1000) throw new Error('日历需要 1～1000 个月。');
    const months = value.months.map((days, index) => integer(days, '第 ' + (index + 1) + ' 月天数', 1, 1000000));
    if (!Array.isArray(value.holidays)) throw new Error('节日列表格式不正确。');
    const ids = new Set();
    const holidays = value.holidays.map(item => {
        if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('节日标识缺失或重复。');
        ids.add(item.id);
        const name = String(item.name ?? '').trim();
        if (!name) throw new Error('请填写节日名称。');
        const year = item.year === null || item.year === '' || item.year === undefined ? null : integer(item.year, '节日年份');
        const date = validateDate({ year: year ?? 1, month: item.month, day: item.day }, months);
        return { id: item.id, name, year, month: date.month, day: date.day, prompt: String(item.prompt ?? '') };
    });
    return { schema: 1, name: String(value.name ?? '').trim(), enabled: value.enabled !== false, months, holidays };
}
export function readCalendar(ctx) {
    const value = ctx.extensionSettings?.[CALENDAR_KEY]?.cards?.[calendarOwner(ctx)];
    return validateCalendar(value ?? DEFAULT_CALENDAR);
}
export function rawChatDate(ctx) {
    return ctx.chatMetadata?.[CALENDAR_KEY]?.date ?? { year: 1, month: 1, day: 1 };
}
export function holidaysOn(calendar, date) {
    return calendar.holidays.filter(item => item.month === date.month && item.day === date.day && (item.year === null || item.year === date.year));
}
/** Fixed custom month lengths; arithmetic skips whole years without iterating through days. */
export function advanceDate(date, days, months) {
    date = validateDate(date, months);
    days = integer(days, '过去天数', 0);
    const yearDays = months.reduce((sum, value) => sum + value, 0);
    let ordinal = (date.year - 1) * yearDays + date.day - 1 + days;
    for (let month = 0; month < date.month - 1; month++) ordinal += months[month];
    if (!Number.isSafeInteger(ordinal)) throw new Error('日期超出可精确计算的范围，请减小年份或过去天数。');
    const year = Math.floor(ordinal / yearDays) + 1;
    if (!Number.isSafeInteger(year)) throw new Error('年份超出可精确计算的范围。');
    let remaining = ordinal % yearDays, month = 1;
    while (remaining >= months[month - 1]) { remaining -= months[month - 1]; month++; }
    return { year, month, day: remaining + 1 };
}
export function formatDate(calendar, date) {
    return calendar.name + date.year + '年' + date.month + '月' + date.day + '日';
}
export function advancePrompt(calendar, date, days) {
    const names = holidaysOn(calendar, date).map(item => item.name);
    return integer(days, '过去天数', 0) + '天过后，' + formatDate(calendar, date) + (names.length ? '\n' + names.join('、') : '');
}
export function prependPrompt(prefix, original) {
    return prefix + '\n' + original;
}
export function holidayPrompt(calendar, date) {
    const holidays = holidaysOn(calendar, date).filter(item => item.prompt.trim());
    if (!calendar.enabled || !holidays.length) return '';
    return '\n\n' + holidays.map(item => '<' + item.name + '>\n' + item.prompt + '\n</' + item.name + '>').join('\n\n') + '\n\n';
}
export function calendarSnapshot(ctx) {
    const scope = calendarChat(ctx);
    if (!scope) return null;
    const calendar = readCalendar(ctx);
    const date = validateDate(rawChatDate(ctx), calendar.months);
    const content = holidayPrompt(calendar, date);
    return content ? { scope, content, revision: JSON.stringify([calendar, date]) } : null;
}
function ownEntry(entry) { return entry?.world === CALENDAR_WORLD && entry.uid === -1; }
/**
 * A disabled, empty scan seed ensures the final-scan hook also runs without any lorebooks.
 * It never activates, consumes no prompt budget, and never enters recursive matching.
 */
export function addCalendarScanSeed(data, snapshot) {
    for (const name of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const entries = data?.[name];
        if (!Array.isArray(entries)) continue;
        for (let i = entries.length - 1; i >= 0; i--) if (ownEntry(entries[i])) entries.splice(i, 1);
    }
    if (!snapshot || !Array.isArray(data?.chatLore)) return;
    data.chatLore.push({
        world: CALENDAR_WORLD, uid: -1, key: [], keysecondary: [], content: '', comment: 'world os 日历',
        disable: true, constant: false, order: 0, position: 1, sticky: null, cooldown: null, delay: null,
        calendarSnapshot: snapshot,
    });
}
/** Mutate only the transient scan result; never the saved lorebooks or scanning budget. */
export function finishCalendarScan(args, current, substitute = value => value) {
    if (!(args?.activated?.entries instanceof Map)) return;
    const entries = args.activated.entries;
    for (const [key, entry] of entries) if (ownEntry(entry)) entries.delete(key);
    // Without real lore entries the host would normally return immediately.
    // Do not make its minimum-activation search walk the chat for our empty seed.
    if (args.sortedEntries?.length === 1 && ownEntry(args.sortedEntries[0]) && args.state) args.state.next = 0;
    if (args.state?.next !== 0 || !current) return;
    const seed = args.sortedEntries?.find(ownEntry);
    const snapshot = seed?.calendarSnapshot;
    if (!snapshot || snapshot.scope !== current.scope || snapshot.revision !== current.revision) return;
    let order = 1000;
    for (const entry of entries.values()) if (Number.isFinite(entry.order)) order = Math.max(order, entry.order);
    const content = substitute(snapshot.content);
    if (!content) return;
    entries.set(CALENDAR_WORLD + '.-1', {
        ...seed, calendarSnapshot: undefined, content, disable: false, constant: true,
        order: order < Number.MAX_SAFE_INTEGER ? order + 1 : Number.MAX_VALUE,
        position: 1, preventRecursion: true, excludeRecursion: true, ignoreBudget: true,
        useProbability: false, probability: 100, group: '', triggers: [],
    });
}
