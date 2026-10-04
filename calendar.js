import { worldEnabled, WORLD_EVENT } from './world-state.js';
import {
    CALENDAR_KEY, DEFAULT_CALENDAR, calendarOwner, calendarChat, validateCalendar, validateDate,
    parseMonthDays, readCalendar, rawChatDate, holidaysOn, advanceDate, formatDate,
    advancePrompt, prependPrompt, calendarSnapshot, addCalendarScanSeed, finishCalendarScan,
} from './calendar-core.js';

export function mountCalendar(root, { getContext, openApp }) {
    const page = root.querySelector('#wo-calendar');
    const find = id => page.querySelector('#wo-cal-' + id);
    let owner = '', chat = '', metadata, viewYear = 1, viewMonth = 1, dayPage = 0, busy = false, generating = false;
    let jumpSnapshot;
    const toolbar = document.createElement('div');
    toolbar.id = 'wo-calendar-toolbar';
    const quick = document.createElement('button');
    quick.type = 'button';
    quick.id = 'wo-calendar-quick';
    quick.className = 'menu_button';
    quick.setAttribute('aria-haspopup', 'dialog');
    quick.setAttribute('aria-controls', 'wo-calendar-jump');
    quick.innerHTML = '<i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>推进时间</span>';
    toolbar.append(quick);
    const popup = document.createElement('dialog');
    popup.id = 'wo-calendar-jump';
    popup.className = 'wo-cal-jump floor-memory';
    popup.dataset.ttMobileSurface = 'fullscreen-window';
    popup.setAttribute('aria-labelledby', 'wo-calendar-jump-title');
    popup.innerHTML = `<header class="wo-cal-jump-header"><h2 id="wo-calendar-jump-title">推进时间</h2><button type="button" class="menu_button" id="wo-cal-jump-close" aria-label="关闭时间窗口">×</button></header>
      <form id="wo-cal-jump-form" class="wo-cal-jump-body">
        <p id="wo-cal-jump-current"></p>
        <label>过去几天<input id="wo-cal-jump-days" class="text_pole" type="number" min="0" step="1" value="1" inputmode="numeric" required></label>
        <p class="fm-hint">会把下面的文字放在聊天输入框最前面，保留已有输入；不会自动发送。</p>
        <pre id="wo-cal-jump-preview" class="fm-output"></pre>
        <p id="wo-cal-jump-status" class="fm-hint" role="status" aria-live="polite"></p>
        <div class="fm-actions"><button type="submit" id="wo-cal-jump-apply" class="menu_button">推进并填入输入框</button><button type="button" id="wo-cal-jump-settings" class="menu_button">日历设置</button></div>
      </form>`;
    document.body.append(popup);
    const jump = id => popup.querySelector('#wo-cal-jump-' + id);
    function notify(message, level = 'info') {
        find('status').textContent = message;
        find('status').dataset.level = level;
        jump('status').textContent = message;
    }
    function installToolbar() {
        const row = document.querySelector('#nonQRFormItems');
        const form = document.querySelector('#send_form');
        if (row?.parentElement && toolbar.nextElementSibling !== row) row.before(toolbar);
        else if (!row && form && toolbar.parentElement !== form) form.prepend(toolbar);
        return toolbar.isConnected;
    }
    if (!installToolbar()) {
        const observer = new MutationObserver(() => { if (installToolbar()) observer.disconnect(); });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    function viewport() {
        popup.style.setProperty('--wo-cal-viewport-height', (globalThis.visualViewport?.height ?? innerHeight) + 'px');
    }
    viewport();
    globalThis.addEventListener('resize', () => { viewport(); installToolbar(); });
    globalThis.visualViewport?.addEventListener('resize', viewport);
    function activeDate(calendar = readCalendar(getContext())) { return validateDate(rawChatDate(getContext()), calendar.months); }
    function syncControls() {
        const ctx = getContext();
        let usable = Boolean(calendarChat(ctx)) && !busy && !generating;
        try { const calendar = readCalendar(ctx); activeDate(calendar); usable &&= calendar.enabled && worldEnabled(ctx); } catch { usable = false; }
        quick.disabled = find('advance-open').disabled = !usable;
        jump('apply').disabled = !usable;
        find('controls').disabled = busy || !calendarOwner(ctx);
        quick.title = usable ? '推进本聊天的日期，并把提示词放在已有输入之前' : '打开聊天，并启用日历、设置有效日期后使用';
    }
    async function action(fn) {
        if (busy) return;
        busy = true; syncControls();
        try { await fn(); }
        catch (error) { notify(error.message, 'error'); }
        finally { busy = false; syncControls(); }
    }
    function saveDefinition(value) {
        const ctx = getContext(), key = calendarOwner(ctx);
        if (!key || key !== owner) throw new Error('角色已切换，请重新打开日历。');
        const calendar = validateCalendar(value);
        const previous = ctx.extensionSettings[CALENDAR_KEY];
        ctx.extensionSettings[CALENDAR_KEY] = { ...previous, schema: 1, cards: { ...previous?.cards, [key]: calendar } };
        ctx.saveSettingsDebounced();
        return calendar;
    }
    async function saveDate(date, prefix) {
        const ctx = getContext(), scope = calendarChat(ctx);
        if (!scope || scope !== chat) throw new Error('请先打开聊天，或重新打开日历。');
        const calendar = readCalendar(ctx);
        date = validateDate(date, calendar.months);
        const previous = ctx.chatMetadata[CALENDAR_KEY];
        const next = { ...previous, schema: 1, date };
        const input = prefix === undefined ? null : document.querySelector('#send_textarea');
        if (prefix !== undefined && !input) throw new Error('找不到聊天输入框，请重新加载宿主。');
        const original = input?.value;
        const selection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null;
        const inserted = input ? prependPrompt(prefix, original) : null;
        ctx.chatMetadata[CALENDAR_KEY] = next;
        if (input) {
            input.value = inserted;
            input.setSelectionRange(selection[0] + inserted.length - original.length, selection[1] + inserted.length - original.length, selection[2]);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        try { await ctx.saveMetadata(); }
        catch (error) {
            if (ctx.chatMetadata[CALENDAR_KEY] === next) {
                if (previous === undefined) delete ctx.chatMetadata[CALENDAR_KEY];
                else ctx.chatMetadata[CALENDAR_KEY] = previous;
            }
            if (input && calendarChat(getContext()) === scope && input.value === inserted) {
                input.value = original;
                input.setSelectionRange(...selection);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            throw new Error('日期保存失败：' + error.message);
        }
        // Save began on the captured chat. Never touch a newly selected chat on completion.
        return calendarChat(getContext()) === scope && getContext().chatMetadata === ctx.chatMetadata;
    }
    function fillRules(calendar) {
        find('name').value = calendar.name;
        find('enabled').checked = calendar.enabled;
        find('month-count').value = calendar.months.length;
        find('months').value = JSON.stringify(calendar.months);
    }
    function fillDate() {
        const date = rawChatDate(getContext());
        for (const key of ['year', 'month', 'day']) find('date-' + key).value = date[key];
    }
    function fillHoliday(item = {}) {
        const date = rawChatDate(getContext());
        find('holiday-id').value = item.id ?? '';
        find('holiday-name').value = item.name ?? '';
        find('holiday-annual').checked = item.year === undefined || item.year === null;
        find('holiday-year').value = item.year ?? viewYear ?? date.year;
        find('holiday-year').disabled = find('holiday-annual').checked;
        find('holiday-month').value = item.month ?? viewMonth;
        find('holiday-day').value = item.day ?? 1;
        find('holiday-prompt').value = item.prompt ?? '';
        find('holiday-title').textContent = item.id ? '编辑节日 / 纪念日' : '添加节日 / 纪念日';
    }
    function renderHolidays(calendar) {
        const list = find('holidays');
        list.replaceChildren();
        if (!calendar.holidays.length) {
            const empty = document.createElement('p'); empty.className = 'fm-hint'; empty.textContent = '还没有日期标记。可以点击上方日期添加。'; list.append(empty);
        }
        for (const item of calendar.holidays) {
            const card = document.createElement('div'); card.className = 'wo-cal-holiday';
            const title = document.createElement('strong'); title.textContent = item.name;
            const date = document.createElement('small'); date.textContent = (item.year === null ? '每年 ' : item.year + '年') + item.month + '月' + item.day + '日';
            const prompt = document.createElement('p'); prompt.textContent = item.prompt || '仅显示节日名，未填写设定提示词。';
            const actions = document.createElement('div'); actions.className = 'fm-actions';
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'menu_button'; edit.textContent = '编辑';
            edit.addEventListener('click', () => { fillHoliday(item); find('holiday-panel').open = true; find('holiday-name').focus(); });
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'menu_button'; remove.textContent = '删除';
            remove.addEventListener('click', () => action(async () => {
                const current = readCalendar(getContext());
                saveDefinition({ ...current, holidays: current.holidays.filter(value => value.id !== item.id) });
                if (find('holiday-id').value === item.id) fillHoliday();
                render(); notify('已删除“' + item.name + '”。');
            }));
            actions.append(edit, remove); card.append(title, date, prompt, actions); list.append(card);
        }
    }
    function renderMonth(calendar) {
        viewMonth = Math.max(1, Math.min(calendar.months.length, viewMonth));
        find('view-year').value = viewYear;
        const selector = find('view-month');
        if (selector.options.length !== calendar.months.length) {
            selector.replaceChildren();
            calendar.months.forEach((_days, index) => { const option = document.createElement('option'); option.value = index + 1; option.textContent = (index + 1) + '月'; selector.append(option); });
        }
        selector.value = viewMonth;
        const days = calendar.months[viewMonth - 1], size = 42;
        dayPage = Math.min(Math.floor((days - 1) / size), Math.max(0, dayPage));
        const start = dayPage * size + 1, end = Math.min(days, start + size - 1);
        const grid = find('days'); grid.replaceChildren();
        const today = rawChatDate(getContext());
        for (let day = start; day <= end; day++) {
            const date = { year: viewYear, month: viewMonth, day }, holidays = holidaysOn(calendar, date);
            const button = document.createElement('button'); button.type = 'button'; button.className = 'wo-cal-day';
            button.dataset.day = day;
            const number = document.createElement('span'); number.textContent = day; button.append(number);
            if (holidays.length) { const dot = document.createElement('span'); dot.className = 'wo-cal-dot'; dot.setAttribute('aria-hidden', 'true'); button.append(dot); }
            button.setAttribute('aria-label', formatDate(calendar, date) + (holidays.length ? '，' + holidays.map(item => item.name).join('、') : '，添加标记'));
            button.title = holidays.map(item => item.name).join('、');
            if (today.year === viewYear && today.month === viewMonth && today.day === day) button.setAttribute('aria-current', 'date');
            button.addEventListener('click', () => {
                fillHoliday({ month: viewMonth, day });
                find('holiday-panel').open = true;
                find('holiday-name').focus();
            });
            grid.append(button);
        }
        find('day-paging').hidden = days <= size;
        find('day-range').textContent = start + '～' + end + '日';
        find('prev-days').disabled = dayPage === 0;
        find('next-days').disabled = end === days;
    }
    function render() {
        const ctx = getContext(), calendar = readCalendar(ctx);
        const date = rawChatDate(ctx);
        find('today').textContent = formatDate(calendar, date);
        find('today-holidays').textContent = holidaysOn(calendar, date).map(item => item.name).join('、');
        find('scope').textContent = calendarOwner(ctx)
            ? (calendarOwner(ctx).startsWith('group:') ? '当前群聊' : '当前角色：' + (ctx.characters?.[ctx.characterId]?.name ?? ctx.name2 ?? '')) + '。日历规则与节日共享，当前日期随本聊天保存。'
            : '请先选择角色并打开聊天。';
        renderMonth(calendar); renderHolidays(calendar); syncControls();
        try { validateDate(date, calendar.months); }
        catch { notify('日历规则已变化，本聊天的旧日期不再有效。请在“设置本聊天的当前日期”中选择有效日期。', 'warning'); }
    }
    function refresh(force = false) {
        installToolbar();
        const ctx = getContext(), nextOwner = calendarOwner(ctx), nextChat = calendarChat(ctx);
        if (!force && nextOwner === owner && nextChat === chat && metadata === ctx.chatMetadata) { syncControls(); return; }
        owner = nextOwner; chat = nextChat; metadata = ctx.chatMetadata;
        const calendar = readCalendar(ctx), date = rawChatDate(ctx);
        viewYear = Number.isSafeInteger(date.year) && date.year > 0 ? date.year : 1;
        viewMonth = Math.min(calendar.months.length, Math.max(1, Number(date.month) || 1)); dayPage = 0;
        fillRules(calendar); fillDate(); fillHoliday(); render();
        notify('');
        try { validateDate(date, calendar.months); } catch { notify('当前日期不符合日历规则，请重新设置本聊天的日期。', 'warning'); }
    }
    function openJump() {
        refresh();
        const ctx = getContext(), calendar = readCalendar(ctx);
        if (!calendarChat(ctx)) { notify('请先打开一段聊天。', 'warning'); return; }
        if (!worldEnabled(getContext()) || !calendar.enabled || generating) return;
        try {
            const date = activeDate(calendar);
            jumpSnapshot = { scope: calendarChat(ctx), revision: JSON.stringify([calendar, date]), calendar, date };
            jump('current').textContent = '当前：' + formatDate(calendar, date);
            jump('days').value = '1'; jump('status').textContent = '';
            document.body.append(popup); popup.showModal(); previewJump();
            // Avoid opening the Android keyboard merely by displaying a preview.
            jump('close').focus({ preventScroll: true });
        } catch (error) { notify(error.message, 'error'); }
    }
    function previewJump() {
        if (!jumpSnapshot) return;
        try {
            const { calendar, date } = jumpSnapshot, days = jump('days').value;
            const next = advanceDate(date, days, calendar.months);
            jump('preview').textContent = advancePrompt(calendar, next, days);
            jump('status').textContent = '';
            jump('apply').disabled = busy || generating;
        } catch (error) { jump('preview').textContent = ''; jump('status').textContent = error.message; jump('apply').disabled = true; }
    }
    for (const button of [quick, find('advance-open')]) button.addEventListener('click', openJump);
    jump('close').addEventListener('click', () => popup.close());
    popup.addEventListener('cancel', event => { event.preventDefault(); popup.close(); });
    popup.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    jump('settings').addEventListener('click', () => { popup.close(); openApp('calendar'); find('rules-panel').open = true; });
    jump('days').addEventListener('input', previewJump);
    jump('form').addEventListener('submit', event => {
        event.preventDefault();
        action(async () => {
            const ctx = getContext(), calendar = readCalendar(ctx), date = activeDate(calendar);
            if (!jumpSnapshot || calendarChat(ctx) !== jumpSnapshot.scope || JSON.stringify([calendar, date]) !== jumpSnapshot.revision) throw new Error('聊天、日期或日历规则已变化，请重新打开时间窗口。');
            if (!worldEnabled(getContext()) || !calendar.enabled || generating) throw new Error('当前无法推进时间，请等待生成结束并确认日历已启用。');
            const days = jump('days').value, next = advanceDate(date, days, calendar.months);
            const isCurrent = await saveDate(next, advancePrompt(calendar, next, days));
            if (!isCurrent) return;
            popup.close(); viewYear = next.year; viewMonth = next.month; dayPage = Math.floor((next.day - 1) / 42);
            fillDate(); render(); notify('已推进时间并填入输入框，原有输入已保留。');
            document.querySelector('#send_textarea')?.focus({ preventScroll: true });
        });
    });
    find('rules-form').addEventListener('submit', event => {
        event.preventDefault();
        action(async () => {
            const current = readCalendar(getContext());
            const next = saveDefinition({ ...current, name: find('name').value, enabled: find('enabled').checked,
                months: parseMonthDays(find('months').value, find('month-count').value) });
            fillRules(next); notify('日历规则已保存，同一角色的其他聊天会共用这些规则。'); render();
        });
    });
    find('resize-months').addEventListener('click', () => {
        try {
            const count = Number(find('month-count').value);
            if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('月份数应为 1～1000 的整数。');
            const months = JSON.parse(find('months').value);
            if (!Array.isArray(months)) throw new Error('请先填写有效的天数数组。');
            find('months').value = JSON.stringify(Array.from({ length: count }, (_v, i) => months[i] ?? 30));
            notify('天数数组已调整，请检查后保存日历规则。');
        } catch (error) { notify(error.message, 'error'); }
    });
    find('date-form').addEventListener('submit', event => {
        event.preventDefault();
        action(async () => {
            const date = Object.fromEntries(['year', 'month', 'day'].map(key => [key, find('date-' + key).value]));
            if (await saveDate(date)) {
                const next = rawChatDate(getContext()); viewYear = next.year; viewMonth = next.month; dayPage = Math.floor((next.day - 1) / 42);
                fillDate(); render(); notify('本聊天的当前日期已保存，其他聊天日期不变。');
            }
        });
    });
    find('holiday-annual').addEventListener('change', () => { find('holiday-year').disabled = find('holiday-annual').checked; });
    find('new-holiday').addEventListener('click', () => fillHoliday());
    find('holiday-form').addEventListener('submit', event => {
        event.preventDefault();
        action(async () => {
            const calendar = readCalendar(getContext());
            const item = { id: find('holiday-id').value || (globalThis.crypto?.randomUUID?.() ?? 'holiday-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)), name: find('holiday-name').value,
                year: find('holiday-annual').checked ? null : find('holiday-year').value,
                month: find('holiday-month').value, day: find('holiday-day').value, prompt: find('holiday-prompt').value };
            const holidays = calendar.holidays.filter(value => value.id !== item.id); holidays.push(item);
            const saved = saveDefinition({ ...calendar, holidays });
            fillHoliday(saved.holidays.find(value => value.id === item.id));
            render(); notify('节日已保存。同一天可继续添加其他节日或纪念日。');
        });
    });
    for (const [id, offset] of [['prev-month', -1], ['next-month', 1]]) find(id).addEventListener('click', () => {
        const count = readCalendar(getContext()).months.length;
        if (offset < 0 && viewYear === 1 && viewMonth === 1) return;
        const index = viewMonth - 1 + offset;
        viewYear += Math.floor(index / count); viewMonth = ((index % count) + count) % count + 1; dayPage = 0;
        renderMonth(readCalendar(getContext()));
    });
    find('view-year').addEventListener('change', () => {
        try { viewYear = validateDate({ year: find('view-year').value, month: 1, day: 1 }, [1]).year; renderMonth(readCalendar(getContext())); }
        catch (error) { notify(error.message, 'error'); }
    });
    find('view-month').addEventListener('change', () => { viewMonth = Number(find('view-month').value); dayPage = 0; renderMonth(readCalendar(getContext())); });
    find('prev-days').addEventListener('click', () => { dayPage--; renderMonth(readCalendar(getContext())); });
    find('next-days').addEventListener('click', () => { dayPage++; renderMonth(readCalendar(getContext())); });
    root.addEventListener('world-os:page', event => { if (event.detail.name === 'calendar') refresh(); });
    const ctx = getContext(), { eventSource, eventTypes } = ctx;
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'CHARACTER_SELECTED']) if (eventTypes[name]) eventSource.on(eventTypes[name], () => {
        generating = false; jumpSnapshot = null; if (popup.open) popup.close(); refresh(true);
    });
    for (const name of ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) if (eventTypes[name]) eventSource.on(eventTypes[name], () => {
        generating = name === 'GENERATION_STARTED'; syncControls();
    });
    const snapshot = () => { try { return worldEnabled(getContext()) ? calendarSnapshot(getContext()) : null; } catch { return null; } };
    if (eventTypes.WORLDINFO_ENTRIES_LOADED && eventTypes.WORLDINFO_SCAN_DONE) {
        eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, data => addCalendarScanSeed(data, snapshot()));
        eventSource.on(eventTypes.WORLDINFO_SCAN_DONE, data => finishCalendarScan(data, snapshot(), value => {
            const current = getContext(); return typeof current.substituteParams === 'function' ? current.substituteParams(value) : value;
        }));
    } else {
        const warning = document.createElement('p');
        warning.className = 'fm-status'; warning.dataset.level = 'warning';
        warning.textContent = '宿主未提供节日注入所需的世界书事件，请更新 SillyTavern 或 TauriTavern。';
        page.prepend(warning);
    }
    document.addEventListener(WORLD_EVENT, () => {
        jumpSnapshot = null; if (popup.open) popup.close(); refresh(true);
    });
    refresh(true);
    return { refresh };
}
