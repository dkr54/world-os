import { LAB_LIMIT, validatePackage, packagePath } from './laboratory-core.js';

let crcTable;
export function crc32(data) {
    crcTable ??= Uint32Array.from({length:256},(_,i) => { let n=i; for(let j=0;j<8;j++) n=(n&1)?0xedb88320^(n>>>1):n>>>1; return n>>>0; });
    let crc=0xffffffff; for(const byte of data) crc=crcTable[(crc^byte)&255]^(crc>>>8); return (crc^0xffffffff)>>>0;
}
function base64(data) {
    let text=''; for(let i=0;i<data.length;i+=8192) text+=String.fromCharCode(...data.subarray(i,i+8192));
    return btoa(text);
}
async function inflate(data,size) {
    let decoder;
    try { decoder=new DecompressionStream('deflate-raw'); }
    catch { throw new Error('当前 WebView 不支持 ZIP 解压。请更新 WebView，或导入 .worldos.json 功能包。'); }
    const reader=new Blob([data]).stream().pipeThrough(decoder).getReader(), chunks=[]; let length=0;
    try {
        while(true) { const {value,done}=await reader.read(); if(done)break; length+=value.length;
            if(length>size||length>LAB_LIMIT)throw new Error('ZIP 解压内容超出声明大小。'); chunks.push(value); }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    if(length!==size)throw new Error('ZIP 文件大小校验失败。');
    const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
export async function readPackageZip(input) {
    const data=input instanceof Uint8Array?input:new Uint8Array(input);
    if(data.length>LAB_LIMIT||data.length<22)throw new Error('ZIP 文件大小无效，最多 8 MB。');
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength), u16=p=>view.getUint16(p,true),u32=p=>view.getUint32(p,true);
    let end=-1;
    for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===data.length){end=i;break;}
    if(end<0||u16(end+4)||u16(end+6)||u16(end+8)!==u16(end+10))throw new Error('不支持分卷或损坏的 ZIP。');
    const count=u16(end+10), directorySize=u32(end+12), start=u32(end+16);
    if(!count||count>150||start+directorySize!==end)throw new Error('ZIP 目录无效或文件过多。');
    const entries=new Map(), decoder=new TextDecoder('utf-8',{fatal:true});let cursor=start,total=0;
    for(let i=0;i<count;i++){
        if(cursor+46>end||u32(cursor)!==0x02014b50)throw new Error('ZIP 目录不完整。');
        const flags=u16(cursor+8),method=u16(cursor+10),crc=u32(cursor+16),packed=u32(cursor+20),size=u32(cursor+24),
            nameSize=u16(cursor+28),extraSize=u16(cursor+30),commentSize=u16(cursor+32),local=u32(cursor+42);
        if(cursor+46+nameSize+extraSize+commentSize>end||(flags&1)||![0,8].includes(method)||size===0xffffffff)throw new Error('不支持加密、ZIP64 或该压缩格式。');
        const name=decoder.decode(data.subarray(cursor+46,cursor+46+nameSize));
        cursor+=46+nameSize+extraSize+commentSize;
        if(name.endsWith('/')){packagePath(name.slice(0,-1));continue;}
        packagePath(name); if(entries.has(name))throw new Error('ZIP 包含重复文件路径。');
        total+=size;if(total>LAB_LIMIT)throw new Error('ZIP 展开后不能超过 8 MB。');
        if(local+30>start||u32(local)!==0x04034b50||u16(local+8)!==method||u16(local+6)!==flags)throw new Error('ZIP 文件头不一致。');
        const localNameSize=u16(local+26),offset=local+30+localNameSize+u16(local+28);
        if(offset+packed>start||decoder.decode(data.subarray(local+30,local+30+localNameSize))!==name)throw new Error('ZIP 文件范围无效。');
        const bytes=method===0?data.slice(offset,offset+packed):await inflate(data.subarray(offset,offset+packed),size);
        if(bytes.length!==size||crc32(bytes)!==crc)throw new Error('ZIP 文件校验失败。');
        entries.set(name,bytes);
    }
    if(cursor!==end)throw new Error('ZIP 目录长度不一致。');
    const manifests=[...entries.keys()].filter(p=>p==='manifest.json'||/^[^/]+\/manifest\.json$/.test(p));
    if(manifests.length!==1)throw new Error('ZIP 根目录或唯一外层文件夹中需要一个 manifest.json。');
    const manifestPath=manifests[0],prefix=manifestPath.slice(0,-'manifest.json'.length);
    const manifest=JSON.parse(decoder.decode(entries.get(manifestPath)).replace(/^\uFEFF/,''));
    const files={};
    for(const [path,bytes]of entries){
        if(!path.startsWith(prefix))throw new Error('ZIP 存在包目录以外的文件。');
        const name=path.slice(prefix.length);if(name==='manifest.json')continue;
        const ext=name.split('.').at(-1).toLowerCase();
        if(['png','jpg','jpeg','gif','webp'].includes(ext))files[name]='data:image/'+(ext==='jpg'?'jpeg':ext)+';base64,'+base64(bytes);
        else files[name]=decoder.decode(bytes);
    }
    return validatePackage({...manifest,files});
}
export async function readPackageFile(file) {
    if(!file||file.size>LAB_LIMIT)throw new Error('功能包文件不能超过 8 MB。');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(bytes[0]===0x50&&bytes[1]===0x4b)return readPackageZip(bytes);
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));}
    catch{throw new Error('请选择有效的 .worldos.json 或 ZIP 功能包。');}
    return validatePackage(value);
}
export function examplePackage() {
    return {format:'world-os-package',schema:1,id:'demo.notes',name:'示例笔记',version:'1.0.0',description:'演示同一卡共享配置，以及各聊天独立保存笔记。',author:'world os',icon:'fa-note-sticky',permissions:[],entry:'index.html',
        defaultSettings:{title:'我的笔记'},files:{
            'index.html':'<main><h1 id="title"></h1><p id="scope"></p><label>标题（同一卡共享）<input id="heading"></label><button id="save-settings">保存标题</button><label>笔记（当前聊天）<textarea id="note" rows="8"></textarea></label><button id="save-note">保存笔记</button><p id="status" role="status"></p></main><script src="app.js"></script>',
            'app.js':"(async()=>{await worldOS.ready;const c=await worldOS.getContext(),s=await worldOS.getSettings(),v=await worldOS.getState();const q=id=>document.getElementById(id);q('title').textContent=s.title||'笔记';q('heading').value=s.title||'';q('scope').textContent=c.characterName+' · '+(c.chatId||'尚未打开聊天');q('note').value=v.note||'';q('save-settings').onclick=async()=>{try{await worldOS.setSettings({title:q('heading').value});q('title').textContent=q('heading').value;q('status').textContent='标题已保存';}catch(e){q('status').textContent=e.message;}};q('save-note').onclick=async()=>{try{await worldOS.setState({note:q('note').value});q('status').textContent='笔记已保存';}catch(e){q('status').textContent=e.message;}};})().catch(e=>worldOS.notify(e.message));",
        }};
}
