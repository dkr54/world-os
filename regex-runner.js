import {
    compileRegex, validateKeywordCleanupRules, cleanKeywordText,
    validateRegexSettings, processText, processRegexRequest,
} from './core.js';
import { isTauriTavern } from './host-runtime.js';

/** Only serialize our own trusted functions, never provider output or user text. */
export function classicRegexSource() {
    return [compileRegex, validateKeywordCleanupRules, cleanKeywordText,
        validateRegexSettings, processText, processRegexRequest].map(fn => fn.toString()).join('\n\n')
        + '\nself.onmessage = event => self.postMessage(processRegexRequest(event.data));\nself.postMessage({ ready: true });';
}

/** Each job gets a terminable worker. Tauri uses a self-contained classic Blob worker. */
export class RegexRunner {
    constructor({ WorkerClass = globalThis.Worker, timeoutMs = 2500, startupTimeoutMs = 15000,
        mode = isTauriTavern() ? 'classic' : 'module', URLClass = globalThis.URL,
    } = {}) {
        this.WorkerClass = WorkerClass;
        this.timeoutMs = timeoutMs;
        this.startupTimeoutMs = startupTimeoutMs;
        this.mode = mode;
        this.URLClass = URLClass;
    }

    run(texts, settings, signal, operation = 'extract') {
        if (!texts.length) return Promise.resolve([]);
        if (signal?.aborted) return Promise.reject(new DOMException('操作已取消', 'AbortError'));
        return new Promise((resolve, reject) => {
            let worker, timer, blobUrl;
            let settled = false, started = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                worker?.terminate();
                if (blobUrl) this.URLClass.revokeObjectURL(blobUrl);
                error ? reject(error) : resolve(value);
            };
            const abort = () => finish(new DOMException('操作已取消', 'AbortError'));
            try {
                if (typeof this.WorkerClass !== 'function') throw new Error('当前 WebView 不支持后台正则处理，请更新 Android System WebView。');
                let url = new URL('./regex-worker.js', import.meta.url);
                if (this.mode === 'classic') {
                    blobUrl = this.URLClass.createObjectURL(new Blob([classicRegexSource()], { type: 'text/javascript' }));
                    url = blobUrl;
                }
                worker = new this.WorkerClass(url, this.mode === 'classic' ? undefined : { type: 'module' });
                worker.onmessage = event => {
                    if (settled) return;
                    if (event.data.ready) {
                        if (started) return;
                        started = true;
                        clearTimeout(timer);
                        timer = setTimeout(() => finish(new Error('正则处理超时。请检查嵌套量词或过大的匹配范围；本次未修改上下文。')), this.timeoutMs);
                        try { worker.postMessage({ texts, settings, operation }); } catch (error) { finish(error); }
                    } else if (event.data.error) finish(new Error(event.data.error));
                    else finish(null, event.data.results);
                };
                worker.onerror = event => finish(new Error(event.message || '正则工作线程启动失败。请更新 WebView 或重新启动应用。'));
                timer = setTimeout(() => finish(new Error('正则工作线程启动超时，请重新加载应用或更新 WebView。')), this.startupTimeoutMs);
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
            } catch (error) { finish(error); }
        });
    }

    async runBatches(texts, settings, signal, progress = () => {}) {
        const results = [];
        const batchSize = this.mode === 'classic' ? 12 : 24;
        for (let offset = 0; offset < texts.length; offset += batchSize) {
            const batch = await this.run(texts.slice(offset, offset + batchSize), settings, signal);
            for (const result of batch) results.push(result);
            progress(Math.min(offset + batchSize, texts.length), texts.length);
        }
        return results;
    }
}
