import { fingerprint, keywordTextOf, parseKeywordExtraBody, splitKeywords, summaryOf, normalizeText } from './core.js';
import { chatCompletionsUrl, requestApiJson } from './embeddings.js';
import { RegexRunner } from './regex-runner.js';
import { parseKeywordJSON } from './keyword-json.js';

export function needsAIKeywords(record, mode = 'missing') {
    if (!summaryOf(record)) return false;
    if (mode === 'replace') return true;
    const empty = !(record.keywords ?? []).some(word => typeof word === 'string' && word.trim());
    if (!empty) return false;
    // An explicit batch run retries every empty record, even a manually cleared or previously processed one.
    if (mode !== 'auto') return true;
    // Only automatic duplicate events reuse the empty-result marker to avoid repeated requests.
    return record.keywordSource !== 'ai' || record.keywordSummaryHash !== fingerprint(summaryOf(record));
}

export function keywordRequestExtras(settings) {
    const extra = parseKeywordExtraBody(settings.aiKeywordExtraBody);
    if (settings.aiKeywordThinking === 'off') return { ...extra, enable_thinking: false };
    if (settings.aiKeywordThinking === 'auto' && !Object.hasOwn(extra, 'enable_thinking')) {
        let hostname = '';
        try { hostname = new URL(settings.aiKeywordEndpoint).hostname.toLowerCase(); } catch { /* URL validation follows. */ }
        if (['api.siliconflow.cn', 'api.siliconflow.com'].includes(hostname)
            && /(?:^|\/)qwen3-8b$/i.test(String(settings.aiKeywordModel).trim())) {
            return { ...extra, enable_thinking: false };
        }
    }
    return extra;
}

export async function cleanAIKeywords(suggestions, settings, names = {}, {
    signal, runner = new RegexRunner(),
} = {}) {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    const words = suggestions.flatMap(item => item.keywords);
    let cleaned = words;
    if (settings.aiKeywordCleanupRules?.some(rule => rule.enabled !== false)) {
        cleaned = [];
        for (let offset = 0; offset < words.length; offset += 64) {
            const batch = await runner.run(words.slice(offset, offset + 64), settings, signal, 'keywords');
            cleaned.push(...batch.map(item => item.cleaned));
        }
    }
    const userName = normalizeText(String(names.user ?? '').trim());
    let offset = 0;
    return suggestions.map(item => {
        const seen = new Set();
        const candidates = cleaned.slice(offset, offset + item.keywords.length).flatMap(splitKeywords);
        offset += item.keywords.length;
        const keywords = candidates.filter(word => {
            const normalized = normalizeText(word);
            if (settings.aiKeywordExcludeUser && (/^\{\{\s*user\s*\}\}$/i.test(word)
                || (userName && normalized === userName))) return false;
            if (seen.has(normalized)) return false;
            seen.add(normalized); return true;
        }).slice(0, settings.aiKeywordLimit);
        return { ...item, keywords };
    });
}

export function keywordMessages(records, settings, names = {}) {
    const values = {
        summaries: JSON.stringify(records.map(record => ({
            floor: record.floor, character: record.name ?? '', summary: summaryOf(record),
        }))),
        max_keywords: String(settings.aiKeywordLimit), char: names.char ?? '', user: names.user ?? '',
    };
    const messages = settings.aiKeywordPrompts.map(message => ({
        role: message.role,
        // One replacement pass: text supplied by a summary never expands as a macro.
        content: message.content.replace(/\{\{(summaries|max_keywords|char|user)\}\}/g, (_match, key) => values[key]),
    }));
    if (settings.aiKeywordExcludeUser) {
        // Append to the task message so already-saved presets receive the same exclusion as new presets.
        const task = messages.findLast(message => message.role === 'user');
        const instruction = '\n额外要求：不要将用户占位符 {{user}} 或当前用户本人'
            + (values.user ? '（名字：' + JSON.stringify(values.user) + '）' : '')
            + '列为关键词；仅保留其他明确出现的人名、地名及有区分度的专名，不要凑数。';
        if (task) task.content += instruction;
        else messages.push({ role: 'user', content: instruction.trim() });
    }
    return messages;
}

export function parseKeywordResponse(content, records, limit, { onRepair = () => {} } = {}) {
    if (typeof content !== 'string') throw new Error('AI 关键词接口未返回文本内容。');
    let parsed, repairs;
    try { ({ value: parsed, repairs } = parseKeywordJSON(content)); }
    catch (error) { throw new Error('AI 关键词 JSON 无法可靠修复：' + error.message + '。本批未写入。'); }
    const notes = new Set(repairs);
    let items = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(parsed) && parsed && !Object.hasOwn(parsed, 'items')
        && Object.hasOwn(parsed, 'floor') && Object.hasOwn(parsed, 'keywords')) {
        items = [parsed]; notes.add('接收单楼 JSON 对象');
    }
    if (!Array.isArray(items)) {
        throw new Error('AI 关键词结果格式不正确：需要 {"items":[...]}、直接数组或单楼对象。本批未写入。');
    }
    if (items.length !== records.length) {
        throw new Error('AI 关键词结果数量与本批楼层不一致：本批 ' + records.length + ' 楼（'
            + records.map(record => record.floor).join('、') + '），返回 ' + items.length + ' 项。本批未写入。');
    }
    const byFloor = new Map(records.map(record => [record.floor, record]));
    const seen = new Set();
    const result = items.map(item => {
        let floor = item?.floor;
        if (typeof floor === 'string' && /^\d+$/.test(floor.trim())) {
            floor = Number(floor.trim()); notes.add('将字符串楼号转为整数');
        }
        let words = item?.keywords;
        if (typeof words === 'string') {
            words = splitKeywords(words); notes.add('将关键词字符串转为数组');
        }
        const record = byFloor.get(floor);
        if (!record || !Number.isInteger(floor) || seen.has(floor) || !Array.isArray(words)
            || words.some(word => typeof word !== 'string' || word.length > 120 || /[\r\n]/.test(word))) {
            throw new Error('AI 关键词返回了未知／重复楼号或无效关键词，本批未写入。');
        }
        seen.add(floor);
        const keywords = [...new Set(words.flatMap(splitKeywords))].slice(0, limit);
        return { id: record.id, keywords };
    });
    onRepair([...notes]);
    return result;
}

export async function requestAIKeywords(records, settings, apiKey, {
    names, onMetrics = () => {}, runner, ...options
} = {}) {
    if (!records.length) return [];
    const model = String(settings.aiKeywordModel ?? '').trim();
    if (!model) throw new Error('请填写 AI 关键词模型名称。');
    const body = {
        ...keywordRequestExtras(settings),
        model, messages: keywordMessages(records, settings, names),
        temperature: settings.aiKeywordTemperature, top_p: settings.aiKeywordTopP,
        max_tokens: settings.aiKeywordMaxTokens, stream: false,
        ...(settings.aiKeywordJsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    const started = performance.now();
    let response, receivedAt;
    let jsonRepairs = [];
    try {
        response = await requestApiJson(chatCompletionsUrl(settings.aiKeywordEndpoint),
            { timeoutSeconds: settings.aiKeywordTimeoutSeconds }, apiKey, 'AI 关键词 ', { ...options, method: 'POST', body });
        receivedAt = performance.now();
        if (response?.choices?.[0]?.finish_reason === 'length') {
            throw new Error('AI 关键词输出被长度上限截断，本批未写入。请减少每批楼数或增加输出上限。');
        }
        const suggestions = parseKeywordResponse(response?.choices?.[0]?.message?.content, records, Infinity, {
            onRepair: repairs => { jsonRepairs = repairs; },
        });
        return await cleanAIKeywords(suggestions, settings, names, { signal: options.signal, runner });
    } finally {
        const ended = performance.now();
        const usage = response?.usage;
        const message = response?.choices?.[0]?.message;
        onMetrics({
            floors: records.length,
            inputChars: body.messages.reduce((total, message) => total + message.content.length, 0),
            requestSeconds: ((receivedAt ?? ended) - started) / 1000,
            processingSeconds: receivedAt === undefined ? 0 : (ended - receivedAt) / 1000,
            requestThinking: body.enable_thinking,
            responseReceived: receivedAt !== undefined,
            jsonRepairs,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
            hasReasoning: Boolean((typeof message?.reasoning_content === 'string' && message.reasoning_content.trim())
                || /<(?:think|thinking)>\s*\S[\s\S]*?<\/(?:think|thinking)>/i.test(message?.content ?? '')),
        });
    }
}

/** Commit only against exactly the summaries and keyword edits used by the request. */
export function applyAIKeywords(current, batch, suggestions) {
    const byId = new Map(current.map(record => [record.id, record]));
    const updates = new Map(suggestions.map(item => [item.id, item.keywords]));
    if (updates.size !== batch.length) throw new Error('AI 关键词结果不完整，本批未写入。');
    for (const old of batch) {
        const now = byId.get(old.id);
        if (!now || !updates.has(old.id) || summaryOf(now) !== summaryOf(old)
            || keywordTextOf(now) !== keywordTextOf(old) || now.keywordSource !== old.keywordSource
            || JSON.stringify(now.keywords ?? []) !== JSON.stringify(old.keywords ?? [])) {
            throw new DOMException('总结或关键词已修改，本批结果已取消。', 'AbortError');
        }
    }
    return current.map(record => updates.has(record.id) ? {
        ...record, keywords: updates.get(record.id), keywordText: updates.get(record.id).join(','),
        keywordSource: 'ai', keywordSummaryHash: fingerprint(summaryOf(record)),
    } : record);
}
