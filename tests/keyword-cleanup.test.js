import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { normalizeSettings } from '../core.js';
import { cleanAIKeywords, keywordMessages, keywordRequestExtras, requestAIKeywords, needsAIKeywords } from '../keyword-ai.js';
import { RegexRunner } from '../regex-runner.js';

class BrowserWorker {
    constructor(url) {
        this.worker = new Worker(new URL('./node-worker.js', import.meta.url), { workerData: { url: url.href } });
        this.worker.on('message', data => this.onmessage?.({ data }));
        this.worker.on('error', error => this.onerror?.(error));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { this.worker.terminate(); }
}
const runner = () => new RegexRunner({ WorkerClass: BrowserWorker, timeoutMs: 300 });
const config = changes => normalizeSettings(changes);
const silicon = config({ aiKeywordEndpoint: 'https://api.siliconflow.cn/v1', aiKeywordModel: 'Qwen/Qwen3-8B' });
const sample = [{ id: 'a', floor: 1, extracted: '旅行者与苏岚在青石镇会合' }];
const response = words => ({
    ok: true, json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [{ floor: 1, keywords: words }] }) } }],
        usage: { prompt_tokens: 250, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 0 } },
    }),
});

test('补空不受旧手动／AI 标记影响，空白字符串也视作空', () => {
    for (const keywordSource of [undefined, 'manual', 'ai']) {
        for (const keywords of [undefined, [], [' ', '']]) {
            assert.equal(needsAIKeywords({ ...sample[0], keywordSource, keywordSummaryHash: 'legacy', keywords }), true);
        }
    }
    assert.equal(needsAIKeywords({ ...sample[0], keywords: ['苏岚'] }), false);
});
test('关键词默认清洗只整词排除用户名和 user 占位符，不误删相关地名', async () => {
    const result = await cleanAIKeywords([{ id: 'a', keywords: ['{{user}}', '{{ USER }}', '旅行者', '旅行者村', '青石镇', '青石镇'] }], config(), { user: '旅行者' });
    assert.deepEqual(result[0].keywords, ['旅行者村', '青石镇']);
    const literal = await cleanAIKeywords([{ id: 'a', keywords: ['[A+B]', 'AAB'] }], config(), { user: '[A+B]' });
    assert.deepEqual(literal[0].keywords, ['AAB']);
});
test('关闭排除用户名时尊重设置；已有预设默认附加排除要求且不改原预设', () => {
    const old = [{ role: 'user', content: '{{summaries}}' }];
    const cfg = config({ aiKeywordPrompts: old });
    const messages = keywordMessages(sample, cfg, { user: '旅行者' });
    assert.match(messages[0].content, /不要将用户占位符 \{\{user\}\}/);
    assert.match(messages[0].content, /旅行者/);
    assert.equal(old[0].content, '{{summaries}}');
    const plain = keywordMessages(sample, { ...cfg, aiKeywordExcludeUser: false }, { user: '旅行者' });
    assert.deepEqual(JSON.parse(plain[0].content)[0].summary, sample[0].extracted);
});
test('用户过滤在数量上限之前执行，冗余词不会挤掉有效关键词', async () => {
    const result = await requestAIKeywords(sample, { ...silicon, aiKeywordLimit: 2 }, '', {
        names: { user: '旅行者' }, fetchImpl: async () => response(['{{user}}', '旅行者', '苏岚', '青石镇', '北门']),
    });
    assert.deepEqual(result[0].keywords, ['苏岚', '青石镇']);
    const retained = await cleanAIKeywords([{ id: 'a', keywords: ['{{user}}', '旅行者'] }], config({ aiKeywordExcludeUser: false }), { user: '旅行者' });
    assert.equal(retained[0].keywords.length, 2);
});
test('真实 Worker 逐词清洗、顺序替换、删除、中文逗号保留，与聊天规则隔离', async () => {
    const cfg = config({ aiKeywordCleanupRules: [
        { pattern: '^人物[:：]', flags: '', replacement: '' },
        { pattern: '^(?:玩家|主角)$', flags: '', replacement: '' },
        { pattern: '^苏岚$', flags: '', replacement: '苏岚,青石镇' },
    ] });
    const result = await cleanAIKeywords([
        { id: 'a', keywords: ['人物：苏岚', '玩家', '12，12', '青石镇'] },
        { id: 'b', keywords: ['人物：旅行者', '主角', '北门'] },
    ], cfg, { user: '旅行者' }, { runner: runner() });
    assert.deepEqual(result, [{ id: 'a', keywords: ['苏岚', '青石镇', '12，12'] }, { id: 'b', keywords: ['北门'] }]);
    const untouched = await cleanAIKeywords([{ id: 'a', keywords: ['<thinking>专名</thinking>'] }], config(), {}, { runner: runner() });
    assert.equal(untouched[0].keywords[0], '<thinking>专名</thinking>');
});
test('关键词清洗正则配置验证；禁用规则不执行', async () => {
    assert.throws(() => config({ aiKeywordCleanupRules: [{ pattern: '[' }] }), /AI 关键词清洗规则/);
    assert.throws(() => config({ aiKeywordCleanupRules: null }), /列表/);
    const cfg = config({ aiKeywordCleanupRules: [{ enabled: false, pattern: '[' }] });
    const result = await cleanAIKeywords([{ id: 'a', keywords: ['苏岚'] }], cfg);
    assert.deepEqual(result[0].keywords, ['苏岚']);
});
test('灾难性关键词正则超时会终止 Worker，本批不产生清洗结果', async () => {
    const cfg = config({ aiKeywordCleanupRules: [{ pattern: '(a+)+$', flags: '', replacement: '' }] });
    await assert.rejects(cleanAIKeywords([{ id: 'a', keywords: ['a'.repeat(90) + '!'] }], cfg, {}, { runner: runner() }), /正则处理超时/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(cleanAIKeywords([{ id: 'a', keywords: ['苏岚'] }], cfg, {}, { runner: runner(), signal: controller.signal }), { name: 'AbortError' });
});
test('自动思考设置仅识别硅基流动官方地址的 Qwen3-8B，不误改其他接口或思考模型', () => {
    assert.deepEqual(keywordRequestExtras(silicon), { enable_thinking: false });
    assert.deepEqual(keywordRequestExtras({ ...silicon, aiKeywordEndpoint: 'https://api.siliconflow.com/v1/chat/completions', aiKeywordModel: 'Pro/Qwen/Qwen3-8B' }), { enable_thinking: false });
    for (const endpoint of ['https://proxy.example/v1', 'https://api.siliconflow.cn.example/v1']) {
        assert.deepEqual(keywordRequestExtras({ ...silicon, aiKeywordEndpoint: endpoint }), {});
    }
    assert.deepEqual(keywordRequestExtras({ ...silicon, aiKeywordModel: 'Qwen/Qwen3-Thinking-only' }), {});
});
test('明确的附加思考参数优先，手动关闭可用于中转，其他参数保留', () => {
    assert.deepEqual(keywordRequestExtras({ ...silicon, aiKeywordExtraBody: '{"enable_thinking":true,"top_k":20}' }), { enable_thinking: true, top_k: 20 });
    assert.deepEqual(keywordRequestExtras({ ...silicon, aiKeywordThinking: 'off', aiKeywordExtraBody: '{"enable_thinking":true,"top_k":20}' }), { enable_thinking: false, top_k: 20 });
    assert.deepEqual(keywordRequestExtras({ ...silicon, aiKeywordThinking: 'service' }), {});
    assert.throws(() => config({ aiKeywordThinking: 'invalid' }), /思考模式/);
});
test('实际请求发送顶层 enable_thinking=false，返回耗时与 token 统计而不暴露思考正文', async () => {
    let metrics;
    await requestAIKeywords(sample, silicon, '', { names: { user: '旅行者' }, onMetrics: value => { metrics = value; },
        fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            assert.equal(body.enable_thinking, false);
            assert.equal(body.chat_template_kwargs, undefined);
            await new Promise(resolve => setTimeout(resolve, 15));
            return response(['苏岚']);
        },
    });
    assert.equal(metrics.requestThinking, false);
    assert.equal(metrics.promptTokens, 250);
    assert.equal(metrics.reasoningTokens, 0);
    assert.equal(metrics.responseReceived, true);
    assert.ok(metrics.requestSeconds >= .01);
    assert.ok(metrics.inputChars > sample[0].extracted.length);
    assert.equal(metrics.hasReasoning, false);
    assert.equal('content' in metrics, false);
});
test('返回思考与失败时仍可诊断，统计不把未知 token 数伪装成零', async () => {
    let metrics;
    await requestAIKeywords(sample, silicon, '', { onMetrics: value => { metrics = value; },
        fetchImpl: async () => ({ ok: true, json: async () => ({
            choices: [{ message: { reasoning_content: 'private reasoning text', content: '{"items":[{"floor":1,"keywords":["苏岚"]}]}' } }],
        }) }),
    });
    assert.equal(metrics.hasReasoning, true);
    assert.equal(metrics.reasoningTokens, undefined);
    assert.equal(JSON.stringify(metrics).includes('private reasoning text'), false);
    await assert.rejects(requestAIKeywords(sample, silicon, '', { onMetrics: value => { metrics = value; },
        fetchImpl: async () => ({ ok: false, status: 503 }),
    }), /503/);
    assert.equal(metrics.responseReceived, false);
});
