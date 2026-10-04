import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tauri = process.argv.includes('--tauri');
const artifactPrefix = tauri ? 'tauri-android' : 'browser';
const artifacts = resolve(workspace, '.tmp');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidates = [
    process.env.FLOOR_MEMORY_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
let browserPath;
for (const path of candidates) { try { await access(path); browserPath = path; break; } catch {} }
if (!browserPath) throw new Error('Set FLOOR_MEMORY_BROWSER to an installed Chromium/Edge/Chrome executable.');
const calls = [];
const modelCalls = [];
const rerankCalls = [];
const keywordCalls = [];
const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/__state') {
            response.writeHead(200, { 'Content-Type':'application/json' });
            response.end(JSON.stringify({ calls, modelCalls, rerankCalls, keywordCalls }));
            return;
        }
        if (url.pathname.endsWith('/models')) {
            modelCalls.push({ path:url.pathname, method:request.method, authorization:request.headers.authorization });
            if (url.pathname.startsWith('/failing-models/')) { response.writeHead(401); response.end('{}'); return; }
            if (url.pathname.startsWith('/slow-models/')) await sleep(1600);
            const ids = url.pathname.startsWith('/empty-models/') ? [] : url.pathname.startsWith('/slow-models/')
                ? ['stale-model'] : url.pathname.startsWith('/rerank-models/') ? ['test-reranker', 'private-rerank']
                : url.pathname.startsWith('/keyword/') ? ['small-instruct', 'other-chat'] : ['test-embedding', 'test-embedding-v2', 'private-opaque-id', 'test-embedding'];
            response.writeHead(200, { 'Content-Type':'application/json' });
            response.end(JSON.stringify({ data:ids.map(id => ({ id })) }));
            return;
        }
        if (url.pathname.endsWith('/chat/completions')) {
            let body = '';
            for await (const chunk of request) body += chunk;
            const parsed = JSON.parse(body);
            keywordCalls.push({ path:url.pathname, ...parsed, authorization:request.headers.authorization });
            if (url.pathname.startsWith('/partial-keywords/') && keywordCalls.filter(call => call.path === url.pathname).length === 2) {
                response.writeHead(503); response.end('{}'); return;
            }
            if (url.pathname.startsWith('/slow-keywords/')) await sleep(1800);
            const input = parsed.messages.findLast(message => message.content.includes('[{"floor":')).content;
            const summaries = JSON.parse(input.slice(input.indexOf('[{"floor":'), input.lastIndexOf(']') + 1));
            const items = summaries.map(item => ({ floor:item.floor, keywords: url.pathname.startsWith('/partial-keywords/')
                ? ['新人物' + item.floor] : ['{{user}}', '旅行者', '玩家', '冗余前缀：人物' + item.floor, '地点' + item.floor, '12，12'] }));
            const directArray = url.pathname.startsWith('/mixed-keywords/')
                && keywordCalls.filter(call => call.path === url.pathname).length > 1;
            let content = JSON.stringify(directArray ? [...items].reverse() : { items });
            if (url.pathname.startsWith('/repair-keywords/')) {
                content = '以下是结果：\n' + JSON.stringify({ items: items.map(item => ({ ...item, floor: String(item.floor) })) }).slice(0, -1) + ',}}';
            }
            if (url.pathname.startsWith('/invalid-keyword-json/')) content = JSON.stringify({ items: items.slice(0, 1) }) + '}';
            response.writeHead(200, { 'Content-Type':'application/json' });
            response.end(JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content } }],
                usage:{ prompt_tokens:250, completion_tokens:60, completion_tokens_details:{ reasoning_tokens:0 } } }));
            return;
        }
        if (url.pathname.endsWith('/rerank')) {
            let body = '';
            for await (const chunk of request) body += chunk;
            const parsed = JSON.parse(body);
            rerankCalls.push({ path:url.pathname, ...parsed, authorization:request.headers.authorization });
            if (url.pathname.startsWith('/failing-rerank/')) { response.writeHead(503); response.end('{}'); return; }
            if (url.pathname.startsWith('/slow-rerank/')) await sleep(3000);
            // Prefer the last vector candidate, proving rerank can change selection.
            const results = parsed.documents.map((_text, index) => ({ index, relevance_score:(index + 1) / parsed.documents.length }))
                .reverse().slice(0, parsed.top_n);
            response.writeHead(200, { 'Content-Type':'application/json' });
            response.end(JSON.stringify({ results }));
            return;
        }
        if (url.pathname.endsWith('/embeddings')) {
            let body = '';
            for await (const chunk of request) body += chunk;
            const parsed = JSON.parse(body);
            calls.push({ path:url.pathname, input:parsed.input, authorization:request.headers.authorization });
            if (url.pathname.startsWith('/failing/')) { response.writeHead(401); response.end('{}'); return; }
            if (url.pathname.startsWith('/slow/')) await sleep(3000);
            const vectors = parsed.input.map((text, index) => ({
                index, embedding:text.includes('星钥') ? [1,0] : text.includes('海港') ? [.99,.05] : [0,1],
            }));
            response.writeHead(200, { 'Content-Type':'application/json' });
            response.end(JSON.stringify({ data:vectors }));
            return;
        }
        if (url.pathname === '/scripts/file-export.js') {
            response.writeHead(200, { 'Content-Type':'text/javascript' });
            response.end(`export async function downloadBlobWithRuntime(blob, fileName) {
                await new Promise(resolve => setTimeout(resolve, 120));
                if (globalThis.__nativeExportFailure) throw new Error('模拟原生写入失败');
                (globalThis.__nativeExports ??= []).push({ fileName, data:JSON.parse(await blob.text()) });
                return { mode:'mobile-native', savedPath:'Download/' + fileName };
            }`);
            return;
        }
        if (url.pathname === '/scripts/tauritavern/tool-turn-projection.js') {
            response.writeHead(200, { 'Content-Type':'text/javascript' });
            response.end(`export function stripOldToolTurns(messages) {
                const boundary = messages.findLastIndex(message => message.is_user);
                return messages.filter((message,index) => index >= boundary || (!message.tool_calls && message.role !== 'tool'));
            }`);
            return;
        }
        const iconAssets = {
            '/test-native-icons/css/fontawesome.min.css': { file:'.tmp/native-icon-test/css/fontawesome.min.css', type:'text/css' },
            '/test-native-icons/css/solid.min.css': { file:'.tmp/native-icon-test/css/solid.min.css', type:'text/css' },
            '/test-native-icons/webfonts/fa-solid-900.woff2': { file:'.tmp/native-icon-test/webfonts/fa-solid-900.woff2', type:'font/woff2' },
        };
        if (iconAssets[url.pathname]) {
            const asset = iconAssets[url.pathname];
            // Optional local host assets for visual review; no network dependency in tests.
            let body;
            try { body = await readFile(resolve(workspace, asset.file)); } catch { body = Buffer.alloc(0); }
            response.writeHead(200, { 'Content-Type':asset.type, 'Cache-Control':'no-store' });
            response.end(body);
            return;
        }
        const assetPath = url.pathname.replace(/^\/scripts\/extensions\/third-party\/(?:floor-memory|world-os)\//, '/');
        const path = resolve(workspace, '.' + decodeURIComponent(assetPath));
        if (!path.startsWith(workspace + sep)) { response.writeHead(403); response.end(); return; }
        const body = await readFile(path);
        const types = { '.js':'text/javascript', '.html':'text/html', '.css':'text/css', '.json':'application/json' };
        response.writeHead(200, { 'Content-Type':(types[extname(path)] ?? 'text/plain') + '; charset=utf-8', 'Cache-Control':'no-store' });
        response.end(body);
    } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await mkdir(artifacts, { recursive:true });
const profile = await mkdtemp(resolve(artifacts, 'browser-profile-'));
const browser = spawn(browserPath, [
    '--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--user-data-dir=' + profile, 'about:blank',
], { windowsHide:true, stdio:'ignore' });
let socket;
const pending = new Map();
let sequence = 0;
const exceptions = [];
async function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
        pending.set(id, { resolve:value => { clearTimeout(timer); resolve(value); }, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
try {
    let debugPort;
    for (let attempt = 0; attempt < 150; attempt++) {
        try { debugPort = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break; } catch {}
        await sleep(100);
    }
    if (!debugPort) throw new Error('Browser did not start a debugging endpoint.');
    const pages = await fetch('http://127.0.0.1:' + debugPort + '/json/list').then(response => response.json());
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }); });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
        if (!message.id) return;
        const task = pending.get(message.id);
        if (!task) return;
        pending.delete(message.id);
        message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width:tauri ? 393 : 920, height:tauri ? 851 : 1050, deviceScaleFactor:1, mobile:tauri });
    if (tauri) {
        await send('Emulation.setUserAgentOverride', { userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
        await send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:1 });
    }
    await send('Page.navigate', { url:'http://127.0.0.1:' + port + '/tests/browser.html' + (tauri ? '?tauri=1' : '') });
    await send('Page.bringToFront');
    let result;
    for (let attempt = 0; attempt < 800; attempt++) {
        const evaluation = await send('Runtime.evaluate', { expression:'globalThis.__testResult', returnByValue:true });
        result = evaluation.result?.value;
        if (result) break;
        await sleep(100);
    }
    if (!result) throw new Error('Browser tests timed out. Exceptions: ' + exceptions.join('; '));
    if (!result.failures.length) {
        await send('Page.bringToFront');
        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', { expression, returnByValue:true });
            if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
            return response.result?.value;
        };
        const uiCheck = async (name, fn) => {
            try { await fn(); result.passed.push(name); }
            catch (error) { result.failures.push(name + ': ' + error.message); }
        };
        const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
        await uiCheck('真实点击入口、Escape 关闭及拖动不误开窗口，位置保存在屏幕内', async () => {
            await evaluate("document.querySelector('#world-os').close()");
            await sleep(30);
            let center = await evaluate("(() => { const r=document.querySelector('#wo-launcher').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
            await mouse('mousePressed', center.x, center.y, { button:'left', clickCount:1 });
            await mouse('mouseReleased', center.x, center.y, { button:'left', clickCount:1 });
            if (!await evaluate("document.querySelector('#world-os').open")) throw new Error('real click did not open window');
            await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
            await send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
            await sleep(30);
            if (await evaluate("document.querySelector('#world-os').open")) throw new Error('Escape did not close window');
            await mouse('mousePressed', center.x, center.y, { button:'left', buttons:1, clickCount:1 });
            await mouse('mouseMoved', 30, 90, { button:'left', buttons:1 });
            await mouse('mouseReleased', 30, 90, { button:'left', clickCount:1 });
            const state = await evaluate("(() => { const r=document.querySelector('#wo-launcher').getBoundingClientRect(); return {open:document.querySelector('#world-os').open,left:r.left,top:r.top,right:r.right,bottom:r.bottom,saved:localStorage.getItem('floor_summary_memory.launcherPosition')}; })()");
            if (state.open || !state.saved || state.left < 0 || state.top < 0 || Math.abs(state.top - center.y) < 20) throw new Error('drag opened window or did not persist/move entrance');
        });
        await uiCheck('旋转或缩小屏幕后悬浮入口仍可点击，重新打开保留唯一窗口', async () => {
            await send('Emulation.setDeviceMetricsOverride', { width:tauri ? 851 : 480, height:tauri ? 393 : 650, deviceScaleFactor:1, mobile:tauri });
            await sleep(100);
            const fits = await evaluate("(() => { const r=document.querySelector('#wo-launcher').getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1; })()");
            if (!fits) throw new Error('launcher stranded outside resized viewport');
            await send('Emulation.setDeviceMetricsOverride', { width:tauri ? 393 : 920, height:tauri ? 851 : 1050, deviceScaleFactor:1, mobile:tauri });
            await sleep(100);
            await evaluate("document.querySelector('#wo-launcher').click()");
            if (!await evaluate("document.querySelector('#world-os').open && document.querySelectorAll('#fm-form').length === 1")) throw new Error('window unavailable after resize');
        });
        if (tauri) await uiCheck('Android 触摸书本图标进入功能页，左上角返回保留设置，关闭后再次从首页进入', async () => {
            const tap = async selector => {
                const point = await evaluate("(() => { const r=document.querySelector(" + JSON.stringify(selector) + ").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
                await send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ ...point, id:1, radiusX:1, radiusY:1, force:1 }] });
                await send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
                await sleep(50);
            };
            await evaluate("document.querySelector('#wo-back').click()");
            await tap('#wo-open-floor-memory');
            if (!await evaluate("document.querySelector('#world-os').dataset.page === 'floor-memory'")) throw new Error('touch did not open app');
            await tap('#wo-back');
            if (!await evaluate("document.querySelector('#world-os').dataset.page === 'home' && document.querySelector('#world-os').open")) throw new Error('back touch did not return to home');
            await tap('#wo-window-close');
            await tap('#wo-launcher');
            if (!await evaluate("document.querySelector('#world-os').dataset.page === 'home' && document.querySelector('#world-os').open")) throw new Error('touch launcher did not reopen home');
        });
        if (tauri) await uiCheck('Android 触摸日历图标、日期标记和输入框上方时间按钮均可操作', async () => {
            const tap = async selector => {
                const point = await evaluate("(() => { const r=document.querySelector(" + JSON.stringify(selector) + ").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
                await send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ ...point, id:1, radiusX:1, radiusY:1, force:1 }] });
                await send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
                await sleep(50);
            };
            await tap('#wo-open-calendar');
            if (!await evaluate("document.querySelector('#world-os').dataset.page === 'calendar'")) throw new Error('touch did not open calendar');
            await tap('#wo-cal-days [data-day="15"]');
            if (!await evaluate("document.querySelector('#wo-cal-holiday-panel').open && document.querySelector('#wo-cal-holiday-day').value === '15'")) throw new Error('touch did not select date');
            await tap('#wo-back');
            await tap('#wo-window-close');
            await tap('#wo-calendar-quick');
            if (!await evaluate("document.querySelector('#wo-calendar-jump').open && document.querySelector('#wo-cal-jump-preview').textContent.includes('团圆节')")) throw new Error('touch did not open time preview');
            await tap('#wo-cal-jump-close');
            if (await evaluate("document.querySelector('#wo-calendar-jump').open")) throw new Error('time dialog failed to close');
        });
    }
    await writeFile(resolve(artifacts, artifactPrefix + '-results.json'), JSON.stringify({ ...result, exceptions }, null, 2));
    for (const passed of result.passed) console.log('PASS ' + passed);
    for (const failure of result.failures) console.error('FAIL ' + failure);
    if (result.failures.length || exceptions.length) process.exitCode = 1;
    console.log(result.passed.length + ' browser checks passed; ' + result.failures.length + ' failed.');
    await send('Runtime.evaluate', { expression: "if (!document.querySelector('#world-os').open) document.querySelector('#wo-launcher').click(); document.querySelector('#wo-back').click(); document.querySelector('.wo-window-body').scrollTop = 0; document.fonts.ready", awaitPromise:true, returnByValue:true });
    await send('Page.bringToFront');
    try {
        for (const view of ['home', 'memory', 'calendar', 'calendar-time']) {
            if (view === 'memory') await send('Runtime.evaluate', { expression: "document.querySelector('#wo-open-floor-memory').click(); for (const section of document.querySelectorAll('#floor-memory details')) section.open = false; document.querySelector('.wo-window-body').scrollTop = 0;", returnByValue:true });
            if (view === 'calendar') await send('Runtime.evaluate', { expression: "document.querySelector('#wo-open-calendar').click(); document.querySelector('.wo-window-body').scrollTop = 0;", returnByValue:true });
            if (view === 'calendar-time') await send('Runtime.evaluate', { expression: "document.querySelector('#world-os').close(); document.querySelector('#wo-calendar-quick').click();", returnByValue:true });
            const screenshot = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
            await writeFile(resolve(artifacts, artifactPrefix + '-' + view + '-preview.png'), Buffer.from(screenshot.data, 'base64'));
        }
    } catch (error) { console.warn('Screenshot unavailable: ' + error.message); }
} finally {
    if (socket?.readyState === WebSocket.OPEN) {
        try { await send('Browser.close'); } catch {}
        socket.close();
    }
    browser.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
