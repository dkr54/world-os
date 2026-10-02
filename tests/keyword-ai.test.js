import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, fingerprint } from '../core.js';
import { chatCompletionsUrl, modelsUrl } from '../embeddings.js';
import { needsAIKeywords, keywordMessages, parseKeywordResponse, requestAIKeywords, applyAIKeywords } from '../keyword-ai.js';

const config = normalizeSettings({
    aiKeywordEndpoint: 'https://keywords.example/v1/chat/completions', aiKeywordModel: 'small-instruct',
});
const records = [
    { id: 'one', floor: 1, name: '向导', extracted: '示例角色甲在青石镇北门与苏岚会合。' },
    { id: 'two', floor: 2, name: '向导', extracted: '商人守着写有 12，12 的木箱。', override: '苏岚带走木箱。' },
];
const result = { items: [{ floor: 2, keywords: ['苏岚', '木箱'] }, { floor: 1, keywords: ['示例角色甲', '青石镇'] }] };
const response = (content = JSON.stringify(result), finish_reason = 'stop') => ({
    ok: true, json: async () => ({ choices: [{ finish_reason, message: { content } }] }),
});

test('关键词设置向旧配置补全；自动提取默认关闭，验证预设与采样参数', () => {
    assert.equal(DEFAULT_SETTINGS.aiKeywordAuto, false);
    assert.equal(normalizeSettings({ model: 'legacy' }).aiKeywordBatchSize, 8);
    for (const [key, value] of [['aiKeywordBatchSize', 0], ['aiKeywordBatchSize', 1.1], ['aiKeywordTemperature', -1],
        ['aiKeywordTopP', 0], ['aiKeywordMaxTokens', 1], ['aiKeywordLimit', 31], ['aiKeywordTimeoutSeconds', 301]]) {
        assert.throws(() => normalizeSettings({ [key]: value }));
    }
    for (const aiKeywordPrompts of [[], [{ role: 'tool', content: '{{summaries}}' }], [{ role: 'user', content: '' }],
        [{ role: 'user', content: 'missing summaries' }]]) assert.throws(() => normalizeSettings({ aiKeywordPrompts }), /预设/);
});
test('附加参数支持服务选项，拒绝无效 JSON 或覆盖界面控制的请求参数', () => {
    const settings = normalizeSettings({ aiKeywordExtraBody: '{"chat_template_kwargs":{"enable_thinking":false},"top_k":20}' });
    assert.match(settings.aiKeywordExtraBody, /enable_thinking/);
    for (const aiKeywordExtraBody of ['[]', 'null', '{', '{"stream":true}', '{"messages":[]}']) {
        assert.throws(() => normalizeSettings({ aiKeywordExtraBody }), /参数|界面/);
    }
});
test('聊天接口地址与三类模型列表同级推导，不重复路径', () => {
    assert.equal(chatCompletionsUrl('https://a.example/v1/'), 'https://a.example/v1/chat/completions');
    assert.equal(chatCompletionsUrl('https://a.example/v1/chat/completions/'), 'https://a.example/v1/chat/completions');
    assert.equal(modelsUrl('https://a.example/v2/rerank'), 'https://a.example/v2/models');
    assert.equal(modelsUrl('https://a.example/v1/chat/completions'), 'https://a.example/v1/models');
    assert.throws(() => chatCompletionsUrl('https://user:secret@a.example'));
});
test('预设角色与顺序保留，发送有效总结并一次性替换占位符', () => {
    const settings = normalizeSettings({ aiKeywordExcludeUser: false, aiKeywordPrompts: [
        { role: 'system', content: '提取 {{max_keywords}} 个词，角色 {{char}}，用户 {{user}}' },
        { role: 'assistant', content: '我会返回 JSON。' },
        { role: 'user', content: '{{summaries}}' },
    ] });
    const input = [{ ...records[1], override: '{{char}}是总结原文，不应展开' }];
    const messages = keywordMessages(input, settings, { char: '向导', user: '旅行者' });
    assert.deepEqual(messages.map(message => message.role), ['system', 'assistant', 'user']);
    assert.equal(messages[0].content, '提取 8 个词，角色 向导，用户 旅行者');
    assert.equal(JSON.parse(messages[2].content)[0].summary, input[0].override);
    assert.equal(JSON.parse(messages[2].content)[0].floor, 2);
});
test('AI 请求使用独立密钥、模型、role、采样参数与可选 JSON 模式', async () => {
    const settings = { ...config, aiKeywordTemperature: .4, aiKeywordTopP: .8, aiKeywordMaxTokens: 1024,
        aiKeywordJsonMode: true, aiKeywordExtraBody: '{"chat_template_kwargs":{"enable_thinking":false}}' };
    const suggestions = await requestAIKeywords(records, settings, 'keyword-only-key', {
        names: { char: '向导', user: '旅行者' },
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://keywords.example/v1/chat/completions');
            assert.equal(options.headers.Authorization, 'Bearer keyword-only-key');
            assert.equal(options.credentials, 'omit');
            const body = JSON.parse(options.body);
            assert.equal(body.model, 'small-instruct');
            assert.equal(body.stream, false);
            assert.equal(body.temperature, .4);
            assert.equal(body.top_p, .8);
            assert.equal(body.max_tokens, 1024);
            assert.equal(body.chat_template_kwargs.enable_thinking, false);
            assert.deepEqual(body.response_format, { type: 'json_object' });
            assert.equal(body.messages[0].role, 'system');
            assert.match(body.messages[1].content, /苏岚带走木箱/);
            assert.doesNotMatch(body.messages[1].content, /商人守着/);
            return response();
        },
    });
    assert.deepEqual(suggestions, [{ id: 'two', keywords: ['苏岚', '木箱'] }, { id: 'one', keywords: ['示例角色甲', '青石镇'] }]);
});
test('免密服务不发认证头；默认不强制服务支持 JSON 参数', async () => {
    await requestAIKeywords(records, config, '', { fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(JSON.parse(options.body).response_format, undefined);
        return response();
    } });
    await assert.rejects(requestAIKeywords(records, { ...config, aiKeywordModel: '' }, ''), /模型名称/);
});
test('接受 JSON 围栏、已结束的思考和明确的正文；不从未结束思考中提取', () => {
    const wrapped = '<think>内部思考</think>\n' + '```json\n' + JSON.stringify(result) + '\n```';
    assert.equal(parseKeywordResponse(wrapped, records, 8).length, 2);
    assert.deepEqual(parseKeywordResponse('说明：' + JSON.stringify(result), records, 8), parseKeywordResponse(JSON.stringify(result), records, 8));
    for (const content of ['<think>尚未结束', undefined, '{}']) {
        assert.throws(() => parseKeywordResponse(content, records, 8));
    }
});
test('拒绝缺楼、重复、未知楼号、非字符串关键词与段落，整批不混写', () => {
    for (const items of [
        [{ floor: 1, keywords: ['示例角色甲'] }],
        [{ floor: 1, keywords: [] }, { floor: 1, keywords: [] }],
        [{ floor: 1, keywords: [] }, { floor: 99, keywords: [] }],
        [{ floor: 1, keywords: [] }, { floor: 2, keywords: [21] }],
        [{ floor: 1, keywords: [] }, { floor: 2, keywords: ['多行\n文本'] }],
    ]) assert.throws(() => parseKeywordResponse(JSON.stringify({ items }), records, 8), /楼|关键词/);
});
test('去重与数量上限保持英文逗号分词规则，中文逗号不拆', () => {
    const content = JSON.stringify({ items: [{ floor: 1, keywords: [' 示例角色甲 ', '示例角色甲', '12，12', '北门,青石镇'] }] });
    const result = parseKeywordResponse(content, records.slice(0, 1), 3);
    assert.deepEqual(result[0].keywords, ['示例角色甲', '12，12', '北门']);
});
test('截断的模型输出不写入，提示减少批次或增加输出上限', async () => {
    await assert.rejects(requestAIKeywords(records, config, '', { fetchImpl: async () => response(JSON.stringify(result), 'length') }), /截断/);
});
test('API、JSON、网络、超时和取消均有明确结果，不回显服务端密钥', async () => {
    await assert.rejects(requestAIKeywords(records, config, 'secret', {
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret' }),
    }), error => error.message.includes('401') && !error.message.includes('secret'));
    await assert.rejects(requestAIKeywords(records, config, '', { fetchImpl: async () => { throw new TypeError('fetch'); } }), /CORS/);
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    });
    await assert.rejects(requestAIKeywords(records, { ...config, aiKeywordTimeoutSeconds: .01 }, '', { fetchImpl }), /超时/);
    const controller = new AbortController();
    const pending = requestAIKeywords(records, config, '', { fetchImpl, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});
test('一键仅按关键词是否为空补全，手动清空可重填，非空保留，空总结跳过', () => {
    assert.equal(needsAIKeywords(records[0]), true);
    assert.equal(needsAIKeywords({ ...records[0], keywords: ['手动词'] }), false);
    assert.equal(needsAIKeywords({ ...records[0], keywordSource: 'manual', keywords: [] }), true);
    assert.equal(needsAIKeywords({ ...records[0], keywordSource: 'manual', keywords: [] }, 'replace'), true);
    assert.equal(needsAIKeywords({ extracted: '' }, 'replace'), false);
});
test('自动提取避免重复收费，AI 无关键词结果也记住；总结变化才重新处理', () => {
    const processed = { ...records[0], keywords: [], keywordSource: 'ai', keywordSummaryHash: fingerprint(records[0].extracted) };
    assert.equal(needsAIKeywords(processed, 'auto'), false);
    assert.equal(needsAIKeywords(processed), true);
    assert.equal(needsAIKeywords({ ...processed, override: '新总结' }, 'auto'), true);
    assert.equal(needsAIKeywords({ ...processed, keywordSource: 'manual', override: '新总结' }, 'auto'), true);
});
test('按稳定 ID 写入对应关键词，保存原显示文本和处理标记，不更改总结或其他楼', () => {
    const input = [...records, { id: 'third', floor: 3, extracted: '其他总结' }];
    const next = applyAIKeywords(input, records, parseKeywordResponse(JSON.stringify(result), records, 8));
    assert.equal(next[0].keywordText, '示例角色甲,青石镇');
    assert.equal(next[1].keywordText, '苏岚,木箱');
    assert.equal(next[0].keywordSource, 'ai');
    assert.equal(next[1].override, '苏岚带走木箱。');
    assert.equal(next[2], input[2]);
    assert.equal(input[0].keywords, undefined);
});
test('请求途中修改总结、关键词或删除楼层时拒绝覆盖', () => {
    const suggestions = parseKeywordResponse(JSON.stringify(result), records, 8);
    for (const changed of [
        records.slice(1),
        [{ ...records[0], override: '编辑过的总结' }, records[1]],
        [{ ...records[0], keywords: ['新关键词'] }, records[1]],
        [{ ...records[0], keywordText: '新输入' }, records[1]],
        [{ ...records[0], keywordSource: 'manual' }, records[1]],
    ]) assert.throws(() => applyAIKeywords(changed, records, suggestions), { name: 'AbortError' });
});

test('兼容 Qwen 返回第 7、8、9 楼的直接 JSON 数组，与 items 包装结果一致', async () => {
    const content = '[{"floor":7,"keywords":["示例角色甲","杨幂","苏玉妍","上城区","行宫"]},{"floor":8,"keywords":["示例角色甲","杨幂","苏玉妍","行宫"]},{"floor":9,"keywords":["示例角色甲","苏玉妍","戴兰芷","罗妍","黄金都市"]}]';
    const batch = [7, 8, 9].map(floor => ({ id: 'floor-' + floor, floor, extracted: '第 ' + floor + ' 楼总结' }));
    const expected = JSON.parse(content).map(item => ({ id: 'floor-' + item.floor, keywords: item.keywords }));
    assert.deepEqual(parseKeywordResponse(content, batch, 8), expected);
    assert.deepEqual(parseKeywordResponse('{"items":' + content + '}', batch, 8), expected);
    const suggestions = await requestAIKeywords(batch, config, '', { fetchImpl: async () => response(content) });
    assert.deepEqual(suggestions, expected);
});
test('直接数组支持已结束思考与 JSON 围栏，乱序和不连续楼号按实际 ID 映射', () => {
    const batch = [5, 7, 9].map(floor => ({ id: 'floor-' + floor, floor, extracted: '总结' }));
    const items = [{ floor: 9, keywords: ['北门'] }, { floor: 5, keywords: [] }, { floor: 7, keywords: ['青石镇'] }];
    const fence = String.fromCharCode(96).repeat(3);
    const wrapped = '<think>done</think>\n' + fence + 'json\n' + JSON.stringify(items) + '\n' + fence;
    const parsed = parseKeywordResponse(wrapped, batch, 8);
    const next = applyAIKeywords(batch, batch, parsed);
    assert.deepEqual(next.map(record => record.keywords), [[], ['青石镇'], ['北门']]);
});
test('数组缺楼或多楼给出实际数量和目标楼号，包装格式采用相同检查', () => {
    const batch = [7, 8, 9].map(floor => ({ id: 'floor-' + floor, floor, extracted: '总结' }));
    for (const count of [0, 2, 4]) {
        const items = Array.from({ length: count }, (_, i) => ({ floor: 7 + i, keywords: [] }));
        for (const output of [items, { items }]) {
            assert.throws(() => parseKeywordResponse(JSON.stringify(output), batch, 8), error =>
                error.message.includes('本批 3 楼（7、8、9）') && error.message.includes('返回 ' + count + ' 项'));
        }
    }
});
test('数组与 items 都拒绝重复楼号、错误楼号、无效关键词和嵌套数组', () => {
    for (const items of [
        [{ floor: 1, keywords: [] }, { floor: 1, keywords: [] }],
        [{ floor: 1, keywords: [] }, { floor: 3, keywords: [] }],
        [{ floor: 1, keywords: [] }, { floor: 2, keywords: { name: '北门' } }],
        [{ floor: 1, keywords: [] }, { floor: 2, keywords: [21] }],
        [{ floor: 1, keywords: [] }, { floor: 2, keywords: ['多行\n文本'] }],
        [{ floor: 1, keywords: [] }, null],
        [[{ floor: 1, keywords: [] }], [{ floor: 2, keywords: [] }]],
    ]) {
        for (const output of [items, { items }]) {
            assert.throws(() => parseKeywordResponse(JSON.stringify(output), records, 8), /未知／重复楼号或无效关键词/);
        }
    }
});
test('结构错误与数量错误分开提示，不从非约定结构猜测楼层', () => {
    for (const output of [{}, null, '普通文字', { results: result.items }, { items: null }, { items: { floor: 1 } }]) {
        assert.throws(() => parseKeywordResponse(JSON.stringify(output), records, 8), error =>
            error.message.includes('结果格式不正确') && !error.message.includes('数量'));
    }
});
