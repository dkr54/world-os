import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { assetDigest, isLocalCharacterAsset, hasEmbeddedCharacterImages, migrateCharacterImages, createCharacterAssetStore } from '../character-assets.js';
import { CHARACTERS_KEY, ensureCharacterIDs, validateDirectory } from '../characters-core.js';
import { createPortableSnapshot, createSnapshot, restoreSnapshot } from '../snapshots.js';
import { memoryAssetHost } from './asset-store-fixture.js';

const image = (text = 'one') => 'data:image/png;base64,' + Buffer.from(text).toString('base64');
const config = () => ({ cards:{ 'character:card.png':[{id:'a',name:'角色A',keywords:[],cgs:[
    { name:'包',images:[image(),image('two')],aliases:[{name:'包1',index:0}] },
]}] } });
const context = data => ({ characterId:0,characters:[{avatar:'card.png'}],chatId:'chat',chatMetadata:{},
    extensionSettings:{[CHARACTERS_KEY]:data},saveMetadata:async () => {},saveSettingsDebounced:() => {} });

test('HTTP 环境的 SHA-256 与原生实现一致，包括大图和分块边界',async () => {
    for (const size of [0,1,55,56,63,64,65,4097,1499980]) {
        const bytes = randomBytes(size), expected = createHash('sha256').update(bytes).digest('hex');
        assert.equal(await assetDigest(bytes,null),expected); assert.equal(await assetDigest(bytes),expected);
    }
});
test('本地路径严格限定插件图片目录，上传与回读校验并去重，网络图不上传',async () => {
    const host = memoryAssetHost(), path = await host.store.save(image());
    assert(isLocalCharacterAsset(path)); assert.equal(await host.store.read(path),image());
    assert.equal(await host.store.save(image()),path); assert.equal(host.uploads.length,1);
    assert.equal(await host.store.save('https://example.com/image.png'),'https://example.com/image.png');
    for (const value of ['/user/images/other/a.png','/user/images/world-os-cg/../x','file:///a','//host/user/images/world-os-cg/a.png',path+'?x=1']) assert(!isLocalCharacterAsset(value));
    assert.equal(host.peak,1);
});
test('失败和磁盘写坏不提交迁移；重试复用已成功文件，不删除原图',async () => {
    const host = memoryAssetHost(), original = config(), before = JSON.stringify(original);
    host.failUpload = 2;
    await assert.rejects(migrateCharacterImages(original,host.store),/507/); assert.equal(JSON.stringify(original),before);
    host.failUpload = 0;
    const next = await migrateCharacterImages(original,host.store);
    assert(!hasEmbeddedCharacterImages(next)); assert.equal(JSON.stringify(original),before); assert.equal(host.uploads.length,3);
    assert.deepEqual(next.cards['character:card.png'][0].cgs[0].aliases,[{name:'包1',index:0}]);
    const damaged = memoryAssetHost(); damaged.corrupt = true;
    await assert.rejects(migrateCharacterImages(original,damaged.store),/校验失败/); assert.equal(JSON.stringify(original),before);
    damaged.corrupt = false;
    assert(!hasEmbeddedCharacterImages(await migrateCharacterImages(original,damaged.store)));
});
test('并发上传串行落盘，设置变化时停止迁移，旧格式和头像完整保留',async () => {
    const host = memoryAssetHost(); await Promise.all([host.store.save(image()),host.store.save(image('two'))]); assert.equal(host.peak,1);
    const original = {cards:{'a':[{avatar:image(),cgs:[{name:'泳装1',src:image('two')}]}]}};
    let n = 0;
    await assert.rejects(migrateCharacterImages(original,host.store,{check:() => {if (++n === 2) throw new Error('changed');}}),/changed/);
    assert.equal(original.cards.a[0].cgs[0].src,image('two'));
    const next = await migrateCharacterImages(original,host.store);
    assert(isLocalCharacterAsset(next.cards.a[0].avatar)); assert(isLocalCharacterAsset(next.cards.a[0].cgs[0].src));
});
test('旧 CG 补号不会提前保存巨大的内嵌图片设置',() => {
    const ctx = context(config()); let saves = 0; ctx.saveSettingsDebounced = () => saves++;
    ensureCharacterIDs(ctx); assert.equal(saves,0); assert.equal(ctx.extensionSettings[CHARACTERS_KEY].cards['character:card.png'][0].cgId,0);
});
test('45 个角色 540 张本地图片逐张迁移，保存体积降至 100 KB 以下',async t => {
    const characters = [], host = memoryAssetHost(); let embeddedBytes = 0;
    for (let person = 0; person < 45; person++) {
        const images = [];
        for (let i = 0; i < 12; i++) {
            const bytes = Buffer.alloc(128*1024,person); bytes.writeUInt32BE(person*12+i);
            const source = image(bytes); embeddedBytes += source.length; images.push(source);
        }
        characters.push({id:'p'+person,name:'角色'+person,cgs:[{name:'休闲装',images}]});
    }
    const original = { cards:{a:characters} };
    const next = await migrateCharacterImages(original,host.store), size = Buffer.byteLength(JSON.stringify(next));
    assert.equal(host.uploads.length,540); assert.equal(host.peak,1); assert(size < 100000);
    assert(host.uploads.every(item => item.bytes < 200000));
    assert.equal(next.cards.a.reduce((total,item) => total+item.cgs[0].images.length,0),540);
    assert.equal(original.cards.a[0].cgs[0].images[0].startsWith('data:'),true);
    t.diagnostic(JSON.stringify({characters:45,images:540,embeddedBytes,settingsBytes:size,peakRequests:host.peak}));
});
test('文件图片快照包含原图，可在空白设备恢复为小配置，缺图或超限不导出',async () => {
    const host = memoryAssetHost(), original = config(); original.cards['character:card.png'] = validateDirectory(original.cards['character:card.png']);
    const ctx = context(await migrateCharacterImages(original,host.store));
    const portable = await createPortableSnapshot(ctx,false,{assetStore:host.store});
    assert.equal(portable.settings[CHARACTERS_KEY].cards['character:card.png'][0].cgs[0].images[0],image());
    assert(isLocalCharacterAsset(ctx.extensionSettings[CHARACTERS_KEY].cards['character:card.png'][0].cgs[0].images[0]));
    const other = memoryAssetHost(), target = context({cards:{}});
    await restoreSnapshot(portable,target,{assetStore:other.store}); assert(!hasEmbeddedCharacterImages(target.extensionSettings[CHARACTERS_KEY]));
    assert.equal(other.files.size,2);
    await assert.rejects(createPortableSnapshot(ctx,false,{assetStore:host.store,maxBytes:10}),/32 MB/);
    host.files.clear(); await assert.rejects(createPortableSnapshot(ctx,false,{assetStore:host.store}),/无法读取/);
});
test('旧快照图片保存失败或恢复期间切换聊天，不覆盖状态与设置',async () => {
    const original = config(); original.cards['character:card.png'] = validateDirectory(original.cards['character:card.png']);
    const ctx = context(original), snapshot = createSnapshot(ctx), host = memoryAssetHost(); host.failUpload = 1;
    await assert.rejects(restoreSnapshot(snapshot,ctx,{assetStore:host.store}),/507/); assert.equal(ctx.extensionSettings[CHARACTERS_KEY],original);
    await assert.rejects(restoreSnapshot(snapshot,ctx,{assetStore:{save:async source => { ctx.chatId='changed'; return source; }}}),/聊天或设置/);
    assert.equal(ctx.extensionSettings[CHARACTERS_KEY],original);
});
test('图片接口超时能取消，不把错误回包当成文件',async () => {
    const store = createCharacterAssetStore({timeoutMs:5,fetchFn:(_url,{signal}) => new Promise((_,reject) => {
        signal.addEventListener('abort',() => reject(new DOMException('timeout','AbortError')));
    })});
    await assert.rejects(store.save(image()),/超时/);
});
test('快照图片准备期间新写入的聊天状态不会被覆盖',async () => {
    const original = config(); original.cards['character:card.png'] = validateDirectory(original.cards['character:card.png']);
    const ctx = context(original), snapshot = createSnapshot(ctx);
    const edited = {states:{a:{age:42}}};
    await assert.rejects(restoreSnapshot(snapshot,ctx,{assetStore:{save:async source => {
        ctx.chatMetadata[CHARACTERS_KEY] = edited; return source;
    }}}),/聊天或设置/);
    assert.equal(ctx.chatMetadata[CHARACTERS_KEY],edited); assert.equal(ctx.extensionSettings[CHARACTERS_KEY],original);
});
