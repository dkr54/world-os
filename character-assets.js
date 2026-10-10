/** Large image bytes belong in the host's image directory, never in settings.json. */
export const ASSET_FOLDER = 'world-os-cg';
export const MAX_ASSET_BYTES = 1500000;
const localPattern = /^\/?user\/images\/world-os-cg\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/;
const dataPattern = /^data:image\/(png|jpeg|webp|gif);base64,/;

export const isLocalCharacterAsset = value => typeof value === 'string' && localPattern.test(value);
export const isEmbeddedCharacterAsset = value => typeof value === 'string' && dataPattern.test(value);
const canonical = value => '/' + value.replace(/^\//,'');
const SHA256_K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
export async function assetDigest(bytes, subtle = globalThis.crypto?.subtle) {
    if (subtle) return [...new Uint8Array(await subtle.digest('SHA-256',bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
    // LAN HTTP SillyTavern may not expose SubtleCrypto. Keep filenames/verification identical there.
    const padded = new Uint8Array(Math.ceil((bytes.length+9)/64)*64), words = new Uint32Array(64);
    padded.set(bytes); padded[bytes.length] = 0x80;
    const data = new DataView(padded.buffer);
    data.setUint32(padded.length-8,Math.floor(bytes.length/0x20000000)); data.setUint32(padded.length-4,bytes.length*8);
    const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const rotate = (value,bits) => (value >>> bits) | (value << (32-bits));
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = data.getUint32(offset+i*4);
        for (let i = 16; i < 64; i++) {
            const a = words[i-15], b = words[i-2];
            words[i] = words[i-16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + words[i-7] + (rotate(b,17)^rotate(b,19)^(b>>>10));
        }
        let [a,b,c,d,e,f,g,h] = hash;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + SHA256_K[i] + words[i]) >>> 0;
            const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
            h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
        }
        for (const [index,value] of [a,b,c,d,e,f,g,h].entries()) hash[index] += value;
    }
    return [...hash].map(value => value.toString(16).padStart(8,'0')).join('');
}

function decodeDataURL(source) {
    const match = typeof source === 'string' && source.match(dataPattern);
    if (!match || source.length > 2000000) throw new Error('本地角色图片格式无效或过大。');
    let binary;
    try { binary = atob(source.slice(match[0].length)); } catch { throw new Error('本地角色图片数据损坏。'); }
    if (!binary.length || binary.length > MAX_ASSET_BYTES) throw new Error('本地角色图片为空或过大。');
    return { bytes:Uint8Array.from(binary,letter => letter.charCodeAt(0)),format:match[1] === 'jpeg' ? 'jpg' : match[1],offset:match[0].length };
}
function encodeDataURL(bytes, format) {
    const chunks = [];
    for (let index = 0; index < bytes.length; index += 32768) chunks.push(String.fromCharCode(...bytes.subarray(index,index+32768)));
    return 'data:image/' + (format === 'jpg' ? 'jpeg' : format) + ';base64,' + btoa(chunks.join(''));
}

/** Both SillyTavern and TauriTavern implement this host-local endpoint. No third-party upload. */
export function createCharacterAssetStore({ fetchFn = (...args) => fetch(...args),
    getHeaders = () => globalThis.SillyTavern?.getContext?.().getRequestHeaders?.() ?? { 'Content-Type':'application/json' },
    timeoutMs = 30000 } = {}) {
    async function request(url, options, consume) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(),timeoutMs);
        try { return await consume(await fetchFn(url,{ ...options,signal:controller.signal })); }
        catch (error) {
            if (error.name === 'AbortError') throw new Error('保存/读取角色图片超时；原图片数据已保留，可重试。');
            throw error;
        } finally { clearTimeout(timer); }
    }
    async function readBytes(path, missingOK = false) {
        if (!isLocalCharacterAsset(path)) throw new Error('角色图片文件地址无效。');
        const [,hash,format] = path.match(localPattern);
        return request(canonical(path),{ cache:'no-store' },async response => {
            if (missingOK && response.status === 404) return null;
            if (!response.ok) throw new Error('无法读取角色图片文件（HTTP ' + response.status + '）。');
            if (Number(response.headers?.get('content-length')) > MAX_ASSET_BYTES) throw new Error('角色图片文件过大。');
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!bytes.length || bytes.length > MAX_ASSET_BYTES || await assetDigest(bytes) !== hash) {
                if (missingOK) return null; // An interrupted earlier write can be repaired from the embedded original.
                throw new Error('角色图片文件校验失败；原图片数据已保留。');
            }
            return { bytes,format };
        });
    }
    let queue = Promise.resolve();
    async function saveOne(source) {
        if (!isEmbeddedCharacterAsset(source)) return source;
        const { bytes,format,offset } = decodeDataURL(source), hash = await assetDigest(bytes);
        const path = '/user/images/' + ASSET_FOLDER + '/' + hash + '.' + format;
        // A stopped migration can resume without rewriting files that were already verified.
        if (await readBytes(path,true)) return path;
        await request('/api/images/upload',{ method:'POST',headers:await getHeaders(),
            body:JSON.stringify({ image:source.slice(offset),format,ch_name:ASSET_FOLDER,filename:hash }) },async response => {
            if (!response.ok) throw new Error('无法保存角色图片（HTTP ' + response.status + '）；请检查设备剩余空间。');
            const result = await response.json();
            if (!isLocalCharacterAsset(result.path) || canonical(result.path) !== path) throw new Error('宿主返回的角色图片地址不正确；原数据已保留。');
        });
        // Verify persisted bytes before dropping the embedded original from settings.
        await readBytes(path);
        return path;
    }
    return {
        save(source) {
            const job = queue.then(() => saveOne(source));
            queue = job.catch(() => {}); return job;
        },
        async read(path) { const { bytes,format } = await readBytes(path); return encodeDataURL(bytes,format); },
    };
}

function* imageSlots(config) {
    for (const characters of Object.values(config?.cards ?? {})) for (const character of characters) {
        if (character.avatar) yield [character,'avatar'];
        for (const pack of character.cgs ?? []) {
            if (Array.isArray(pack.images)) { for (let index = 0; index < pack.images.length; index++) yield [pack.images,index]; }
            else if (pack.src) yield [pack,'src'];
        }
    }
}
export function hasEmbeddedCharacterImages(config) {
    for (const [object,key] of imageSlots(config)) if (isEmbeddedCharacterAsset(object[key])) return true;
    return false;
}
function copyImageContainers(config) {
    return { ...config,cards:Object.fromEntries(Object.entries(config.cards ?? {}).map(([owner,characters]) => [owner,
        characters.map(character => ({ ...character,...(character.cgs ? {cgs:character.cgs.map(pack => ({ ...pack,
            ...(Array.isArray(pack.images) ? { images:[...pack.images] } : {}) }))} : {}) })),
    ])) };
}

/** Stage only small containers. Never stringify or copy the whole embedded image collection. */
export async function migrateCharacterImages(config, store, { onProgress = () => {}, check = () => {} } = {}) {
    if (!hasEmbeddedCharacterImages(config)) return config;
    const next = copyImageContainers(config);
    let total = 0, completed = 0;
    for (const [object,key] of imageSlots(next)) if (isEmbeddedCharacterAsset(object[key])) total++;
    for (const [object,key] of imageSlots(next)) {
        if (!isEmbeddedCharacterAsset(object[key])) continue;
        check(); onProgress(completed,total);
        object[key] = await store.save(object[key]);
        check(); onProgress(++completed,total);
    }
    // Commit belongs to the caller. A failure leaves every original field untouched.
    return next;
}

/** Portable snapshots embed files again, one at a time, under the existing size budget. */
export async function embedCharacterImages(config, store, { addBytes = () => {}, onProgress = () => {} } = {}) {
    let total = 0, completed = 0;
    for (const [object,key] of imageSlots(config)) if (isLocalCharacterAsset(object[key])) total++;
    for (const [object,key] of imageSlots(config)) {
        if (!isLocalCharacterAsset(object[key])) continue;
        const source = await store.read(object[key]);
        addBytes(source.length - object[key].length);
        object[key] = source; onProgress(++completed,total);
    }
}
