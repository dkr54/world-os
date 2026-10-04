import { calendarChat } from './calendar-core.js';
import { CHARACTERS_KEY, cloneJSON, directoryOf, currentState, selectCharacters, applyStateOperations } from './characters-core.js';
import { DEFAULT_STATE_API, validateStateAPI, requestStateUpdate } from './character-api.js';
import { worldEnabled, WORLD_EVENT } from './world-state.js';

const replySignature = message => JSON.stringify([message?.mes, message?.swipe_id, message?.send_date, message?.gen_started, message?.gen_finished]);
const realReply = message => message && !message.is_user && !message.is_system && message.role !== 'tool'
    && !message.extra?.tool_invocations?.length && !message.tool_calls?.length && typeof message.mes === 'string' && message.mes.trim();
export class CharacterEngine {
    constructor({ getContext, onChange = () => {}, request = requestStateUpdate, getKey = config => config.apiKey }) {
        this.getContext = getContext; this.onChange = onChange; this.request = request; this.getKey = getKey;
        this.run = null; this.job = null; this.timer = null; this.lastReport = null;
    }
    api() { return validateStateAPI(this.getContext().extensionSettings?.[CHARACTERS_KEY]?.api ?? DEFAULT_STATE_API); }
    cancel() { if (this.job && this.lastReport) this.lastReport.status = '操作已取消，AI 结果未写入。'; this.job?.abort(); this.job = null; clearTimeout(this.timer); this.run = null; }
    changed() { this.cancel(); this.lastReport = null; this.onChange(); }
    start(type = 'normal', _options, dryRun = false) {
        this.cancel();
        if (dryRun || ['quiet','impersonate'].includes(type) || !worldEnabled(this.getContext()) || !calendarChat(this.getContext())) return;
        const ctx = this.getContext();
        this.run = { type, scope:calendarChat(ctx), metadata:ctx.chatMetadata,
            before:new Map(ctx.chat.map(message => [message,replySignature(message)])), prepared:false,
            selection:null, expanded:false, confirmed:false, called:[], received:null, ended:false, done:false };
    }
    prepare(type = 'normal') {
        const run = this.run, ctx = this.getContext();
        if (!run || !this.validRun(run) || ['quiet','impersonate'].includes(type)) return;
        // The host's real chat still has its raw messages here; floor-memory projection has not run yet.
        const chat = type === 'swipe' ? ctx.chat.slice(0,-1) : ctx.chat;
        run.selection = selectCharacters(ctx,chat);
        run.prepared = true; run.expanded = false; run.confirmed = false; run.called = [];
    }
    validRun(run) {
        const ctx = this.getContext();
        return this.run === run && worldEnabled(ctx) && calendarChat(ctx) === run.scope && ctx.chatMetadata === run.metadata;
    }
    macro() {
        const ctx = this.getContext();
        if (!worldEnabled(ctx) || !calendarChat(ctx)) return '';
        const run = this.run;
        if (run && !run.ended && !run.done && this.validRun(run)) {
            if (!run.prepared) this.prepare(run.type);
            run.expanded = true; return run.selection.content;
        }
        // Host previews may expand macros outside a real generation. They never arm auto updates.
        return selectCharacters(ctx).content;
    }
    confirmPrompt(data, dryRun = false) {
        const run = this.run;
        if (!run || !this.validRun(run) || data?.dryRun || dryRun) return;
        const prompt = data?.chat ?? data?.messages ?? data?.prompt;
        if (prompt === undefined) return;
        if (!run.prepared) this.prepare(run.type);
        const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        run.called = run.selection.items.filter(item => run.expanded && item.content.trim() && text.includes('<' + item.name + '>') && text.includes('</' + item.name + '>')).map(item => item.id);
        run.confirmed = true;
        this.onChange();
    }
    received(index) {
        const run = this.run, ctx = this.getContext();
        if (!run || !this.validRun(run) || run.done || !run.confirmed || !Number.isInteger(index)) return;
        const message = ctx.chat[index];
        if (!realReply(message) || run.before.get(message) === replySignature(message)) return;
        run.received = message;
        this.schedule(run);
    }
    end(stopped = false) {
        const run = this.run;
        if (!run) return;
        if (stopped) { this.cancel(); return; }
        run.ended = true; this.schedule(run);
    }
    schedule(run) {
        clearTimeout(this.timer);
        if (!run.received || run.done) return;
        this.timer = setTimeout(() => { void this.finish(run); }, 200);
    }
    async finish(run) {
        if (!this.validRun(run) || run.done || !run.received) return;
        const ctx = this.getContext();
        if (!run.ended || ctx.streamingProcessor?.isFinished === false) { this.schedule(run); return; }
        if (!ctx.chat.includes(run.received) || !realReply(run.received) || run.before.get(run.received) === replySignature(run.received)) return;
        run.done = true;
        const ids = run.called;
        const definitions = directoryOf(ctx).filter(item => ids.includes(item.id));
        const previous = Object.fromEntries(definitions.map(item => [item.id,currentState(ctx,item)]));
        const report = { time:new Date().toISOString(), mode:'auto', query:run.selection.query, reply:run.received.mes,
            matched:run.selection.items.filter(item => ids.includes(item.id)).map(({ id,name,stage }) => ({ id,name,stage })),
            previous, current:cloneJSON(previous), accepted:[], ignored:[], status:ids.length ? '本轮已调用角色，自动更新关闭。' : '本轮没有角色设定进入最终上下文。' };
        this.lastReport = report; this.onChange();
        try {
            if (definitions.length && this.api().auto) await this.update(definitions,report,run);
            else await this.commitReport(ctx,report,null,run);
        } catch (error) {
            if (this.validRun(run)) { report.status = error.name === 'AbortError' ? '上下文已变化，AI 结果未写入。' : error.message; report.current = Object.fromEntries(definitions.map(item => [item.id,currentState(ctx,item)])); report.accepted = []; this.lastReport = report; this.onChange(error.message); }
        }
    }
    async commitReport(ctx, report, states, run, guard = () => true) {
        if ((run && !this.validRun(run)) || !guard()) throw new DOMException('上下文已变化，结果已取消。','AbortError');
        const previous = ctx.chatMetadata[CHARACTERS_KEY];
        const next = { ...previous, schema:1, states:{ ...previous?.states, ...(states ?? report.current) },
            lastCalled:report.matched.map(item => item.id), debug:cloneJSON(report) };
        ctx.chatMetadata[CHARACTERS_KEY] = next;
        try { await ctx.saveMetadata(); }
        catch (error) { if (ctx.chatMetadata[CHARACTERS_KEY] === next) ctx.chatMetadata[CHARACTERS_KEY] = previous; throw error; }
        if (calendarChat(ctx) !== calendarChat(this.getContext()) || ctx.chatMetadata !== this.getContext().chatMetadata) return;
        this.lastReport = report; this.onChange();
    }
    async update(definitions, report, run = null, requirements = '') {
        if (this.job) throw new Error('已有角色状态更新正在进行。');
        const ctx = this.getContext(), scope = calendarChat(ctx);
        if (!scope || !worldEnabled(ctx)) throw new Error('请先打开聊天并启用 world os。');
        const config = this.api(), controller = new AbortController(); this.job = controller;
        const definitionVersion = JSON.stringify(directoryOf(ctx)), settingsVersion = JSON.stringify(config);
        const before = Object.fromEntries(definitions.map(item => [item.id,currentState(ctx,item)]));
        const guard = () => !controller.signal.aborted && worldEnabled(this.getContext()) && calendarChat(this.getContext()) === scope
            && this.getContext().chatMetadata === ctx.chatMetadata && JSON.stringify(directoryOf(this.getContext())) === definitionVersion
            && JSON.stringify(this.api()) === settingsVersion
            && definitions.every(item => JSON.stringify(currentState(this.getContext(),item)) === JSON.stringify(before[item.id]))
            && (!run || (this.validRun(run) && ctx.chat.includes(run.received) && run.received.mes === report.reply));
        report.status = '正在更新角色状态…'; this.lastReport = report; this.onChange();
        try {
            const input = { characters:definitions.map(item => ({ id:item.id,name:item.name,state:before[item.id],permissions:item.policies,
                defaultPermission:'仅允许 update 已有具体字段；add/delete 需显式许可' })), query:report.query, reply:report.reply, requirements };
            const { operations, repairs } = await this.request(config,this.getKey(config),input,{ signal:controller.signal });
            if (!guard()) throw new DOMException('聊天、设定或状态已变化，AI 结果未写入。','AbortError');
            const applied = applyStateOperations(definitions,before,operations);
            report.previous = before; report.current = applied.states; report.accepted = applied.accepted;
            report.ignored = applied.ignored; report.repairs = repairs;
            report.status = '更新完成：接受 ' + applied.accepted.length + ' 项，忽略 ' + applied.ignored.length + ' 项。';
            await this.commitReport(ctx,report,applied.states,run,guard);
        } finally { if (this.job === controller) this.job = null; this.onChange(); }
    }
    async manual(ids, requirements = '') {
        if (this.run && !this.run.ended) throw new Error('请等待聊天回复结束。');
        const ctx = this.getContext(), definitions = directoryOf(ctx).filter(item => ids.includes(item.id));
        if (!definitions.length) throw new Error('请先选择要更新的角色。');
        const selection = selectCharacters(ctx);
        const report = { time:new Date().toISOString(), mode:'manual', query:selection.query,
            reply:[...ctx.chat].reverse().find(realReply)?.mes ?? '',
            matched:definitions.map(item => ({ id:item.id,name:item.name,stage:'手动选择' })),
            previous:{},current:{},accepted:[],ignored:[],status:'' };
        try { await this.update(definitions,report,null,requirements); }
        catch (error) {
            if (this.getContext().chatMetadata === ctx.chatMetadata && calendarChat(this.getContext()) === calendarChat(ctx)) {
                report.status = error.name === 'AbortError' ? '上下文已变化，本次更新已取消。' : error.message;
                report.current = Object.fromEntries(definitions.map(item => [item.id,currentState(ctx,item)])); report.accepted = [];
                this.lastReport = report; this.onChange(report.status);
            }
            throw error;
        }
    }
    report() { return this.lastReport ?? this.getContext().chatMetadata?.[CHARACTERS_KEY]?.debug ?? null; }
    mount() {
        const ctx = this.getContext(), { eventSource,eventTypes } = ctx;
        const listen = (name, callback) => { if (eventTypes[name]) eventSource.on(eventTypes[name],callback); };
        const handler = () => this.macro();
        if (typeof ctx.registerMacro === 'function') ctx.registerMacro('character',handler,'world os 当前命中角色的阶段设定');
        else if (ctx.macros?.register) ctx.macros.register('character',{ handler,description:'world os 当前命中角色的阶段设定' });
        else this.onChange('宿主缺少宏注册接口，请更新后使用 {{character}}。');
        listen('GENERATION_STARTED',(...args) => this.start(...args));
        listen('CHAT_COMPLETION_PROMPT_READY',data => this.confirmPrompt(data));
        listen('GENERATE_AFTER_COMBINE_PROMPTS',data => { if (this.getContext().mainApi !== 'openai') this.confirmPrompt(data); });
        listen('GENERATE_AFTER_DATA',(data,dryRun) => this.confirmPrompt(data,dryRun));
        listen('MESSAGE_RECEIVED',index => this.received(index));
        listen('CHARACTER_MESSAGE_RENDERED',index => this.received(index));
        listen('GENERATION_ENDED',() => this.end());
        listen('GENERATION_STOPPED',() => this.end(true));
        for (const name of ['CHAT_CHANGED','CHAT_LOADED','CHARACTER_SELECTED']) listen(name,() => this.changed());
        for (const name of ['MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED']) listen(name,() => {
            if (this.job) this.job.abort();
        });
        document.addEventListener(WORLD_EVENT,() => this.changed());
        return this;
    }
}
