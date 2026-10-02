import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { RegexRunner, classicRegexSource } from '../regex-runner.js';
import { DEFAULT_SETTINGS } from '../core.js';

class BrowserWorker {
    constructor(url) {
        this.worker = new Worker(new URL('./node-worker.js', import.meta.url), { workerData: { url: url.href } });
        this.worker.on('message', data => this.onmessage?.({ data }));
        this.worker.on('error', error => this.onerror?.(error));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { this.worker.terminate(); }
}
test('真实工作线程提取多条回复，保持输入顺序', async () => {
    const runner = new RegexRunner({ WorkerClass: BrowserWorker });
    const results = await runner.runBatches(['<summary>A</summary>', '<summary>B</summary>'], DEFAULT_SETTINGS);
    assert.deepEqual(results.map(result => result.summary), ['A', 'B']);
});
test('灾难性回溯会超时并结束工作线程', async () => {
    const runner = new RegexRunner({ WorkerClass: BrowserWorker, timeoutMs: 300 });
    const settings = { ...DEFAULT_SETTINGS, cleanupRules: [], extractPattern: '(a+)+$', extractGroup: '0' };
    await assert.rejects(runner.run(['a'.repeat(100) + '!'], settings), /正则处理超时/);
    const [next] = await new RegexRunner({ WorkerClass: BrowserWorker }).run(['<summary>恢复</summary>'], DEFAULT_SETTINGS);
    assert.equal(next.summary, '恢复');
});
test('预先取消和处理中取消都及时结束正则任务', async () => {
    const runner = new RegexRunner({ WorkerClass: BrowserWorker });
    const controller = new AbortController();
    const pending = runner.run(['<summary>A</summary>'], DEFAULT_SETTINGS, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(runner.run(['x'], DEFAULT_SETTINGS, controller.signal), { name: 'AbortError' });
});

class ClassicBrowserWorker {
    constructor(url) {
        this.worker = new Worker(`
            const { parentPort } = require('node:worker_threads');
            globalThis.self = { postMessage: value => parentPort.postMessage(value) };
            ${classicRegexSource()}
            parentPort.on('message', data => self.onmessage({ data }));
        `, { eval: true });
        this.worker.on('message', data => this.onmessage?.({ data }));
        this.worker.on('error', error => this.onerror?.(error));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { this.worker.terminate(); }
}

test('Android classic worker 与模块线程共用实际清洗和提取逻辑', async () => {
    const runner = new RegexRunner({ WorkerClass: ClassicBrowserWorker, mode: 'classic' });
    const [result] = await runner.run(['<thinking><summary>错误</summary></thinking><summary>青石镇</summary>'], DEFAULT_SETTINGS);
    assert.equal(result.summary, '青石镇');
    const [keyword] = await runner.run(['前缀：苏岚'], { ...DEFAULT_SETTINGS,
        aiKeywordCleanupRules: [{ pattern: '^前缀：', flags: 'g', replacement: '' }],
    }, undefined, 'keywords');
    assert.equal(keyword.cleaned, '苏岚');
});

test('Android classic worker 的灾难性回溯仍能终止并释放 Blob URL', async () => {
    let revoked = 0;
    const runner = new RegexRunner({ WorkerClass: ClassicBrowserWorker, mode: 'classic', timeoutMs: 100,
        URLClass: { createObjectURL: () => 'blob:test', revokeObjectURL: () => revoked++ },
    });
    await assert.rejects(runner.run(['a'.repeat(100) + '!'], {
        ...DEFAULT_SETTINGS, cleanupRules: [], extractPattern: '(a+)+$', extractGroup: '0',
    }), /正则处理超时/);
    assert.equal(revoked, 1);
});

test('慢启动不消耗正则执行预算，启动超时与执行超时分别处理', async () => {
    let terminated = 0;
    class SlowWorker {
        constructor() { this.timer = setTimeout(() => this.onmessage({ data: { ready: true } }), 80); }
        postMessage() { this.onmessage({ data: { results: [{ summary: 'done' }] } }); }
        terminate() { clearTimeout(this.timer); terminated++; }
    }
    const runner = new RegexRunner({ WorkerClass: SlowWorker, timeoutMs: 20, startupTimeoutMs: 200 });
    assert.equal((await runner.run(['test'], DEFAULT_SETTINGS))[0].summary, 'done');
    await assert.rejects(new RegexRunner({ WorkerClass: SlowWorker, startupTimeoutMs: 20 }).run(['test'], DEFAULT_SETTINGS), /启动超时/);
    assert.equal(terminated, 2);
});
