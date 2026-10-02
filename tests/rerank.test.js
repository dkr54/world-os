import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, retrieveMemories } from '../core.js';
import { rerankUrl, requestRerank, rerankVectorCandidates } from '../embeddings.js';

const config = {
    ...DEFAULT_SETTINGS, rerankEnabled: true, rerankEndpoint: 'https://rerank.example/v2',
    rerankModel: 'test-reranker', rerankTimeoutSeconds: 1,
};
const hits = [
    { record: { id: 'a', floor: 1, extracted: '第一条总结' }, score: .98 },
    { record: { id: 'b', floor: 3, extracted: '第二条总结', override: '手工总结' }, score: .8 },
    { record: { id: 'c', floor: 2, extracted: '第三条总结' }, score: .6 },
];
const response = body => ({ ok: true, json: async () => body });
const success = async () => response({ results: [{ index: 2, relevance_score: .95 }] });
const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
});

test('重排配置默认关闭，候选数量与超时验证，兼容完整及带版本根地址', () => {
    assert.equal(DEFAULT_SETTINGS.rerankEnabled, false);
    assert.equal(rerankUrl('https://a.example/v2/'), 'https://a.example/v2/rerank');
    assert.equal(rerankUrl('https://a.example/v1/rerank/'), 'https://a.example/v1/rerank');
    for (const value of [0, -1, 1.5, 1001, NaN]) assert.throws(() => normalizeSettings({ rerankCandidates: value }), /候选数/);
    for (const value of [0, 181, NaN]) assert.throws(() => normalizeSettings({ rerankTimeoutSeconds: value }), /重排请求超时/);
    assert.throws(() => rerankUrl('https://a.example?api_key=secret'));
});
test('重排请求使用独立密钥、有效总结和 Cohere/Jina 格式，保留余弦分数', async () => {
    const selected = await requestRerank(hits, '查询正文', 2, config, 'separate-key', {
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://rerank.example/v2/rerank');
            assert.equal(options.method, 'POST');
            assert.equal(options.credentials, 'omit');
            assert.equal(options.headers.Authorization, 'Bearer separate-key');
            assert.deepEqual(JSON.parse(options.body), {
                model: 'test-reranker', query: '查询正文',
                documents: ['第一条总结', '手工总结', '第三条总结'], top_n: 2,
            });
            return response({ results: [{ index: 0, relevance_score: .1 }, { index: 2, relevance_score: .9 }] });
        },
    });
    assert.deepEqual(selected.map(hit => [hit.record.id, hit.score, hit.rerankScore]), [['c', .6, .9], ['a', .98, .1]]);
    assert.equal(hits[2].rerankScore, undefined);
});
test('重排免密服务不发认证头；top_n 不超过候选数', async () => {
    const selected = await requestRerank(hits.slice(0, 1), 'query', 6, config, '', {
        fetchImpl: async (_url, options) => {
            assert.equal(options.headers.Authorization, undefined);
            assert.equal(JSON.parse(options.body).top_n, 1);
            return response({ results: [{ index: 0, relevance_score: -1 }] });
        },
    });
    assert.equal(selected.length, 1);
    await assert.rejects(requestRerank(hits, 'query', 1, { ...config, rerankModel: '' }, ''), /模型名称/);
});
test('非法重排结果被拒绝，防止索引错配、重复和名额丢失', async () => {
    for (const results of [
        undefined, [], [{ index: 3, relevance_score: 1 }], [{ index: -1, relevance_score: 1 }],
        [{ index: .5, relevance_score: 1 }], [{ index: 0, relevance_score: '1' }],
        [{ index: 0, relevance_score: Infinity }],
        [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: .9 }],
    ]) {
        await assert.rejects(requestRerank(hits, 'query', 1, config, '', {
            fetchImpl: async () => response({ results }),
        }), /Rerank/);
    }
    await assert.rejects(requestRerank(hits, 'query', 2, config, '', { fetchImpl: success }), /足够/);
});
test('重排关闭、没有名额或所有候选都能入选时不请求服务', async () => {
    const options = { fetchImpl: () => { throw new Error('must not request'); } };
    assert.deepEqual((await rerankVectorCandidates(hits, 'query', 1, { ...config, rerankEnabled: false }, '', options)).hits, hits.slice(0, 1));
    assert.deepEqual((await rerankVectorCandidates(hits, 'query', 3, config, '', options)).hits, hits);
    assert.deepEqual((await rerankVectorCandidates([], 'query', 1, config, '', options)).hits, []);
    assert.deepEqual(await requestRerank(hits, 'query', 0, config, '', options), []);
});
test('重排 HTTP、网络、JSON 和响应格式错误都回退向量，且不回显服务端密钥', async () => {
    const fetches = [
        async () => ({ ok: false, status: 401, text: async () => 'secret' }),
        async () => { throw new TypeError('Failed to fetch'); },
        async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }),
        async () => response({ results: [] }),
    ];
    for (const fetchImpl of fetches) {
        const result = await rerankVectorCandidates(hits, 'query', 1, config, 'secret', { fetchImpl });
        assert.deepEqual(result.hits, [hits[0]]);
        assert.match(result.warning, /重排不可用/);
        assert.equal(result.warning.includes('secret'), false);
    }
});
test('重排超时回退向量，主动取消向上传播且不降级提交', async () => {
    const fallback = await rerankVectorCandidates(hits, 'query', 1, { ...config, rerankTimeoutSeconds: .01 }, '', { fetchImpl: hangingFetch });
    assert.match(fallback.warning, /超时/);
    assert.deepEqual(fallback.hits, [hits[0]]);
    const controller = new AbortController();
    const pending = rerankVectorCandidates(hits, 'query', 1, config, '', { signal: controller.signal, fetchImpl: hangingFetch });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(rerankVectorCandidates([], 'query', 1, config, '', { signal: controller.signal }), { name: 'AbortError' });
});
test('关键词优先，重排仅占剩余名额，余弦阈值与重排分数独立，最终按楼层顺序', async () => {
    const keyword = { id: 'key', floor: 4, extracted: '直接命中的总结', keywords: ['21'] };
    const settings = { ...config, recallCount: 2, similarityThreshold: .5 };
    const result = await retrieveMemories([...hits.map(hit => hit.record), keyword], '查询 21', settings, async (records, query, count) => {
        assert.equal(records.some(record => record.id === 'key'), false);
        assert.equal(count, 1);
        return rerankVectorCandidates(hits, query, count, settings, '', {
            fetchImpl: async () => response({ results: [{ index: 2, relevance_score: -.2 }] }),
        });
    });
    assert.deepEqual(result.hits.map(hit => hit.record.id), ['c', 'key']);
    assert.equal(result.hits[0].score, .6);
    assert.equal(result.hits[0].rerankScore, -.2);
    assert.equal(result.hits[1].reason, 'keyword');
    const full = await retrieveMemories([...hits.map(hit => hit.record), keyword], '查询 21', { ...settings, recallCount: 1 }, () => {
        throw new Error('keyword quota already full');
    });
    assert.equal(full.warning, '');
    assert.deepEqual(full.hits.map(hit => hit.record.id), ['key']);
});
test('重排降级警告穿过召回流程，关键词与向量结果都保留', async () => {
    const keyword = { id: 'key', floor: 4, extracted: '直接命中', keywords: ['21'] };
    const result = await retrieveMemories([...hits.map(hit => hit.record), keyword], '查询 21', { ...config, recallCount: 2 },
        () => rerankVectorCandidates(hits, 'query', 1, config, '', { fetchImpl: async () => ({ ok: false, status: 503 }) }));
    assert.match(result.warning, /重排不可用.*503/);
    assert.deepEqual(result.hits.map(hit => hit.record.id), ['a', 'key']);
});
