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
        const assetPath = url.pathname.replace(/^\/scripts\/extensions\/third-party\/floor-memory\//, '/');
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
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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
    if (tauri) await send('Emulation.setUserAgentOverride', { userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
    await send('Page.navigate', { url:'http://127.0.0.1:' + port + '/tests/browser.html' + (tauri ? '?tauri=1' : '') });
    let result;
    for (let attempt = 0; attempt < 800; attempt++) {
        const evaluation = await send('Runtime.evaluate', { expression:'globalThis.__testResult', returnByValue:true });
        result = evaluation.result?.value;
        if (result) break;
        await sleep(100);
    }
    if (!result) throw new Error('Browser tests timed out. Exceptions: ' + exceptions.join('; '));
    await writeFile(resolve(artifacts, artifactPrefix + '-results.json'), JSON.stringify({ ...result, exceptions }, null, 2));
    for (const passed of result.passed) console.log('PASS ' + passed);
    for (const failure of result.failures) console.error('FAIL ' + failure);
    if (result.failures.length || exceptions.length) process.exitCode = 1;
    console.log(result.passed.length + ' browser checks passed; ' + result.failures.length + ' failed.');
    await send('Runtime.evaluate', { expression: "document.querySelector('#fm-ai-panel').open = true; document.querySelector('#fm-ai-panel').scrollIntoView();", returnByValue:true });
    await send('Page.bringToFront');
    try {
        const screenshot = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
        await writeFile(resolve(artifacts, artifactPrefix + '-preview.png'), Buffer.from(screenshot.data, 'base64'));
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
