import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS_KEY, validateCharacter, validateDirectory, validateState, currentState, selectCharacters, recentCharacterQuery,
    renderCharacter, applyStateOperations, stateDifference, relationshipsOf, sortedCharacters, safeJSON, getStateValue } from '../characters-core.js';
import { validateStateAPI, stateMessages, parseStateResponse, requestStateUpdate } from '../character-api.js';
import { CharacterEngine } from '../characters-engine.js';
import { createSnapshot, restoreSnapshot, validateSnapshot } from '../snapshots.js';
import { WORLD_KEY } from '../world-state.js';
import { CALENDAR_KEY, holidayPrompt, validateCalendar } from '../calendar-core.js';
import { DEFAULT_SETTINGS, MODULE_KEY } from '../core.js';

const person = changes => validateCharacter({ id:'a',name:'示例角色甲',keywords:'示例角色甲,角色甲',avatar:'',description:'年龄 {{age}}；好感 {{affection}}；关系 {{relationship.苏岚}}',
    baseState:{ age:20,affection:0,relationship:[{ 苏岚:'初识' }] },stages:[],policies:[],...changes });
function context(characters = [person()]) {
    const ctx = { characterId:0,characters:[{ avatar:'card.png' }],chatId:'chat',chat:[],chatMetadata:{ foreign:{keep:true} },
        extensionSettings:{ [MODULE_KEY]:structuredClone(DEFAULT_SETTINGS),[CHARACTERS_KEY]:{ cards:{ 'character:card.png':characters },api:validateStateAPI({ model:'small',endpoint:'https://example.com/v1' }) } },
        saveMetadata:async () => {},saveSettingsDebounced:() => {} };
    return ctx;
}
test('角色查询无条件使用最近两条用户或 AI 消息，不足两条全部使用',() => {
    const chat = ['u0','a1','u1','a2'].map((mes,index) => ({ mes,is_user:index%2===0 }));
    assert.equal(recentCharacterQuery(chat),'u1\n\na2');
    assert.equal(recentCharacterQuery(chat.slice(0,3)),'a1\n\nu1');
    assert.equal(recentCharacterQuery([{mes:'a0'},{mes:'u0',is_user:true}]),'a0\n\nu0');
    assert.equal(recentCharacterQuery([{mes:'only'}]),'only'); assert.equal(recentCharacterQuery([]),'');
});
test('角色关键词以英文逗号分隔，中文逗号保留，空关键词不匹配',() => {
    const p = person({ keywords:'甲,12，12' }), ctx = context([p]);
    assert.deepEqual(p.keywords,['甲','12，12']);
    ctx.chat = [{mes:'12'}]; assert.equal(selectCharacters(ctx).items.length,0);
    ctx.chat.push({mes:'12，12'}); assert.equal(selectCharacters(ctx).items.length,1);
    ctx.extensionSettings[CHARACTERS_KEY].cards['character:card.png'] = [person({keywords:''})];
    assert.equal(selectCharacters(ctx).items.length,0);
});
test('中文拼音与英文姓名排序，并支持多音字排序名',() => {
    assert.deepEqual(sortedCharacters([{name:'苏岚'},{name:'示例角色甲'},{name:'阿兰'}]).map(p=>p.name),['阿兰','示例角色甲','苏岚']);
    assert.deepEqual(sortedCharacters([{name:'Zoe'},{name:'Amy'}]).map(p=>p.name),['Amy','Zoe']);
    assert.deepEqual(sortedCharacters([{name:'示例角色甲'},{name:'Amy'},{name:'苏岚'},{name:'Zoe'}]).map(p=>p.name),['Amy','示例角色甲','苏岚','Zoe']);
    assert.equal(sortedCharacters([{name:'重阳',sortName:'chongyang'},{name:'示例角色甲',sortName:'shilijiaosejia'}])[0].name,'重阳');
});
test('所有条件满足且最后匹配的阶段胜出；未满足的设定不进入宏',() => {
    const p=person({ stages:[
        {id:'first',name:'熟悉',conditions:[{path:'affection',op:'>=',value:30}],content:'熟悉阶段'},
        {id:'last',name:'信赖',conditions:[{path:'affection',op:'>=',value:70},{path:'age',op:'>=',value:18}],content:'只在信赖阶段出现'},
    ]});
    assert.equal(renderCharacter(p,{...p.baseState,affection:50}).stage,'熟悉');
    const result=renderCharacter(p,{...p.baseState,affection:80});assert.equal(result.stage,'信赖');
    assert(!result.content.includes('熟悉阶段'));assert(result.content.includes('年龄 20'));assert(result.content.includes('关系 初识'));
    assert(!renderCharacter(p,p.baseState).content.includes('阶段出现'));
});
test('状态宏不递归执行，删除的字段为空，关系名支持点号',() => {
    const p=person({ description:'{{age}}|{{gone}}|{{relationship.A.B}}|{{affection}}' });
    const rendered=renderCharacter(p,{age:'{{affection}}',affection:5,relationship:[{'A.B':'朋友'}]});
    assert.equal(rendered.content,'{{affection}}||朋友|5'); assert.equal(getStateValue({relationship:[{'A.B':'朋友'}]},'relationship.A.B'),'朋友');
});
test('基础设定共享、聊天状态独立，不把删除的字段重新补回',() => {
    const ctx=context(), p=person();ctx.chatMetadata[CHARACTERS_KEY]={states:{a:{affection:99,relationship:[]}}};
    assert.deepEqual(currentState(ctx,p),{affection:99,relationship:[]});
    const second={...ctx,chatId:'another',chatMetadata:{}};
    assert.equal(currentState(second,p).age,20);assert.equal(currentState(second,p).affection,0);
});
test('状态操作默认仅 update；未知操作、未知角色、类型变化和字段缺失均忽略',() => {
    const p=person(), before={a:p.baseState};
    const result=applyStateOperations([p],before,[
        {op:'update',characterId:'a',path:'affection',value:5},
        {op:'add',characterId:'a',path:'new',value:'x'},
        {op:'delete',characterId:'a',path:'age'},
        {op:'set',characterId:'a',path:'age',value:30},
        {op:'update',characterId:'not-called',path:'age',value:30},
        {op:'update',characterId:'a',path:'age',value:'21'},
        {op:'update',characterId:'a',path:'missing',value:1},
    ]);
    assert.equal(result.accepted.length,1);assert.equal(result.ignored.length,6);
    assert.equal(result.states.a.affection,5);assert.equal(before.a.affection,0);
});
test('显式 add/delete 权限及关系通配权限生效，update 不能整体替换父对象绕过权限',() => {
    const p=person({ baseState:{age:20,profile:{locked:1},relationship:[{苏岚:'朋友'}]},
        policies:[{path:'age',type:'number',allow:['delete']},{path:'new',type:'boolean',allow:['add']},{path:'relationship.*',type:'string',allow:['add','update','delete']},{path:'profile.locked',type:'number',allow:[]}]});
    const result=applyStateOperations([p],{a:p.baseState},[
        {op:'delete',characterId:'a',path:'age'}, {op:'add',characterId:'a',path:'new',value:true},
        {op:'add',characterId:'a',path:'relationship.青禾',value:'同伴'},
        {op:'update',characterId:'a',path:'relationship.苏岚',value:'挚友'},
        {op:'update',characterId:'a',path:'profile',value:{locked:99}},
        {op:'update',characterId:'a',path:'profile.locked',value:99},
    ]);
    assert.equal(result.accepted.length,4);assert.equal(result.states.a.profile.locked,1);assert(!('age' in result.states.a));
    assert.equal(getStateValue(result.states.a,'relationship.青禾'),'同伴');
});
test('拒绝原型污染、任意指令字段、重复写入、父路径不存在和越界数组',() => {
    assert.throws(()=>safeJSON(JSON.parse('{"__proto__":{"polluted":true}}')));
    assert.throws(()=>validateState({relationship:[{苏岚:'甲'},{苏岚:'乙'}]}));
    const p=person({baseState:{age:20,array:[1]}});
    const result=applyStateOperations([p],{a:p.baseState},[
        {op:'update',characterId:'a',path:'__proto__.polluted',value:true},
        {op:'update',characterId:'a',path:'age',value:21,command:'x'},
        {op:'update',characterId:'a',path:'age',value:21},
        {op:'update',characterId:'a',path:'age',value:22},
        {op:'update',characterId:'a',path:'array.2',value:2},
    ]);
    assert.equal(result.accepted.length,1);assert.equal(result.states.a.age,21);assert.equal({}.polluted,undefined);
});
test('关系图保留方向、完整描述和未建档关系对象；差异包含新增和删除',() => {
    const p=person(), b=person({id:'b',name:'苏岚'});
    assert.deepEqual(relationshipsOf([p,b],{a:p.baseState,b:{relationship:[{'未建档':'路人'}]}}),
        [{source:'a',target:'b',name:'苏岚',description:'初识'},{source:'b',target:null,name:'未建档',description:'路人'}]);
    const diff=stateDifference({age:20,relationship:[{苏岚:'初识'}]},{affection:1,relationship:[{苏岚:'朋友'}]});
    assert(diff.some(item=>item.path==='age' && item.after===undefined));assert(diff.some(item=>item.path==='relationship.苏岚'));
});
test('重复角色名、危险头像和非法条件不可保存',() => {
    assert.throws(()=>validateDirectory([person(),person({id:'b'})]));
    assert.throws(()=>person({avatar:'javascript:alert(1)'}));
    assert.throws(()=>person({stages:[{id:'bad',name:'x',content:'x',conditions:[{path:'age',op:'eval',value:1}]}]}));
});
test('状态模型预设支持 role 与变量，结果严格校验；多余右括号只做语法修复',() => {
    const config=validateStateAPI({});
    const messages=stateMessages(config,{characters:[{id:'a'}],query:'查询',reply:'回复',requirements:'要求'});
    assert(messages.some(item=>item.content.includes('查询')&&item.content.includes('要求')));
    assert.equal(messages[0].role,'system'); assert(messages[0].content.includes('operations')); assert.equal(messages.at(-1).role,'user');
    assert.equal(parseStateResponse('{"operations":[]}}','stop').operations.length,0);
    assert.throws(()=>parseStateResponse('{"operations":[],"run":"code"}','stop'));
    assert.throws(()=>parseStateResponse('{"operations":[]}','length'));
    assert.throws(()=>validateStateAPI({extraBody:'{"messages":[]}'}));
});
test('状态 API 使用独立参数、关闭硅基 Qwen3 思考并保持非流式请求',async () => {
    let body;
    const result=await requestStateUpdate(validateStateAPI({endpoint:'https://api.siliconflow.cn/v1',model:'Qwen/Qwen3-8B'}),'key',
        {characters:[],query:'',reply:'',requirements:''},{fetchImpl:async (url,options)=>{
            assert.equal(url,'https://api.siliconflow.cn/v1/chat/completions');assert.equal(options.credentials,'omit');
            body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"operations":[]}'}}]})};
        }});
    assert.equal(body.enable_thinking,false);assert.equal(body.stream,false);assert.equal(body.temperature,.2);assert.deepEqual(result.operations,[]);
});
function arm(ctx, engine, {macro=true,final=true,type='normal'}={}) {
    engine.start(type,{},false);engine.prepare(type);
    const content=macro?engine.macro():'nothing';
    engine.confirmPrompt({chat:[{role:'system',content:final?content:'nothing'}],dryRun:false});
    return engine.run;
}
async function finishReply(ctx,engine,run,text='示例角色甲答应了。') {
    ctx.chat.push({mes:text,is_user:false,send_date:Date.now()});engine.received(ctx.chat.length-1);run.ended=true;
    clearTimeout(engine.timer);await engine.finish(run);clearTimeout(engine.timer);
}
test('只有真实已落入聊天的回复且实际发送角色宏，才自动调用更新 API',async () => {
    const ctx=context();ctx.chat=[{mes:'示例角色甲',is_user:true}];ctx.extensionSettings[CHARACTERS_KEY].api.auto=true;
    let calls=0;const engine=new CharacterEngine({getContext:()=>ctx,request:async()=>{calls++;return {operations:[{op:'update',characterId:'a',path:'affection',value:2}],repairs:[]};}});
    const run=arm(ctx,engine);
    engine.received(99);engine.end();clearTimeout(engine.timer);assert.equal(calls,0);
    await finishReply(ctx,engine,run);assert.equal(calls,1);assert.equal(ctx.chatMetadata[CHARACTERS_KEY].states.a.affection,2);
    engine.received(ctx.chat.length-1);await engine.finish(run);assert.equal(calls,1);
});
test('虚拟发送、dryRun、未使用宏、最终被裁掉的角色不触发状态 API',async () => {
    for (const mode of ['virtual','dry','unused','trimmed']) {
        const ctx=context();ctx.chat=[{mes:'示例角色甲',is_user:true}];ctx.extensionSettings[CHARACTERS_KEY].api.auto=true;
        let calls=0;const engine=new CharacterEngine({getContext:()=>ctx,request:async()=>{calls++;return {operations:[],repairs:[]};}});
        if (mode==='dry') { engine.start('normal',{},true);assert.equal(engine.run,null);continue; }
        const run=arm(ctx,engine,{macro:mode!=='unused',final:mode!=='trimmed'});
        if (mode==='virtual') {engine.end();assert.equal(run.received,null);}
        else await finishReply(ctx,engine,run);
        if (mode==='unused') assert.deepEqual(ctx.chatMetadata[CHARACTERS_KEY].debug.matched,[]);
        engine.cancel();assert.equal(calls,0);
    }
});
test('只更新本轮调用角色；未知角色操作会被忽略',async () => {
    const ctx=context([person(),person({id:'b',name:'苏岚',keywords:'苏岚'})]);ctx.chat=[{mes:'示例角色甲',is_user:true}];ctx.extensionSettings[CHARACTERS_KEY].api.auto=true;
    const engine=new CharacterEngine({getContext:()=>ctx,request:async(_c,_k,input)=>{
        assert.deepEqual(input.characters.map(item=>item.id),['a']);
        return {operations:[{op:'update',characterId:'b',path:'age',value:99}],repairs:[]};
    }});
    await finishReply(ctx,engine,arm(ctx,engine));assert.equal(ctx.chatMetadata[CHARACTERS_KEY].debug.ignored.length,1);
    assert.equal(ctx.chatMetadata[CHARACTERS_KEY].states.b,undefined);
});
test('流式回复完成前不更新；中止和旧消息事件不会更新',async () => {
    const ctx=context();ctx.chat=[{mes:'示例角色甲',is_user:false}];ctx.extensionSettings[CHARACTERS_KEY].api.auto=true;
    let calls=0;const engine=new CharacterEngine({getContext:()=>ctx,request:async()=>{calls++;return {operations:[],repairs:[]};}});
    let run=arm(ctx,engine);engine.received(0);assert.equal(run.received,null);
    ctx.chat.push({mes:'新回复'});ctx.streamingProcessor={isFinished:false};engine.received(1);run.ended=true;clearTimeout(engine.timer);await engine.finish(run);
    assert.equal(calls,0);engine.end(true);clearTimeout(engine.timer);assert.equal(engine.run,null);
});
test('状态请求期间切换聊天、手改状态或关闭总开关，迟到结果不能写入',async () => {
    for(const mode of ['switch','edit','disable']) {
        let ctx=context();ctx.chat=[{mes:'示例角色甲',is_user:true}];ctx.extensionSettings[CHARACTERS_KEY].api.auto=true;
        let resolve;const engine=new CharacterEngine({getContext:()=>ctx,request:()=>new Promise(r=>{resolve=r;})});
        const original=ctx;const pending=finishReply(ctx,engine,arm(ctx,engine));await new Promise(r=>setTimeout(r,0));
        if(mode==='switch')ctx={...ctx,chatId:'different',chatMetadata:{}};
        if(mode==='edit')ctx.chatMetadata[CHARACTERS_KEY]={states:{a:{...person().baseState,affection:55}}};
        if(mode==='disable')ctx.extensionSettings[WORLD_KEY]={enabled:false};
        resolve({operations:[{op:'update',characterId:'a',path:'affection',value:99}],repairs:[]});await pending;
        assert.notEqual(original.chatMetadata[CHARACTERS_KEY]?.states?.a?.affection,99);engine.cancel();
    }
});
test('手动要求交给模型；保存失败回滚聊天状态',async () => {
    const ctx=context();ctx.chat=[{mes:'最近回复'}];ctx.saveMetadata=async()=>{throw Error('save failed');};
    const engine=new CharacterEngine({getContext:()=>ctx,request:async(_c,_k,input)=>{assert.equal(input.requirements,'设为好友');return {operations:[{op:'update',characterId:'a',path:'affection',value:2}],repairs:[]};}});
    await assert.rejects(engine.manual(['a'],'设为好友'),/save failed/);
    assert.equal(ctx.chatMetadata[CHARACTERS_KEY],undefined);
});
test('节日提示词精确使用标签及首尾空行，多个节日各自独立',() => {
    const calendar=validateCalendar({name:'星历',months:[30],holidays:[{id:'a',name:'团圆节',month:1,day:1,prompt:'团聚'},{id:'b',name:'纪念日',month:1,day:1,prompt:'纪念'}]});
    assert.equal(holidayPrompt(calendar,{year:1,month:1,day:1}),'\n\n<团圆节>\n团聚\n</团圆节>\n\n<纪念日>\n纪念\n</纪念日>\n\n');
});
test('快照包含所有模块当前状态，默认排除密钥，并且不包含聊天原文',async () => {
    const ctx=context();ctx.extensionSettings[CHARACTERS_KEY].api={...validateStateAPI({}),apiKey:'secret',rememberKey:true};
    ctx.chat=[{mes:'private chat'}];ctx.chatMetadata[CHARACTERS_KEY]={schema:1,states:{a:person().baseState}};
    const snapshot=createSnapshot(ctx);assert(!JSON.stringify(snapshot).includes('secret'));assert(!JSON.stringify(snapshot).includes('private chat'));
    assert.equal(createSnapshot(ctx,true).settings[CHARACTERS_KEY].api.apiKey,'secret');
    validateSnapshot(snapshot);
    ctx.chatMetadata[CHARACTERS_KEY].states.a.affection=10;
    await restoreSnapshot(snapshot,ctx);
    assert.equal(ctx.chatMetadata[CHARACTERS_KEY].states.a.affection,0);assert.equal(ctx.extensionSettings[CHARACTERS_KEY].api.apiKey,'secret');assert.deepEqual(ctx.chatMetadata.foreign,{keep:true});
});
test('快照跨角色卡拒绝、跨聊天需显式选择，保存失败恢复原值',async () => {
    const ctx=context(), snapshot=createSnapshot(ctx);
    ctx.chatId='different';await assert.rejects(restoreSnapshot(snapshot,ctx),/其他聊天/);
    await restoreSnapshot(snapshot,ctx,{allowOtherChat:true});
    ctx.characters=[{avatar:'other.png'}];await assert.rejects(restoreSnapshot(snapshot,ctx,{allowOtherChat:true}),/所属/);
    ctx.characters=[{avatar:'card.png'}];ctx.chatId='chat';
    ctx.chatMetadata[CHARACTERS_KEY]={states:{a:{age:99}}};ctx.saveMetadata=async()=>{throw Error('storage failed');};
    await assert.rejects(restoreSnapshot(snapshot,ctx),/storage failed/);assert.equal(ctx.chatMetadata[CHARACTERS_KEY].states.a.age,99);
});
test('快照拒绝未知模块、危险属性、无效日期和损坏角色状态',() => {
    const ctx=context(), snapshot=createSnapshot(ctx);
    assert.throws(()=>validateSnapshot({...snapshot,settings:{...snapshot.settings,foreign:{}}}),/未知/);
    assert.throws(()=>validateSnapshot(JSON.parse('{"__proto__":{}}')));
    assert.throws(()=>validateSnapshot({...snapshot,metadata:{...snapshot.metadata,[CALENDAR_KEY]:{date:{year:0,month:1,day:1}}}}));
    assert.throws(()=>validateSnapshot({...snapshot,metadata:{...snapshot.metadata,[CHARACTERS_KEY]:{states:{a:{relationship:'bad'}}}}}));
});

test('手动更新途中切换聊天，旧报告也不能覆盖新聊天调试页',async()=>{
    let ctx=context(), resolve;
    const engine=new CharacterEngine({getContext:()=>ctx,request:()=>new Promise(r=>{resolve=r;})});
    const pending=engine.manual(['a'],'更新');await new Promise(r=>setTimeout(r,0));
    ctx={...ctx,chatId:'new',chatMetadata:{}};engine.changed();
    resolve({operations:[],repairs:[]});
    await assert.rejects(pending,{name:'AbortError'});assert.equal(engine.report(),null);
});
test('快照恢复期间另一次状态编辑不能被回滚覆盖',async()=>{
    const ctx=context(),snapshot=createSnapshot(ctx);let resolve;
    ctx.saveMetadata=()=>new Promise(r=>{resolve=r;});
    const pending=restoreSnapshot(snapshot,ctx);
    const concurrent={states:{a:{age:55}}};ctx.chatMetadata[CHARACTERS_KEY]=concurrent;
    ctx.saveMetadata=async()=>{};resolve();
    await assert.rejects(pending,/再次被修改/);assert.equal(ctx.chatMetadata[CHARACTERS_KEY],concurrent);
});
test('自动更新关闭时仍冻结已调用角色的聊天基础状态',async()=>{
    const ctx=context();ctx.chat=[{mes:'示例角色甲',is_user:true}];
    const engine=new CharacterEngine({getContext:()=>ctx});
    await finishReply(ctx,engine,arm(ctx,engine));
    assert.equal(ctx.chatMetadata[CHARACTERS_KEY].states.a.age,20);
    ctx.extensionSettings[CHARACTERS_KEY].cards['character:card.png'][0].baseState.age=30;
    assert.equal(currentState(ctx,person()).age,20);
});

test('快照只排除实际接口密钥，不误删角色 JSON 中同名的剧情字段',()=>{
    const ctx=context([person({baseState:{apiKey:'剧情中的钥匙',nested:{apiKey:'剧情物品'}}})]);
    ctx.extensionSettings[CHARACTERS_KEY].api.apiKey='real-secret';
    const snapshot=createSnapshot(ctx);
    assert.equal(snapshot.settings[CHARACTERS_KEY].api.apiKey,undefined);
    assert.equal(snapshot.settings[CHARACTERS_KEY].cards['character:card.png'][0].baseState.apiKey,'剧情中的钥匙');
    assert.equal(snapshot.settings[CHARACTERS_KEY].cards['character:card.png'][0].baseState.nested.apiKey,'剧情物品');
});
test('恢复未配置某功能的快照时，未导出的本机接口密钥仍保留',async()=>{
    const ctx=context();delete ctx.extensionSettings[CHARACTERS_KEY];const snapshot=createSnapshot(ctx);
    ctx.extensionSettings[CHARACTERS_KEY]={api:validateStateAPI({apiKey:'retain-this',rememberKey:true})};
    await restoreSnapshot(snapshot,ctx);assert.equal(ctx.extensionSettings[CHARACTERS_KEY].api.apiKey,'retain-this');
});
