import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS_KEY,validateCharacter,validateDirectory,ensureCharacterIDs,nextCharacterID,renderCharacter,
    selectCharacters,characterTag,characterTokenCount,characterPrompt } from '../characters-core.js';
import { CG_PATTERN,validateCGs,validateCGSource,cgPrompt,cgLookup,recentCGIndices,validateCGFloors,createCGPicker,normalizeImageFile } from '../character-cg.js';
import { CharacterEngine } from '../characters-engine.js';
import { createSnapshot,restoreSnapshot,validateSnapshot } from '../snapshots.js';
import { memoryAssetHost } from './asset-store-fixture.js';
import { WORLD_KEY } from '../world-state.js';

const image='data:image/png;base64,aGVsbG8=';
const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
test('文件选择器未给出或错误标注图片类型时，按文件内容恢复 PNG 类型且不改变字节',async()=>{
    for(const type of ['', 'application/octet-stream', 'text/plain', 'image/jpg', 'image/png']) {
        const file=new File([pngBytes],'sample.bin',{type});const normalized=await normalizeImageFile(file);
        assert.equal(normalized.type,'image/png');assert.deepEqual(Buffer.from(await normalized.arrayBuffer()),pngBytes);
        if(type==='image/png')assert.equal(normalized,file);
    }
});
test('图片文件头支持 JPEG、两种 GIF 和 WebP，并拒绝伪装扩展名或类型的非图片',async()=>{
    for(const [hex,type]of [['ffd8ffe000104a464946000101','image/jpeg'],['47494638376101000100800000','image/gif'],['47494638396101000100800000','image/gif'],['524946462a0000005745425056503820','image/webp']]){
        const file=new File([Buffer.from(hex,'hex')],'image.dat',{type:'application/octet-stream'});
        assert.equal((await normalizeImageFile(file)).type,type);
    }
    for(const bytes of ['not an image','RIFF1234WAVE','GIF8','<svg></svg>'])await assert.rejects(normalizeImageFile(new File([bytes],'fake.png',{type:'image/png'})),error=>error.message.includes('fake.png')&&error.message.includes('格式')&&!error.message.includes('12 MB'));
});
test('单张文件大小、空文件与读取失败分别提示，超限时不读取图片内容',async()=>{
    const file=new File([pngBytes],'large.png',{type:'image/png'});Object.defineProperty(file,'size',{value:12*1024*1024+1});
    file.slice=()=>{throw new Error('must not read oversized file');};
    await assert.rejects(normalizeImageFile(file),error=>error.message.includes('large.png')&&error.message.includes('超过单张 12 MB'));
    await assert.rejects(normalizeImageFile(new File([],'empty.png')),/空文件/);
    await assert.rejects(normalizeImageFile({name:'unavailable.png',size:20,slice:()=>({arrayBuffer:async()=>{throw new Error('provider failure');}})}),/无法读取.*unavailable.png/);
});
test('从文件头识别 BMP、TIFF、ICO、AVIF 与 HEIF 系列，不依赖文件扩展名',async()=>{
    const entries=[['424d460000000000000036000000','image/bmp'],['49492a0008000000','image/tiff'],['4d4d002a00000008','image/tiff'],['000001000100','image/x-icon'],
        ['000000186674797061766966000000006d69663161766966','image/avif'],['00000018667479706d696631000000006176696669736f6d','image/avif'],
        ['000000186674797068656963000000006d69663168656963','image/heic'],['00000014667479706d696631000000006d696631','image/heif']];
    for(const [hex,type]of entries)assert.equal((await normalizeImageFile(new File([Buffer.from(hex,'hex')],'image.unknown',{type:''}))).type,type);
});
test('12 MB 限制按单张判断，超过 12 MB 的整包和第 36 张通用类型图片仍可逐张通过',async()=>{
    for(let index=0;index<40;index++){
        const file=new File([pngBytes,new Uint8Array(320*1024)],'image-'+index+'.png',{type:index===35?'application/octet-stream':'image/png'});
        assert.equal((await normalizeImageFile(file)).type,'image/png');
    }
    const boundary=new File([pngBytes],'boundary.png',{type:'image/png'});Object.defineProperty(boundary,'size',{value:12*1024*1024});
    assert.equal(await normalizeImageFile(boundary),boundary);
});
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
test('已编号旧 CG 自动转为同名单图包，宏与状态保持原样，落盘延后到图片迁移完成',()=>{
    const legacy={...make({cgId:7}),cgs:[{name:'旧图',src:image},{name:'旧图二',src:'https://example.com/old.png'}]};
    const ctx=context([legacy]);let saves=0;ctx.saveSettingsDebounced=()=>saves++;
    ctx.chat[0].mes='原文 {{7.旧图}}';ctx.chatMetadata[CHARACTERS_KEY]={states:{'old-a':{age:42,relationship:[{角色B:'伙伴'}]}}};
    const before=JSON.stringify([ctx.chat,ctx.chatMetadata]), prompt=cgPrompt([legacy]);
    ensureCharacterIDs(ctx);
    const upgraded=ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png'][0];
    assert.deepEqual(upgraded.cgs,[{name:'旧图',images:[image]},{name:'旧图二',images:['https://example.com/old.png']}]);
    assert.equal(upgraded.cgId,7);assert.equal(cgPrompt([upgraded]),prompt);
    assert.equal(JSON.stringify([ctx.chat,ctx.chatMetadata]),before);
    ensureCharacterIDs(ctx);assert.equal(saves,0);
});
test('每个角色可保存超过 200 张 CG，仍校验图片来源、包名和 200 个包的上限',()=>{
    const images=[image,'https://example.com/two.webp'];
    assert.deepEqual(validateCGs([{name:'日常',images}]),[{name:'日常',images}]);
    for(const sources of [[],null,'bad',[image,'javascript:bad()'],[{src:image}]])assert.throws(()=>validateCGs([{name:'日常',images:sources}]));
    assert.throws(()=>validateCGs([{name:'同名',images},{name:'同名',images}]),/重复/);
    const packs = Array.from({length:200}, (_,index) => ({name:'包'+index,images:[image]}));
    packs[0].images = Array.from({length:1000}, (_,index) => 'https://example.com/'+index+'.webp');
    assert.deepEqual(validateCGs(packs),packs);
    assert.throws(()=>validateCGs([...packs,{name:'额外的包',images:[image]}]),/200 个 CG 图片包/);
});
test('旧 CG 按末尾完整数字合并同前缀，单图保留；只向模型公开包名，历史宏精确指向旧图',()=>{
    const second='https://example.com/two.png';
    const legacy=[{name:'休闲装1',src:image},{name:'泳装12',src:second},{name:'休闲装2',src:second},
        {name:'肖像',src:image},{name:'123',src:image},{name:'第2章夜景3',src:image},
        ...Array.from({length:199},(_,i)=>({name:'休闲装'+(i+3),src:'https://example.com/'+(i+3)+'.webp'}))];
    const ctx=context([{...make({cgId:0}),cgs:legacy}]);ensureCharacterIDs(ctx);
    const character=ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png'][0];
    assert.deepEqual(character.cgs.map(pack=>pack.name),['休闲装','泳装','肖像','123','第2章夜景']);
    const expectedImages = legacy.filter(item => item.name.startsWith('休闲装')).map(item => item.src);
    assert.deepEqual(character.cgs[0].images,expectedImages);
    const lookup=cgLookup([character]);
    assert.deepEqual(lookup.get('{{0.休闲装}}').images,expectedImages);
    assert.deepEqual(lookup.get('{{0.休闲装201}}').images,['https://example.com/201.webp']);
    assert.deepEqual(lookup.get('{{0.休闲装1}}').images,[image]);
    assert.deepEqual(lookup.get('{{0.休闲装2}}').images,[second]);
    assert(cgPrompt([character]).includes('{{0.泳装}}'));assert(!cgPrompt([character]).includes('{{0.泳装12}}'));
    const restored=validateSnapshot(createSnapshot(ctx)).settings[CHARACTERS_KEY].cards['character:cg-card.png'][0];
    assert.deepEqual(restored.cgs,character.cgs);assert.deepEqual(validateCGs(character.cgs),character.cgs);
    assert.equal(validateCGs([{name:'新包12',images:[image]}])[0].name,'新包12');
});
test('旧 CG 合并遇到现有同名包时保留单图，合并组另取唯一包名，不覆盖旧宏',()=>{
    const packs=validateCGs([{name:'休闲装1',src:image},{name:'休闲装',src:'https://example.com/plain.png'},
        {name:'休闲装2',src:'https://example.com/two.png'},{name:'休闲装（旧图包）',images:[image]}]);
    assert.deepEqual(packs.map(pack=>pack.name),['休闲装（旧图包2）','休闲装','休闲装（旧图包）']);
    assert.equal(packs[0].images.length,2);assert.equal(packs[1].images.length,1);
    assert.equal(cgLookup([{cgId:0,name:'A',cgs:packs}]).get('{{0.休闲装}}').images[0],'https://example.com/plain.png');
    assert.throws(()=>validateCGs([{name:'日常',images:[image],aliases:[{name:'旧图1',index:1}]}]),/不存在/);
    assert.throws(()=>validateCGs([{name:'日常',images:[image],aliases:[{name:'旧图1',index:0}]},{name:'旧图1',images:[image]}]),/重复/);
});
test('图片包随机选择覆盖首尾图片，按消息和滑动回复缓存，删除所选图片后重新选择',()=>{
    let draws=0;const values=[0,.999,.4,.999,0];const picker=createCGPicker(()=>values[draws++]);
    const first={swipe_id:0},second={swipe_id:0},images=['a','b','c'];
    assert.equal(picker.pick(first,'{{0.日常}}',images),'a');
    first.mes='流式追加';assert.equal(picker.pick(first,'{{0.日常}}',[...images]),'a');assert.equal(draws,1);
    assert.equal(picker.pick(second,'{{0.日常}}',images),'c');
    assert.equal(picker.pick(first,'{{1.日常}}',images),'b');
    first.swipe_id=1;assert.equal(picker.pick(first,'{{0.日常}}',images),'c');
    assert.equal(picker.pick(first,'{{0.日常}}',['a','b']),'a');
    assert.equal(picker.pick(first,'{{0.日常}}',[]),null);
    picker.clear();assert.equal(picker.pick(first,'{{0.日常}}',['new']),'new');
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
    const characters=validateDirectory([make({cgs:[{name:'B',images:[image,'https://example.com/hidden-filename.png']},{name:'C',images:[image]}]}),make({id:'b',name:'角色B',keywords:'角色B',cgs:[{name:'日常',src:image}]}),make({id:'c',name:'空CG',keywords:'空CG'})]);
    assert.equal(cgPrompt(characters),'<0_角色A>\n{{0.B}}\n{{0.C}}\n</0_角色A>\n\n<1_角色B>\n{{1.日常}}\n</1_角色B>');
    const selected=selectCharacters(context(characters));
    assert.equal(selected.cgContent,'<0_角色A>\n{{0.B}}\n{{0.C}}\n</0_角色A>');
    assert(!selected.cgContent.includes('data:image'));assert(!selected.cgContent.includes('hidden-filename'));
    assert.deepEqual(cgLookup(characters).get('{{1.日常}}').images,[image]);
    assert.equal(cgLookup(characters).get('{{0.B}}').images.length,2);
});
test('描述中图片宏保持原文，同名角色使用不同标签，不误选另一个角色的状态',()=>{
    const characters=validateDirectory([make({description:'{{age}} {{0.B}}'}),make({id:'b',description:'{{age}} {{1.B}}',baseState:{age:99}})]);
    const result=selectCharacters(context(characters));
    assert(result.content.includes('<0_角色A>\n20 {{0.B}}'));assert(result.content.includes('<1_角色A>\n99 {{1.B}}'));
    assert(!result.content.includes('undefined'));
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
    const character=make({cgId:0,description:'{{age}} {{user}} {{char}} {{0.B}}',stages:[
        {id:'one',name:'成年',content:'已成年',conditions:[{path:'age',op:'>=',value:18}]},
        {id:'two',name:'年长',content:'不应发送',conditions:[{path:'age',op:'>=',value:80}]}]});
    const item={...renderCharacter(character,character.baseState),tag:characterTag(character)};
    assert.equal(await characterTokenCount(ctx,item),83);
    assert.equal(measured,'<0_角色A>\n20 用户 主角 {{0.B}}\n\n已成年\n</0_角色A>');
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
    const ctx=context(validateDirectory([make({cgs:[{name:'B',images:[image,'https://example.com/two.webp']}]})]));
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
    const {store:assetStore}=memoryAssetHost();
    ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png']=[];
    await restoreSnapshot(snapshot,ctx,{assetStore});
    const restored=ctx.extensionSettings[CHARACTERS_KEY];
    assert.equal(await assetStore.read(restored.cards['character:cg-card.png'][0].cgs[0].images[0]),image);
    assert.equal(nextCharacterID(ctx),9);assert.equal(restored.cgRenderCount,2);
    const bad=structuredClone(snapshot);bad.settings[CHARACTERS_KEY].cgRenderCount=-1;
    assert.throws(()=>validateSnapshot(bad),/楼数/);
    const badCG=structuredClone(snapshot);badCG.settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgs[0].images[0]='javascript:evil()';
    assert.throws(()=>validateSnapshot(badCG));
    const legacy=createSnapshot(context([make()]));delete legacy.settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgId;
    assert.equal(validateSnapshot(legacy).settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgId,0);
    legacy.settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgs=[{name:'旧图',src:image}];
    assert.deepEqual(validateSnapshot(legacy).settings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgs,[{name:'旧图',images:[image]}]);
    const multi=createSnapshot(context(validateDirectory([make({cgs:[{name:'多图',images:[image,'https://example.com/second.png']}]})])));
    await restoreSnapshot(multi,ctx,{assetStore});
    assert.equal(ctx.extensionSettings[CHARACTERS_KEY].cards['character:cg-card.png'][0].cgs[0].images.length,2);
});
