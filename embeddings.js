import { fingerprint, summaryOf } from './core.js';
import { apiNetworkError } from './host-runtime.js';

function compatibleApiUrl(endpoint, resource) {
    const raw = String(endpoint ?? '').trim().replace(/\/+$/, '');
    if (!raw) throw new Error('请先配置 API 接口地址。');
    let url;
    try { url = new URL(raw); }
    catch { throw new Error('请填写有效的 HTTP(S) API 地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('接口地址需为 HTTP(S) URL，不能包含账号密码、查询参数或片段。');
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:embeddings|models|rerank|chat\/completions)$/, '');
    url.pathname += '/' + resource;
    return url.toString();
}

export function embeddingUrl(endpoint) { return compatibleApiUrl(endpoint, 'embeddings'); }
export function modelsUrl(endpoint) { return compatibleApiUrl(endpoint, 'models'); }
export function rerankUrl(endpoint) { return compatibleApiUrl(endpoint, 'rerank'); }
export function chatCompletionsUrl(endpoint) { return compatibleApiUrl(endpoint, 'chat/completions'); }

export function validateVector(vector, dimension) {
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)
        || !vector.some(value => value !== 0) || (dimension !== undefined && vector.length !== dimension)) {
        throw new Error('Embedding 返回了无效向量或不一致的维数。请检查模型，必要时清空向量缓存。');
    }
    return vector;
}

export function cosineSimilarity(left, right) {
    validateVector(left);
    validateVector(right, left.length);
    let dot = 0, a = 0, b = 0;
    for (let index = 0; index < left.length; index++) {
        dot += left[index] * right[index];
        a += left[index] ** 2;
        b += right[index] ** 2;
    }
    const score = dot / Math.sqrt(a * b);
    if (!Number.isFinite(score)) throw new Error('向量数值溢出，无法计算相似度。');
    return Math.max(-1, Math.min(1, score));
}

export async function requestApiJson(url, settings, apiKey, label, {
    method = 'GET', body, signal, fetchImpl = globalThis.fetch,
} = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutSeconds * 1000);
    try {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (apiKey?.trim()) headers.Authorization = 'Bearer ' + apiKey.trim();
        const response = await fetchImpl(url, {
            method, headers, credentials: 'omit', signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            // Provider response text may echo credentials. Never display or log it.
            throw new Error(label + '请求失败（HTTP ' + response.status + '）。请检查地址、密钥和服务权限。');
        }
        return await response.json();
    } catch (error) {
        if (timedOut) throw new Error(label + '请求超时。');
        if (error.name === 'AbortError') throw error;
        if (error instanceof TypeError) throw new Error(apiNetworkError(url));
        if (error instanceof SyntaxError) throw new Error(label + '返回了无效的 JSON。');
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/** Uses only endpoint, key and timeout; a model need not be configured yet. */
export async function requestModels(settings, apiKey, options = {}) {
    const body = await requestApiJson(modelsUrl(settings.endpoint), settings, apiKey, '模型列表', options);
    if (!Array.isArray(body?.data)) throw new Error('模型列表格式不正确，服务应返回包含模型 id 的 data 数组。');
    const ids = body.data.filter(item => typeof item?.id === 'string' && item.id.trim()).map(item => item.id.trim());
    if (body.data.length && !ids.length) throw new Error('模型列表没有有效的模型 id。');
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function requestEmbeddings(texts, settings, apiKey, options = {}) {
    if (!texts.length) return [];
    const url = embeddingUrl(settings.endpoint);
    const model = String(settings.model ?? '').trim();
    if (!model) throw new Error('请填写 Embedding 模型名称。');
    const body = await requestApiJson(url, settings, apiKey, 'Embedding ', {
        ...options, method: 'POST', body: { model, input: texts, encoding_format: 'float' },
    });
    if (!Array.isArray(body?.data) || body.data.length !== texts.length) {
        throw new Error('Embedding 响应数量与输入不一致。');
    }
    const results = new Array(texts.length);
    let dimension;
    for (const item of body.data) {
        if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= texts.length || results[item.index]) {
            throw new Error('Embedding 响应包含缺失、重复或非法 index。');
        }
        results[item.index] = validateVector(item.embedding, dimension);
        dimension ??= item.embedding.length;
    }
    return results;
}

/** Cohere/Jina-compatible rerank; cosine scores remain separate from relevance scores. */
export async function requestRerank(hits, query, count, settings, apiKey, options = {}) {
    if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (!hits.length || count <= 0) return [];
    const model = String(settings.rerankModel ?? '').trim();
    if (!model) throw new Error('请填写 Rerank 模型名称。');
    const topN = Math.min(count, hits.length);
    const body = await requestApiJson(rerankUrl(settings.rerankEndpoint),
        { timeoutSeconds: settings.rerankTimeoutSeconds }, apiKey, 'Rerank ', {
            ...options, method: 'POST',
            body: { model, query, documents: hits.map(hit => summaryOf(hit.record)), top_n: topN },
        });
    if (!Array.isArray(body?.results) || body.results.length < topN || body.results.length > hits.length) {
        throw new Error('Rerank 响应缺少足够的 results，或结果数量无效。');
    }
    const seen = new Set();
    return body.results.map(item => {
        if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= hits.length
            || seen.has(item.index) || !Number.isFinite(item.relevance_score)) {
            throw new Error('Rerank 响应包含重复、非法 index 或无效相关度。');
        }
        seen.add(item.index);
        return { ...hits[item.index], rerankScore: item.relevance_score };
    }).sort((a, b) => b.rerankScore - a.rerankScore).slice(0, topN);
}

/** On service failure, retain vector order and surface a warning instead of losing recall. */
export async function rerankVectorCandidates(hits, query, count, settings, apiKey, options = {}) {
    if (options.signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (!settings.rerankEnabled || hits.length <= count) return { hits: hits.slice(0, count), warning: '' };
    try {
        const selected = await requestRerank(hits, query, count, settings, apiKey, options);
        return { hits: selected, warning: '' };
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        return { hits: hits.slice(0, count), warning: '重排不可用，已按向量相似度召回：' + error.message };
    }
}

/** Persistent vectors stay in the browser, never in chat JSON or ST settings. */
export class VectorCache {
    constructor({ indexedDB = globalThis.indexedDB, databaseName = 'floor-memory-v1', onFallback = () => {} } = {}) {
        this.indexedDB = indexedDB;
        this.databaseName = databaseName;
        this.onFallback = onFallback;
        this.memory = new Map();
        this.dbPromise = null;
        this.fallback = false;
    }
    async open() {
        if (this.fallback) return null;
        if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
            if (!this.indexedDB) return reject(new Error('IndexedDB 不可用'));
            const request = this.indexedDB.open(this.databaseName, 1);
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore('vectors', { keyPath: 'key' });
                store.createIndex('scope', 'scope', { unique: false });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('向量数据库正被其他页面占用'));
        });
        try { return await this.dbPromise; }
        catch {
            this.fallback = true;
            this.onFallback('本地向量数据库不可用，已临时使用内存缓存；关闭页面后需要重新建立向量。');
            return null;
        }
    }
    async read(keys) {
        const db = await this.open();
        if (!db) return keys.map(key => this.memory.get(key)?.vector);
        try {
            return await Promise.all(keys.map(key => new Promise((resolve, reject) => {
                const request = db.transaction('vectors', 'readonly').objectStore('vectors').get(key);
                request.onsuccess = () => resolve(request.result?.vector);
                request.onerror = () => reject(request.error);
            })));
        } catch {
            this.fallback = true;
            this.onFallback('读取本地向量缓存失败，已使用临时缓存。');
            return keys.map(key => this.memory.get(key)?.vector);
        }
    }
    async put(entries) {
        const db = await this.open();
        if (db) {
            try {
                await new Promise((resolve, reject) => {
                    const transaction = db.transaction('vectors', 'readwrite');
                    transaction.oncomplete = resolve;
                    transaction.onerror = () => reject(transaction.error);
                    transaction.onabort = () => reject(transaction.error);
                    const store = transaction.objectStore('vectors');
                    for (const entry of entries) store.put(entry);
                });
                return;
            } catch {
                this.fallback = true;
                this.onFallback('写入本地向量缓存失败，已使用临时缓存。');
            }
        }
        for (const entry of entries) this.memory.set(entry.key, entry);
        while (this.memory.size > 2000) this.memory.delete(this.memory.keys().next().value);
    }
    async prune(scope, liveKeys = new Set()) {
        for (const [key, value] of this.memory) {
            if (value.scope === scope && !liveKeys.has(key)) this.memory.delete(key);
        }
        const db = await this.open();
        if (!db) return;
        await new Promise((resolve, reject) => {
            const transaction = db.transaction('vectors', 'readwrite');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
            const request = transaction.objectStore('vectors').index('scope').openCursor(scope);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (!liveKeys.has(cursor.primaryKey)) cursor.delete();
                cursor.continue();
            };
        });
    }
}

export class EmbeddingIndex {
    constructor(cache, request = requestEmbeddings) {
        this.cache = cache;
        this.request = request;
    }
    configKey(settings) {
        return fingerprint(JSON.stringify([embeddingUrl(settings.endpoint), String(settings.model).trim()]));
    }
    cacheKey(scope, record, settings) {
        return scope + ':' + this.configKey(settings) + ':' + record.id + ':' + fingerprint(summaryOf(record));
    }
    async ensure(scope, records, settings, apiKey, { signal, progress = () => {} } = {}) {
        const keys = records.map(record => this.cacheKey(scope, record, settings));
        const vectors = await this.cache.read(keys);
        const missing = records.map((record, index) => ({ record, index })).filter(entry => !vectors[entry.index]);
        for (let start = 0; start < missing.length; start += settings.batchSize) {
            if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
            const batch = missing.slice(start, start + settings.batchSize);
            const received = await this.request(batch.map(entry => summaryOf(entry.record)), settings, apiKey, { signal });
            const entries = batch.map((entry, index) => {
                vectors[entry.index] = received[index];
                return { key: keys[entry.index], scope, vector: received[index] };
            });
            await this.cache.put(entries);
            progress(Math.min(start + batch.length, missing.length), missing.length);
        }
        return vectors;
    }
    async search(scope, records, query, count, settings, apiKey, options = {}) {
        const vectors = await this.ensure(scope, records, settings, apiKey, options);
        const [queryVector] = await this.request([query], settings, apiKey, options);
        return records.map((record, index) => ({ record, score: cosineSimilarity(vectors[index], queryVector) }))
            .filter(hit => hit.score >= settings.similarityThreshold)
            .sort((a, b) => b.score - a.score || b.record.floor - a.record.floor)
            .slice(0, count);
    }
}
