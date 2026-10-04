import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CALENDAR_KEY, CALENDAR_WORLD, DEFAULT_CALENDAR, calendarOwner, calendarChat, validateCalendar,
    validateDate, parseMonthDays, readCalendar, rawChatDate, holidaysOn, advanceDate, formatDate,
    advancePrompt, prependPrompt, calendarSnapshot, addCalendarScanSeed, finishCalendarScan,
} from '../calendar-core.js';

const holiday = (changes = {}) => ({ id:'festival', name:'灯火节', year:null, month:1, day:1, prompt:'全城点灯，街道举办夜市。', ...changes });
const definition = (changes = {}) => validateCalendar({ ...DEFAULT_CALENDAR, name:'星河历', months:[2,3], holidays:[holiday()], ...changes });
const context = (changes = {}) => ({
    characterId:0, characters:[{ avatar:'guide.png' }], chatId:'a', extensionSettings:{},
    chatMetadata:{ [CALENDAR_KEY]:{ date:{ year:7, month:1, day:1 } } }, ...changes,
});
test('month array follows explicit month count and rejects invalid lengths', () => {
    assert.deepEqual(parseMonthDays('[28,30,31]', 3), [28,30,31]);
    for (const [value,count] of [['[30]',2],['30,30',2],['[0]',1],['[-2]',1],['[1.2]',1],['[]',0],['[null]',1]]) assert.throws(() => parseMonthDays(value,count));
});
test('custom calendars validate dates against each month, with no Gregorian assumptions', () => {
    assert.deepEqual(validateDate({ year:'7',month:'2',day:'45' }, [4,45]), { year:7,month:2,day:45 });
    for (const date of [{year:0,month:1,day:1},{year:1,month:3,day:1},{year:1,month:1,day:5},{year:1,month:1,day:1.5}]) assert.throws(() => validateDate(date,[4,45]));
});
test('advancing crosses unequal month lengths and custom year boundaries', () => {
    assert.deepEqual(advanceDate({year:4,month:1,day:2},1,[2,3]),{year:4,month:2,day:1});
    assert.deepEqual(advanceDate({year:4,month:2,day:3},1,[2,3]),{year:5,month:1,day:1});
    assert.deepEqual(advanceDate({year:4,month:2,day:3},11,[2,3]),{year:7,month:1,day:1});
});
test('zero days preserves date; large jumps skip whole years accurately', () => {
    const date={year:1,month:1,day:1};
    assert.deepEqual(advanceDate(date,0,[2,3]),date);
    assert.deepEqual(advanceDate(date,500000001,[2,3]),{year:100000001,month:1,day:2});
    for (const days of [-1,1.1,NaN,Infinity,'']) assert.throws(() => advanceDate(date,days,[2,3]));
    assert.throws(() => advanceDate({year:Number.MAX_SAFE_INTEGER,month:1,day:1},1,[30]));
});
test('annual and one-time holidays can coincide without leaking into other years', () => {
    const calendar=definition({holidays:[holiday(),holiday({id:'anniversary',name:'相识纪念日',year:7}),holiday({id:'other',day:2})]});
    assert.deepEqual(holidaysOn(calendar,{year:7,month:1,day:1}).map(x=>x.name),['灯火节','相识纪念日']);
    assert.deepEqual(holidaysOn(calendar,{year:8,month:1,day:1}).map(x=>x.name),['灯火节']);
    assert.equal(holidaysOn(calendar,{year:7,month:2,day:1}).length,0);
});
test('holiday validation prevents invalid dates and duplicate IDs without mutating the input', () => {
    const value=definition(),original=JSON.stringify(value); validateCalendar(value); assert.equal(JSON.stringify(value),original);
    for (const holidays of [[holiday({day:3})],[holiday({month:3})],[holiday({year:0})],[holiday(),holiday()],[holiday({name:''})]]) assert.throws(()=>definition({holidays}));
});
test('named and unnamed date prefixes have the requested exact format', () => {
    const calendar=definition(),date={year:7,month:1,day:1};
    assert.equal(advancePrompt(calendar,date,3),'3天过后，星河历7年1月1日\n灯火节');
    assert.equal(advancePrompt({...calendar,name:''},date,3),'3天过后，7年1月1日\n灯火节');
    assert.equal(formatDate(calendar,{year:7,month:2,day:1}),'星河历7年2月1日');
});
test('prefix insertion preserves every byte of the existing composer content', () => {
    const original='  已经输入\n第二行\r\n{{user}} <tag>';
    const prefix='2天过后，7年2月1日';
    assert.equal(prependPrompt(prefix,original),prefix+'\n'+original);
    assert.equal(prependPrompt(prefix,''),prefix+'\n');
});
test('definitions are shared by card avatar while chat dates remain independent', () => {
    const config=definition(),settings={ [CALENDAR_KEY]:{cards:{'character:guide.png':config}} };
    const first=context({extensionSettings:settings});
    const second=context({extensionSettings:settings,chatId:'b',chatMetadata:{}});
    assert.deepEqual(readCalendar(first),readCalendar(second));
    assert.deepEqual(rawChatDate(second),{year:1,month:1,day:1});
    assert.deepEqual(rawChatDate(first),{year:7,month:1,day:1});
    assert.notEqual(calendarChat(first),calendarChat(second));
    const other=context({extensionSettings:settings,characters:[{avatar:'other.png'}]});
    assert.equal(readCalendar(other).name,'');
});
test('groups have separate definitions and no chat is fabricated on the start screen', () => {
    assert.equal(calendarOwner(context({groupId:'g'})),'group:g');
    assert.notEqual(calendarOwner(context({groupId:'g'})),calendarOwner(context()));
    assert.equal(calendarChat(context({chatId:undefined})), '');
    assert.equal(calendarOwner(context({characters:[]})), '');
});
function state(calendar=definition()) {
    const ctx=context({extensionSettings:{[CALENDAR_KEY]:{cards:{'character:guide.png':calendar}}}});
    return {ctx,snapshot:calendarSnapshot(ctx)};
}
function scan(snapshot, other = []) {
    const data={globalLore:[],characterLore:[],chatLore:other.slice(),personaLore:[]};
    addCalendarScanSeed(data,snapshot);
    const seed=data.chatLore.find(entry=>entry.world===CALENDAR_WORLD);
    return {data,seed,args:{state:{next:0},sortedEntries:data.chatLore,activated:{entries:new Map(other.map((v,i)=>[String(i),v])),text:'已有扫描内容'},budget:{current:20,overflowed:true}}};
}
test('calendar adds an empty disabled seed, including when no lorebooks are loaded', () => {
    const {snapshot}=state();const {data,seed}=scan(snapshot);
    assert.equal(data.chatLore.length,1);assert.equal(seed.disable,true);assert.equal(seed.content,'');
    addCalendarScanSeed(data,snapshot);assert.equal(data.chatLore.length,1);
    addCalendarScanSeed(data,null);assert.equal(data.chatLore.length,0);
});
test('final scan appends holiday settings to World Info After without changing earlier sections or budget', () => {
    const {snapshot}=state();
    const entries=[{world:'w',uid:1,position:0,content:'世界书前',order:100},{world:'w',uid:2,position:1,content:'后部一',order:9000},{world:'w',uid:3,position:1,content:'后部二',order:10000}];
    const {args}=scan(snapshot,entries);const original=JSON.stringify(entries),budget=JSON.stringify(args.budget);
    finishCalendarScan(args,snapshot);
    // Host contract: descending order, unshift into the matching position, then join.
    const before=[],after=[];
    [...args.activated.entries.values()].sort((a,b)=>b.order-a.order).forEach(entry=>(entry.position===0?before:after).unshift(entry.content));
    assert.deepEqual(before,['世界书前']);
    assert.equal(after.slice(0,2).join('\n'),'后部一\n后部二');
    assert.ok(after.at(-1).endsWith('<灯火节>\n全城点灯，街道举办夜市。\n</灯火节>\n\n'));
    assert.equal(JSON.stringify(entries),original);assert.equal(JSON.stringify(args.budget),budget);
    assert.equal(args.activated.text,'已有扫描内容');
});
test('a calendar-only scan stops pointless minimum-activation loops', () => {
    const {snapshot}=state();const {args}=scan(snapshot);args.state.next=3;
    finishCalendarScan(args,snapshot);
    assert.equal(args.state.next,0);assert.equal(args.activated.entries.size,1);
});
test('recursive scans with real entries wait for the final pass and never duplicate the holiday', () => {
    const {snapshot}=state();const {args}=scan(snapshot,[{world:'w',uid:1,order:1,position:1,content:'资料'}]);args.state.next=2;
    finishCalendarScan(args,snapshot);assert.equal(args.activated.entries.size,1);
    args.state.next=0;finishCalendarScan(args,snapshot);finishCalendarScan(args,snapshot);
    assert.equal(args.activated.entries.size,2);
    args.state.next=2;finishCalendarScan(args,snapshot);assert.equal(args.activated.entries.size,1);
});
test('switching chat or editing date/settings during a scan drops the stale holiday', () => {
    const {snapshot}=state();const {args}=scan(snapshot);
    finishCalendarScan(args,{...snapshot,scope:'other-chat'});assert.equal(args.activated.entries.size,0);
    finishCalendarScan(args,{...snapshot,revision:'changed'});assert.equal(args.activated.entries.size,0);
    finishCalendarScan(args,null);assert.equal(args.activated.entries.size,0);
});
test('non-holidays, disabled calendars, and blank holiday descriptions add no prompt', () => {
    const {ctx}=state();ctx.chatMetadata[CALENDAR_KEY].date.day=2;assert.equal(calendarSnapshot(ctx),null);
    assert.equal(state(definition({enabled:false})).snapshot,null);
    assert.equal(state(definition({holidays:[holiday({prompt:'  '})]})).snapshot,null);
});
test('macro expansion is delegated to the host for the holiday block', () => {
    const {snapshot}=state(definition({holidays:[holiday({prompt:'欢迎 {{user}}'})]}));const {args}=scan(snapshot);
    finishCalendarScan(args,snapshot,text=>text.replace('{{user}}','旅行者'));
    assert.ok([...args.activated.entries.values()][0].content.endsWith('欢迎 旅行者\n</灯火节>\n\n'));
});
