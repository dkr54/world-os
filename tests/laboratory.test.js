import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { LAB_KEY, LAB_LIMIT, validatePackage, validateLabSettings, configurePackage, installPackage, uninstallPackage, cardPackage, packageActive, savePackageState, packageState } from '../laboratory-core.js';
import { crc32, readPackageZip, readPackageFile, examplePackage } from '../laboratory-package.js';
import { sandboxDocument, LaboratoryRuntime } from '../laboratory-runtime.js';
import { createSnapshot, validateSnapshot, restoreSnapshot } from '../snapshots.js';
import { WORLD_KEY } from '../world-state.js';
const ctx=()=>({characterId:0,characters:[{avatar:'lab-card.png',name:'示例角色'}],chatId:'one',chat:[],chatMetadata:{},extensionSettings:{},saveMetadata:async()=>{},saveSettingsDebounced(){}});
function zip(files,{compress=false}={}) {
    const local=[],central=[];let offset=0;
    for(const [path,value]of Object.entries(files)){
        const name=Buffer.from(path),data=Buffer.from(value),body=compress?deflateRawSync(data):data,head=Buffer.alloc(30),entry=Buffer.alloc(46);
        head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(compress?8:0,8);head.writeUInt32LE(crc32(data),14);head.writeUInt32LE(body.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(name.length,26);
        entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,6);entry.writeUInt16LE(compress?8:0,10);entry.writeUInt32LE(crc32(data),16);entry.writeUInt32LE(body.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
        local.push(head,name,body);central.push(entry,name);offset+=head.length+name.length+body.length;
    }
    const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
    return Buffer.concat([...local,dir,end]);
}
test('global packages persist across cards; enabled/settings are per card and defaults are copied',()=>{
    const c=ctx();installPackage(c,examplePackage());assert.equal(packageActive(c,'demo.notes'),false);
    configurePackage(c,'demo.notes',{enabled:true,settings:{title:'共享标题'}});
    const another={...c,chatId:'two',chatMetadata:{}};
    assert.equal(packageActive(another,'demo.notes'),true);assert.equal(cardPackage(another,'demo.notes').settings.title,'共享标题');
    const other={...c,characters:[{avatar:'different.png'}]};assert.equal(Object.keys(other.extensionSettings[LAB_KEY].packages).length,1);assert.equal(packageActive(other,'demo.notes'),false);
    assert.equal(cardPackage(other,'demo.notes').settings.title,'我的笔记');
    configurePackage(other,'demo.notes',{settings:{}});assert.deepEqual(cardPackage(other,'demo.notes').settings,{});
    const copied=cardPackage(c,'demo.notes');copied.settings.title='edited';assert.equal(cardPackage(c,'demo.notes').settings.title,'共享标题');
});
test('updates preserve data; new permissions disable all cards; uninstall retains settings for reinstall',()=>{
    const c=ctx();installPackage(c,examplePackage());configurePackage(c,'demo.notes',{enabled:true,settings:{n:1}});
    const other={...c,characters:[{avatar:'second.png'}]};configurePackage(other,'demo.notes',{enabled:true,settings:{n:2}});
    installPackage(c,{...examplePackage(),version:'1.0.1'});assert(packageActive(c,'demo.notes'));
    installPackage(c,{...examplePackage(),version:'1.1.0',permissions:['chat.read']});
    assert(!packageActive(c,'demo.notes'));assert(!packageActive(other,'demo.notes'));assert.equal(cardPackage(other,'demo.notes').settings.n,2);
    uninstallPackage(c,'demo.notes');assert.equal(Object.keys(c.extensionSettings[LAB_KEY].packages).length,0);
    installPackage(c,examplePackage());assert.equal(cardPackage(c,'demo.notes').settings.n,1);assert(!packageActive(c,'demo.notes'));
});
test('invalid IDs, paths, unsupported permissions and oversized packages rejected before settings mutate',()=>{
    const c=ctx();installPackage(c,examplePackage());const before=JSON.stringify(c.extensionSettings);
    for(const change of [{id:'characters'},{id:'__proto__'},{id:'x/../z'},{permissions:['api.secret']},{entry:'absent.html'},{files:{'../index.html':'x'}},{files:{'index.html':'x','x.exe':'x'}},{icon:'fa-x onclick=x'}])assert.throws(()=>installPackage(c,{...examplePackage(),...change}));
    assert.equal(JSON.stringify(c.extensionSettings),before);
    assert.throws(()=>configurePackage({...c,characterId:9},'demo.notes',{enabled:true}));
    assert.throws(()=>configurePackage(c,'demo.notes',{settings:JSON.parse('{"__proto__":{}}')}));
    assert.throws(()=>configurePackage(c,'demo.notes',{settings:{text:'x'.repeat(270000)}}));
    assert.throws(()=>validatePackage({...examplePackage(),files:{'index.html':'x'.repeat(2000000)}}));
    assert.throws(()=>validateLabSettings({cards:{a:{'demo.notes':{enabled:'yes'}}}}));
});
test('JSON import validates real contents and file size',async()=>{
    const pkg=await readPackageFile(new Blob([JSON.stringify(examplePackage())]));assert.equal(pkg.id,'demo.notes');
    await assert.rejects(()=>readPackageFile(new Blob(['invalid'])));
    await assert.rejects(()=>readPackageFile({size:LAB_LIMIT+1}));
});
test('ZIP import supports stored/deflated files and one enclosing folder with CRC verification',async()=>{
    const {files,...manifest}=examplePackage();
    for(const compress of [false,true])for(const prefix of ['','notes/']){
        const input=Object.fromEntries(Object.entries({'manifest.json':JSON.stringify(manifest),...files}).map(([name,value])=>[prefix+name,value]));
        assert.deepEqual(await readPackageZip(zip(input,{compress})),validatePackage(examplePackage()));
    }
    const broken=zip({'manifest.json':JSON.stringify(manifest),...files});broken[35]^=1;
    await assert.rejects(()=>readPackageZip(broken));
});
test('ZIP paths, duplicate manifests, missing manifests and decompression bombs rejected',async()=>{
    await assert.rejects(()=>readPackageZip(zip({'../manifest.json':'{}'})));
    await assert.rejects(()=>readPackageZip(zip({'manifest.json':'{}','other/manifest.json':'{}'})));
    await assert.rejects(()=>readPackageZip(zip({'nothing.txt':'x'})));
    const bomb=zip({'x.txt':'x'.repeat(100000)},{compress:true});
    const central=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bomb.writeUInt32LE(1,central+24);
    await assert.rejects(()=>readPackageZip(bomb),/超出/);
});
test('chat state is isolated, save failures rollback, switching chat rejects a delayed write',async()=>{
    let c=ctx();installPackage(c,examplePackage());configurePackage(c,'demo.notes',{enabled:true});
    await savePackageState(c,'demo.notes',{note:'one'});assert.equal(packageState(c,'demo.notes').note,'one');
    const second={...c,chatId:'two',chatMetadata:{}};assert.deepEqual(packageState(second,'demo.notes'),{});
    c.saveMetadata=async()=>{throw new Error('disk full');};await assert.rejects(()=>savePackageState(c,'demo.notes',{note:'bad'}));assert.equal(packageState(c,'demo.notes').note,'one');
    let finish;c.saveMetadata=()=>new Promise(resolve=>{finish=resolve;});const old=c;
    const pending=savePackageState(c,'demo.notes',{note:'late'},{getContext:()=>c});c=second;finish();
    await assert.rejects(pending,/聊天已变化/);assert.deepEqual(packageState(c,'demo.notes'),{});assert.equal(packageState(old,'demo.notes').note,'one');
});
test('master disabled refuses writes without deleting per-card choice',async()=>{
    const c=ctx();installPackage(c,examplePackage());configurePackage(c,'demo.notes',{enabled:true});
    c.extensionSettings[WORLD_KEY]={enabled:false};assert(!packageActive(c,'demo.notes'));assert(cardPackage(c,'demo.notes').enabled);
    await assert.rejects(()=>savePackageState(c,'demo.notes',{}));
});
test('snapshot round trip includes packages/card config/chat state; legacy restore preserves new lab module',async()=>{
    const c=ctx();installPackage(c,examplePackage());configurePackage(c,'demo.notes',{enabled:true});await savePackageState(c,'demo.notes',{note:'kept'});
    const data=validateSnapshot(createSnapshot(c));assert.equal(data.settings[LAB_KEY].packages['demo.notes'].id,'demo.notes');
    const legacy=structuredClone(data);delete legacy.settings[LAB_KEY];delete legacy.metadata[LAB_KEY];validateSnapshot(legacy);
    await restoreSnapshot(legacy,c);assert.equal(packageState(c,'demo.notes').note,'kept');
    uninstallPackage(c,'demo.notes');await restoreSnapshot(data,c);assert(packageActive(c,'demo.notes'));assert.equal(packageState(c,'demo.notes').note,'kept');
    const invalid=structuredClone(data);invalid.settings[LAB_KEY].packages['demo.notes'].permissions=['anything'];assert.throws(()=>validateSnapshot(invalid));
});
test('sandbox markup escapes closing scripts and applies restrictive CSP without same-origin privilege',()=>{
    const pkg=examplePackage();pkg.files['index.html']='<script>bad()</script><img src="https://example.test/image">';
    const html=sandboxDocument(pkg,'token');assert.equal((html.match(/<\/script>/g)||[]).length,1);assert(html.includes("connect-src 'none'"));assert(html.includes("form-action 'none'"));assert(!html.includes('src="https://example.test/image"'));
});
test('bridge limits chat access, rejects unavailable methods, and guards stale scope',async()=>{
    let c=ctx();installPackage(c,examplePackage());const pkg=c.extensionSettings[LAB_KEY].packages['demo.notes'];configurePackage(c,pkg.id,{enabled:true});c.chat=[{is_user:true,mes:'visible'},{is_system:true,mes:'secret-system'}];
    const runtime=Object.create(LaboratoryRuntime.prototype);runtime.getContext=()=>c;runtime.onSettings=()=>{};runtime.onStatus=()=>{};
    const run={pkg,owner:'character:lab-card.png',scope:JSON.stringify(['character:lab-card.png','one']),metadata:c.chatMetadata};runtime.current=run;
    await assert.rejects(()=>runtime.request(run,'chat.get',{}),/未声明权限/);
    await assert.rejects(()=>runtime.request(run,'sendMessage',{}),/不支持/);
    pkg.permissions=['chat.read'];assert.deepEqual(await runtime.request(run,'chat.get',{}),[{role:'user',name:'',text:'visible'}]);
    const context=await runtime.request(run,'context',{});assert(!('extensionSettings'in context));
    c={...c,chatId:'other',chatMetadata:{}};await assert.rejects(()=>runtime.request(run,'settings.set',{value:{late:true}}),/上下文/);
});
