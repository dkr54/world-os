import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../core.js';
import { embeddingUrl, modelsUrl, requestModels, requestEmbeddings, EmbeddingIndex, VectorCache, cosineSimilarity } from '../embeddings.js';

const config = { ...DEFAULT_SETTINGS, endpoint: 'https://embedding.example/v1', model: 'test-model', timeoutSeconds: 1, batchSize: 2 };
const response = body => ({ ok: true, json: async () => body });

test('补全 /embeddings，不重复路径，拒绝 URL 内的密钥', () => {
    assert.equal(embeddingUrl('https://a.example/v1/'), 'https://a.example/v1/embeddings');
    assert.equal(embeddingUrl('https://a.example/v1/embeddings/'), 'https://a.example/v1/embeddings');
    assert.throws(() => embeddingUrl('https://user:secret@a.example'));
    assert.throws(() => embeddingUrl('https://a.example?api_key=secret'));
    assert.throws(() => embeddingUrl('file:///a'));
});
test('按 index 重排响应；请求符合 OpenAI Embeddings schema', async () => {
    const result = await requestEmbeddings(['a', 'b'], config, 'test-key', {
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://embedding.example/v1/embeddings');
            assert.equal(options.headers.Authorization, 'Bearer test-key');
            assert.equal(options.credentials, 'omit');
            assert.deepEqual(JSON.parse(options.body), { model: 'test-model', input: ['a', 'b'], encoding_format: 'float' });
            return response({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
        },
    });
    assert.deepEqual(result, [[1, 0], [0, 1]]);
});
test('免密端点不发送 Authorization', async () => {
    await requestEmbeddings(['a'], config, '', { fetchImpl: async (_url, options) => {
        assert.equal('Authorization' in options.headers, false);
        return response({ data: [{ index: 0, embedding: [1] }] });
    } });
});
test('拒绝缺项、重复索引、空向量、非数值和维度不匹配', async () => {
    for (const data of [
        [{ index: 0, embedding: [1, 0] }],
        [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
        [{ index: 0, embedding: [] }, { index: 1, embedding: [1] }],
        [{ index: 0, embedding: [NaN] }, { index: 1, embedding: [1] }],
        [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [1, 0] }],
        [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 0] }],
    ]) {
        await assert.rejects(requestEmbeddings(['a', 'b'], config, '', { fetchImpl: async () => response({ data }) }));
    }
});
test('网络错误有 CORS 提示；HTTP 错误不回显服务端敏感文本', async () => {
    await assert.rejects(requestEmbeddings(['a'], config, '', { fetchImpl: async () => { throw new TypeError('network'); } }), /CORS/);
    await assert.rejects(requestEmbeddings(['a'], config, 'secret', { fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret' }) }),
        error => error.message.includes('401') && !error.message.includes('secret'));
});
test('请求超时和外部取消均终止请求', async () => {
    const hangingFetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    await assert.rejects(requestEmbeddings(['a'], { ...config, timeoutSeconds: .01 }, '', { fetchImpl: hangingFetch }), /超时/);
    const controller = new AbortController();
    const promise = requestEmbeddings(['a'], config, '', { signal: controller.signal, fetchImpl: hangingFetch });
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
});
test('余弦相似度正确，对非法维度明确报错', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.throws(() => cosineSimilarity([1], [1, 0]), /维数/);
});
test('增量缓存只为新内容请求向量；更换接口或模型使缓存失效', async () => {
    const cache = new VectorCache({ indexedDB: null });
    const calls = [];
    const index = new EmbeddingIndex(cache, async texts => { calls.push([...texts]); return texts.map(() => [1, 0]); });
    const records = [{ id: 'a', extracted: 'old', floor: 1 }, { id: 'b', extracted: 'other', floor: 2 }];
    await index.ensure('chat1', records, config, '');
    await index.ensure('chat1', records, config, '');
    assert.deepEqual(calls, [['old', 'other']]);
    records[0].override = 'edited';
    await index.ensure('chat1', records, config, '');
    assert.deepEqual(calls.at(-1), ['edited']);
    await index.ensure('chat1', records, { ...config, model: 'new' }, '');
    assert.deepEqual(calls.at(-1), ['edited', 'other']);
    assert.notEqual(index.cacheKey('chat1', records[0], config), index.cacheKey('chat2', records[0], config));
});
test('向量按相似度排序，低于阈值不填充', async () => {
    const cache = new VectorCache({ indexedDB: null });
    const index = new EmbeddingIndex(cache, async texts => texts.map(text => text === 'similar' || text === 'query' ? [1, 0] : [0, 1]));
    const records = [{ id: 'a', floor: 1, extracted: 'unrelated' }, { id: 'b', floor: 2, extracted: 'similar' }];
    const hits = await index.search('chat', records, 'query', 8, config, '');
    assert.deepEqual(hits.map(hit => hit.record.id), ['b']);
});
test('清理缓存只影响指定聊天，保留活动键', async () => {
    const cache = new VectorCache({ indexedDB: null });
    await cache.put([{ key: 'a', scope: 'one', vector: [1] }, { key: 'b', scope: 'two', vector: [2] }, { key: 'c', scope: 'one', vector: [3] }]);
    await cache.prune('one', new Set(['c']));
    assert.deepEqual(await cache.read(['a', 'b', 'c']), [undefined, [2], [3]]);
});

test('模型列表地址可由根地址或完整 Embedding 地址推导', () => {
    assert.equal(modelsUrl('https://a.example/v1/'), 'https://a.example/v1/models');
    assert.equal(modelsUrl('https://a.example/proxy/v1/embeddings/'), 'https://a.example/proxy/v1/models');
    assert.equal(modelsUrl('https://a.example/v1/models'), 'https://a.example/v1/models');
    assert.equal(embeddingUrl('https://a.example/v1/models/'), 'https://a.example/v1/embeddings');
    assert.throws(() => modelsUrl('not a url'), /有效/);
});
test('只填 URL 与密钥即可 GET 模型列表，不要求预先选择模型', async () => {
    const models = await requestModels({ ...config, model: '' }, 'unsaved-key', {
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://embedding.example/v1/models');
            assert.equal(options.method, 'GET');
            assert.equal(options.body, undefined);
            assert.equal(options.credentials, 'omit');
            assert.equal(options.headers.Authorization, 'Bearer unsaved-key');
            return response({ data: [{ id: 'z-model' }, { id: 'embedding-model' }, { id: 'z-model' }, { id: 42 }] });
        },
    });
    assert.deepEqual(models, ['embedding-model', 'z-model']);
});
test('模型列表保留未包含 embedding 字样的模型，免密服务不发送密钥头', async () => {
    const models = await requestModels(config, '', { fetchImpl: async (_url, options) => {
        assert.equal('Authorization' in options.headers, false);
        return response({ data: [{ id: 'my-private-123' }, { id: ' bge-m3 ' }] });
    } });
    assert.deepEqual(models, ['bge-m3', 'my-private-123']);
});
test('模型列表为空、格式错误和非法模型 ID 有明确处理', async () => {
    assert.deepEqual(await requestModels(config, '', { fetchImpl: async () => response({ data: [] }) }), []);
    for (const body of [null, {}, { data: {} }, { data: [{ id: null }] }]) {
        await assert.rejects(requestModels(config, '', { fetchImpl: async () => response(body) }), /模型列表/);
    }
});
test('模型列表错误不泄露密钥，网络和 JSON 错误可诊断', async () => {
    await assert.rejects(requestModels(config, 'secret-key', {
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret-key' }),
    }), error => error.message.includes('401') && !error.message.includes('secret-key'));
    await assert.rejects(requestModels(config, '', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /CORS/);
    await assert.rejects(requestModels(config, '', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } }) }), /JSON/);
});
test('模型列表支持超时与请求取消', async () => {
    const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    await assert.rejects(requestModels({ ...config, timeoutSeconds: .01 }, '', { fetchImpl }), /模型列表请求超时/);
    const controller = new AbortController();
    const pending = requestModels(config, '', { fetchImpl, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(requestModels(config, '', { fetchImpl, signal: controller.signal }), { name: 'AbortError' });
});
