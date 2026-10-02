import test from 'node:test';
import assert from 'node:assert/strict';
import { isTauriTavern, runtimeLabel, waitForHostReady, downloadMemory, tauriPromptSource, apiNetworkError } from '../host-runtime.js';
import { snapshotChat, chatFingerprint, replacePrompt } from '../core.js';

const runtime = () => ({ __TAURITAVERN__: { ready: Promise.resolve() }, SillyTavern: { getContext() {} },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)' } });

test('检测浏览器与 Android 宿主', () => {
    assert.equal(isTauriTavern({}), false);
    assert.equal(runtimeLabel({}), 'SillyTavern');
    assert.equal(runtimeLabel(runtime()), 'TauriTavern · Android');
    assert.equal(isTauriTavern({ __TAURI_RUNNING__: true }), true);
});

test('移动端仅发布早期标记时等待 ready 与上下文完成', async () => {
    const host = { __TAURI_RUNNING__: true };
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const waiting = waitForHostReady(host, { timeoutMs: 500 });
    let finished = false;
    waiting.then(() => { finished = true; });
    setTimeout(() => { host.__TAURITAVERN__ = { ready }; }, 10);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(finished, false);
    host.SillyTavern = { getContext() {} };
    resolveReady();
    await waiting;
});

test('宿主启动拒绝或超时会报错，不静默跳过初始化', async () => {
    await assert.rejects(waitForHostReady({ __TAURI_RUNNING__: true }, { timeoutMs: 30 }), /尚未就绪/);
    await assert.rejects(waitForHostReady({ __TAURITAVERN__: { ready: new Promise(() => {}) } }, { timeoutMs: 30 }), /启动超时/);
    await assert.rejects(waitForHostReady({ __TAURITAVERN__: { ready: Promise.reject(new Error('启动失败')) } }), /启动失败/);
    await waitForHostReady({ SillyTavern: { getContext() {} } });
});

test('Android 导出等待原生保存完成，使用 JSON Blob 与文件名', async () => {
    let complete, captured;
    const pending = downloadMemory({ records: [{ floor: 1, keywords: ['青石镇'] }] }, 'memory.json', {
        runtime: runtime(),
        loadModule: async path => {
            assert.equal(path, '/scripts/file-export.js');
            return { downloadBlobWithRuntime: (blob, fileName) => {
                captured = { blob, fileName };
                return new Promise(resolve => { complete = resolve; });
            } };
        },
    });
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false);
    assert.equal(captured.fileName, 'memory.json');
    assert.equal(captured.blob.type, 'application/json');
    assert.deepEqual(JSON.parse(await captured.blob.text()).records[0].keywords, ['青石镇']);
    complete({ mode: 'mobile-native', savedPath: 'Download/memory.json' });
    assert.equal((await pending).savedPath, 'Download/memory.json');
});

test('原生导出失败及缺少接口时保留错误，不静默回退假成功', async () => {
    await assert.rejects(downloadMemory({}, 'memory.json', { runtime: runtime(),
        loadModule: async () => ({ downloadBlobWithRuntime: async () => { throw Error('写入失败'); } }),
    }), /写入失败/);
    await assert.rejects(downloadMemory({}, 'memory.json', { runtime: runtime(), loadModule: async () => ({}) }), /2.3.0/);
});

test('当前消息快照跳过非活动滑动与冷滑动句柄，保留活动正文和附件', () => {
    const chat = [{ name: 'A', mes: '当前正文', swipe_id: 1, swipes: [null, '当前正文'],
        swipe_info: [{ large: 'x'.repeat(10000) }], tt_swipe_cold: { sourceId: 'source' }, extra: { media: ['image'] } }];
    const before = chatFingerprint(chat);
    const snapshot = snapshotChat(chat);
    assert.equal('swipes' in snapshot[0], false);
    assert.equal('tt_swipe_cold' in snapshot[0], false);
    assert.equal(snapshot[0].swipe_id, 1);
    snapshot[0].extra.media.push('other');
    assert.deepEqual(chat[0].extra.media, ['image']);
    chat[0].swipes[0] = '后台加载的旧滑动';
    assert.equal(chatFingerprint(chat), before);
    chat[0].mes = '修改正文';
    assert.notEqual(chatFingerprint(chat), before);
    assert.throws(() => snapshotChat([null]), /尚未完整加载/);
});

test('超过 Android 参数数量限制的上下文仍能替换和缩短', () => {
    const target = [{ mes: 'old' }];
    const output = Array.from({ length: 70000 }, (_, i) => ({ mes: String(i) }));
    replacePrompt(target, output);
    assert.equal(target.length, 70000);
    assert.equal(target[69999], output[69999]);
    replacePrompt(target, [output[0]]);
    assert.equal(target.length, 1);
});

test('浏览器不读取 Tauri 模块；Tauri 工具过滤使用宿主函数与原始索引', async () => {
    const chat = [{ is_user: true }, { tool_calls: [{ id: 'call' }] },
        { is_system: true, role: 'tool' }, { mes: 'reply' }, { is_user: true }];
    assert.equal(await tauriPromptSource(chat, 'normal', {}, { runtime: {}, loadModule: () => { throw Error('unexpected'); } }), undefined);
    const ctx = { mainApi: 'openai', chatCompletionSettings: { function_calling: true, strip_old_tool_calls: true } };
    let called = false;
    const source = await tauriPromptSource(chat, 'normal', ctx, { runtime: runtime(),
        loadModule: async path => {
            assert.equal(path, '/scripts/tauritavern/tool-turn-projection.js');
            return { stripOldToolTurns: messages => { called = true; return messages.filter(item => !item.tool_calls && item.role !== 'tool'); } };
        },
    });
    assert.equal(called, true);
    assert.deepEqual(source, [0, 3, 4]);
    assert.deepEqual(await tauriPromptSource(chat, 'swipe', { mainApi: 'openai' }, { runtime: runtime() }), [0, 1, 2, 3]);
    assert.deepEqual(await tauriPromptSource(chat, 'normal', { mainApi: 'textgenerationwebui' }, { runtime: runtime() }), [0, 1, 3, 4]);
});

test('Tauri 网络错误解释手机本地地址，不包含密钥或完整 URL', () => {
    const message = apiNetworkError('http://127.0.0.1:8000/v1/models', runtime());
    assert.match(message, /手机自身/);
    assert.match(message, /CORS/);
    assert.doesNotMatch(apiNetworkError('https://api.example.com/v1/models?key=secret', runtime()), /secret|api.example.com|手机自身/);
    assert.match(apiNetworkError('https://example.com', {}), /跨域 CORS/);
});

test('宿主已传完整工具轮时不再剥离，兼容当前提示词 Agent 交接', async () => {
    const chat = [{ is_user: true }, { tool_calls: [{ id: 'call' }] }, { is_system: true, role: 'tool' }, { mes: 'reply' }];
    const source = await tauriPromptSource(chat, 'normal', {
        mainApi: 'openai', chatCompletionSettings: { function_calling: true, strip_old_tool_calls: true },
    }, { runtime: runtime(), promptLength: chat.length, loadModule: () => { throw Error('must not strip'); } });
    assert.deepEqual(source, [0, 1, 2, 3]);
});
