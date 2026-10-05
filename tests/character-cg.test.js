import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS_KEY,validateCharacter,validateDirectory,ensureCharacterIDs,nextCharacterID,renderCharacter,
    selectCharacters,characterTokenCount,characterPrompt,relationshipsOf } from '../characters-core.js';
import { CG_PATTERN,validateCGs,validateCGSource,cgPrompt,cgLookup,recentCGIndices,validateCGFloors } from '../character-cg.js';
import { CharacterEngine } from '../characters-engine.js';
import { createSnapshot,restoreSnapshot,validateSnapshot } from '../snapshots.js';
import { WORLD_KEY } from '../world-state.js';

const image='data:image/png;base64,aGVsbG8=';
const make=(changes={})=>validateCharacter({id:'old-a',name:'角色A',keywords:'角色A',description:'年龄 {{age}}，{{user}}遇见{{char}}。',baseState:{age:20},...changes});
function context(items=[make()]) {
    return {characterId:0,characters:[{avatar:'cg-card.png'}],name1:'用户',name2:'主角',chatId:'one',chat:[{mes:'角色A',is_user:true}],chatMetadata:{},
        extensionSettings:{[CHARACTERS_KEY]:{cards:{'character:cg-card.png':items}}},saveSettingsDebounced(){},saveMetadata:async()=>{}};
}
test('迁移已有角色从 0 分配连续数字 ID，保持内部 ID、状态与次序，并且只保存一次',()=>{
    const ctx=context([make(),make({id:'old-b'})]);let saved=0;ctx.saveSettingsDebounced=()=>saved++;
    ctx.chatMetadata[CHARACTERS_KEY]={states:{'old-a':{age:37}}};
    ensureCharacterIDs(ctx);const list=ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png'];
    assert.deepEqual(list.map(p=>p.cgId),[0,1]);assert.deepEqual(list.map(p=>p.id),['old-a','old-b']);
    assert.equal(ctx.chatMetadata[CHARACTERS_KEY].states['old-a'].age,37);assert.equal(nextCharacterID(ctx),2);
    ensureCharacterIDs(ctx);assert.equal(saved,1);
});
test('已有编号永不因排序或改名变化，已删除的最高编号也不自动复用',()=>{
    const ctx=context([make({cgId:0}),make({id:'b',cgId:5})]);ensureCharacterIDs(ctx);
    ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png'].pop();
    ensureCharacterIDs(ctx);assert.equal(nextCharacterID(ctx),6);
    const next=validateDirectory([make({cgId:0,name:'新名字'}),make({id:'new'})],nextCharacterID(ctx));
    assert.deepEqual(next.map(p=>p.cgId),[0,6]);
    assert.deepEqual(validateDirectory([...next].reverse()).map(p=>p.cgId),[6,0]);
});
test('数字 ID 的重复、负数、小数、字符串或溢出不可保存',()=>{
    for(const cgId of [-1,1.5,'0',Number.MAX_SAFE_INTEGER])assert.throws(()=>make({cgId}));
    assert.throws(()=>validateDirectory([make({cgId:0}),make({id:'b',cgId:0})]),/重复/);
    assert.deepEqual(validateDirectory([make({cgId:8}),make({id:'b'})]).map(p=>p.cgId),[8,9]);
});
test('CG 名称支持汉字、空格与点号，英文大小写区分；危险来源与重复名称拒绝',()=>{
    const valid=validateCGs([{name:'B.夕阳',src:image},{name:'拥抱 C',src:'https://example.com/image.webp'}]);
    assert.equal(valid[0].name,'B.夕阳');
    for(const name of ['', ' x','x ','a\nb','x}}','<CG>'])assert.throws(()=>validateCGs([{name,src:image}]));
    assert.throws(()=>validateCGs([{name:'B',src:image},{name:'B',src:image}]),/重复/);
    for(const src of ['javascript:alert(1)','file:///sdcard/a.png','data:image/svg+xml;base64,QQ==','https://user:key@example.com/a','/local/a.png'])assert.throws(()=>validateCGSource(src));
});
test('{{CG}} 严格按 ID_名称标签列出本轮命中角色的所有宏，空 CG 和未命中角色不占内容',()=>{
    const characters=validateDirectory([make({cgs:[{name:'B',src:image},{name:'C',src:image}]}),make({id:'b',name:'角色B',keywords:'角色B',cgs:[{name:'日常',src:image}]}),make({id:'c',name:'空CG',keywords:'空CG'})]);
    assert.equal(cgPrompt(characters),'<0_角色A>\n{{0.B}}\n{{0.C}}\n</0_角色A>\n\n<1_角色B>\n{{1.日常}}\n</1_角色B>');
    const selected=selectCharacters(context(characters));
    assert.equal(selected.cgContent,'<0_角色A>\n{{0.B}}\n{{0.C}}\n</0_角色A>');
    assert(!selected.cgContent.includes('data:image'));assert.equal(cgLookup(characters).get('{{1.日常}}').src,image);
});
test('描述中图片宏保持原文，同名角色使用不同标签，不误选另一个角色的状态',()=>{
    const characters=validateDirectory([make({description:'{{age}} {{0.B}}'}),make({id:'b',description:'{{age}} {{1.B}}',baseState:{age:99}})]);
    const result=selectCharacters(context(characters));
    assert(result.content.includes('<0_角色A>\n20 {{0.B}}'));assert(result.content.includes('<1_角色A>\n99 {{1.B}}'));
    assert(!result.content.includes('undefined'));
    const edges=relationshipsOf(characters,{'old-a':{relationship:[{'角色A':'重名关系'}]}});
    assert.equal(edges[0].target,null,'ambiguous name must not silently bind to the last duplicate');
});
test('只渲染最近 N 条实际聊天消息：用户和 AI 各一楼，系统与工具跳过',()=>{
    const chat=[{mes:'u0',is_user:true},{mes:'a0'},{mes:'系统',is_system:true},{mes:'工具',role:'tool'},{mes:'u1',is_user:true},{mes:'a1'},{mes:''}];
    assert.deepEqual([...recentCGIndices(chat,2)],[5,4]);
    assert.deepEqual([...recentCGIndices(chat,4)],[5,4,1,0]);
    assert.deepEqual([...recentCGIndices(chat,1000)],[5,4,1,0]);
    assert.deepEqual([...recentCGIndices(chat,0)],[]);
    for(const n of [-1,1.5,1001,'2',NaN])assert.throws(()=>validateCGFloors(n));
});
test('图片宏扫描要求完整合法括号和非负整数，未完成的流式片段不匹配',()=>{
    const text='{{0.B}} {{7.场景.C}} {{0.B} {{00.B}} {{-1.B}} {{0.<img>}}';
    assert.deepEqual([...text.matchAll(CG_PATTERN)].map(m=>m[0]),['{{0.B}}','{{7.场景.C}}']);
});
test('Token 计数使用已选阶段、状态宏和角色标签，宿主分词器显式传入零 padding',async()=>{
    const ctx=context();let measured;
    ctx.getTokenCountAsync=async(text,padding)=>{measured=text;assert.equal(padding,0);return 83;};
    const character=make({description:'{{age}} {{user}} {{char}} {{0.B}}',stages:[
        {id:'one',name:'成年',content:'已成年',conditions:[{path:'age',op:'>=',value:18}]},
        {id:'two',name:'年长',content:'不应发送',conditions:[{path:'age',op:'>=',value:80}]}]});
    const item=renderCharacter(character,character.baseState);
    assert.equal(await characterTokenCount(ctx,item),83);
    assert.equal(measured,'<角色A>\n20 用户 主角 {{0.B}}\n\n已成年\n</角色A>');
    assert(!measured.includes('不应发送'));assert(!measured.includes('"age"'));
});
test('空设定计数为零且无需调用分词器；接口错误不能伪造 0 Token',async()=>{
    const ctx=context();assert.equal(await characterTokenCount(ctx,{name:'空',content:''}),0);
    await assert.rejects(characterTokenCount(ctx,{name:'A',content:'x'}),/有效/);
    ctx.getTokenCountAsync=async()=>{throw Error('offline');};
    await assert.rejects(characterTokenCount(ctx,{name:'A',content:'x'}),/offline/);
    ctx.getTokenCountAsync=undefined;ctx.getTokenCount=()=>11;
    assert.equal(await characterTokenCount(ctx,{name:'A',content:'x'}),11);
});
test('CG 与角色宏使用同一轮匹配结果，支持只放 CG 的预设且需最终提示词确认',()=>{
    const ctx=context(validateDirectory([make({cgs:[{name:'B',src:image}]})]));
    const engine=new CharacterEngine({getContext:()=>ctx});
    engine.start();engine.prepare();const cg=engine.macro('CG');
    assert.equal(cg,'<0_角色A>\n{{0.B}}\n</0_角色A>');
    engine.confirmPrompt({chat:[{role:'system',content:cg}]});
    assert.deepEqual(engine.run.called,['old-a']);
    engine.confirmPrompt({chat:[{role:'system',content:'已裁剪'}]});assert.deepEqual(engine.run.called,[]);
    engine.cancel();ctx.extensionSettings[WORLD_KEY]={enabled:false};assert.equal(engine.macro('CG'),'');
});
test('同名角色的提示词被裁掉一个时，只确认留下的数字 ID 标签',()=>{
    const ctx=context(validateDirectory([make(),make({id:'b',baseState:{age:99}})]));
    const engine=new CharacterEngine({getContext:()=>ctx});engine.start();engine.prepare();engine.macro();
    engine.confirmPrompt({chat:[{role:'system',content:characterPrompt(engine.run.selection.items[1])}]});
    assert.deepEqual(engine.run.called,['b']);engine.cancel();
});
test('快照保存恢复 CG、编号计数器和 N；旧版快照自动补号，坏图片或 N 不写入',async()=>{
    const ctx=context(validateDirectory([make({cgs:[{name:'B',src:image}]})]));
    ensureCharacterIDs(ctx);ctx.extensionSettings[CHARACTERS_KEY].nextIds['character:cg-card.png']=9;
    ctx.extensionSettings[CHARACTERS_KEY].cgRenderCount=2;
    const snapshot=createSnapshot(ctx);
    ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png']=[];
    await restoreSnapshot(snapshot,ctx);
    const restored=ctx.extensionSettings[CHARACTERS_KEY];
    assert.equal(restored.cards['character:cg-card.png'][0].cgs[0].src,image);
    assert.equal(nextCharacterID(ctx),9);assert.equal(restored.cgRenderCount,2);
    const bad=structuredClone(snapshot);bad.settings[CHARACTERS_KEY].cgRenderCount=-1;
    assert.throws(()=>validateSnapshot(bad),/楼数/);
    const badCG=structuredClone(snapshot);badCG.settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgs[0].src='javascript:evil()';
    assert.throws(()=>validateSnapshot(badCG));
    const legacy=createSnapshot(context([make()]));delete legacy.settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgId;
    assert.equal(validateSnapshot(legacy).settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgId,0);
});
