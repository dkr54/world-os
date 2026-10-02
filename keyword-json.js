// Repairs syntax around complete values; never executes model output or invents missing values.
const MAX_LENGTH = 512 * 1024;
const MAX_DEPTH = 32;
const MAX_VALUES = 20000;
const symbols = { '｛': '{', '｝': '}', '［': '[', '］': ']', '，': ',', '：': ':' };
const quotes = { '"': '"', "'": "'", '“': '”', '”': '”', '‘': '’', '’': '’' };
const tickFence = String.fromCharCode(96).repeat(3);
const structural = char => symbols[char] ?? char;
const isQuote = char => Object.hasOwn(quotes, char ?? '');
const isOpen = char => ['{', '['].includes(structural(char));
const isClose = char => ['}', ']'].includes(structural(char));

class JsonReader {
    constructor(text, repairs) {
        this.text = text;
        this.repairs = repairs;
        this.index = 0;
        this.values = 0;
        this.closers = [];
    }
    fail(reason) { throw new Error(reason + '（位置 ' + (this.index + 1) + '）'); }
    peek() { return structural(this.text[this.index]); }
    take() {
        const char = this.text[this.index++];
        if (Object.hasOwn(symbols, char ?? '')) this.repairs.add('转换字符串外的全角结构标点');
        return structural(char);
    }
    skip() {
        while (this.index < this.text.length) {
            if (/\s/.test(this.text[this.index])) { this.index++; continue; }
            if (this.text.startsWith('//', this.index)) {
                const end = this.text.indexOf('\n', this.index + 2);
                this.index = end < 0 ? this.text.length : end + 1;
                this.repairs.add('移除 JSON 注释'); continue;
            }
            if (this.text.startsWith('/*', this.index)) {
                const end = this.text.indexOf('*/', this.index + 2);
                if (end < 0) this.fail('块注释未结束');
                this.index = end + 2; this.repairs.add('移除 JSON 注释'); continue;
            }
            break;
        }
    }
    string() {
        const opening = this.text[this.index++];
        const closing = quotes[opening];
        if (opening !== '"') this.repairs.add('转换单引号或弯引号');
        let result = '';
        while (this.index < this.text.length) {
            const char = this.text[this.index++];
            if (char === closing) return result;
            if (char === '\r' || char === '\n') this.fail('字符串中存在未转义换行，不能确定关键词边界');
            if (char !== '\\') { result += char; continue; }
            if (this.index >= this.text.length) this.fail('字符串在转义符处中断');
            const escape = this.text[this.index++];
            const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (Object.hasOwn(escapes, escape)) { result += escapes[escape]; continue; }
            if (escape === "'" && opening === "'") { result += "'"; continue; }
            if (escape === 'u') {
                const hex = this.text.slice(this.index, this.index + 4);
                if (!/^[\da-f]{4}$/i.test(hex)) this.fail('Unicode 转义未完成或无效');
                result += String.fromCharCode(parseInt(hex, 16)); this.index += 4; continue;
            }
            if (escape === '\r' || escape === '\n') this.fail('字符串在换行处中断');
            // Keep an unknown escape literally, rather than silently dropping its backslash.
            result += '\\' + escape; this.repairs.add('保留并转义无效反斜杠');
        }
        this.fail('字符串未闭合，不能补造被截断的关键词');
    }
    key() {
        if (isQuote(this.text[this.index])) return this.string();
        const start = this.index;
        if (!/[A-Za-z_$]/.test(this.text[this.index] ?? '')) this.fail('字段名缺失或无效');
        while (this.index < this.text.length && /[A-Za-z0-9_$]/.test(this.text[this.index])) this.index++;
        this.repairs.add('补上字段名引号');
        return this.text.slice(start, this.index);
    }
    startsValue() {
        const char = this.text[this.index];
        return isQuote(char) || isOpen(char) || /[-\d]/.test(char ?? '') || /^(?:true|false|null)\b/.test(this.text.slice(this.index));
    }
    finished(close) {
        if (this.peek() === close) { this.take(); return true; }
        if (this.index === this.text.length
            || (isClose(this.text[this.index]) && this.closers.slice(0, -1).includes(this.peek()))) {
            this.repairs.add('补全完整值之后的闭括号'); return true;
        }
        return false;
    }
    container(depth) {
        const object = this.take() === '{';
        const close = object ? '}' : ']';
        const result = object ? {} : [];
        this.closers.push(close);
        try {
            this.skip();
            if (this.peek() === close) { this.take(); return result; }
            while (true) {
                if (this.index >= this.text.length) this.fail('容器在字段或值之前中断');
                if (object) {
                    const key = this.key();
                    if (Object.hasOwn(result, key)) this.fail('同一对象有重复字段 ' + (['items', 'floor', 'keywords'].includes(key) ? key : '，无法判断应使用哪项'));
                    this.skip();
                    if (this.peek() === ':') this.take();
                    else if (['items', 'floor', 'keywords'].includes(key) && this.startsValue()) this.repairs.add('补上明确缺失的字段冒号');
                    else this.fail('字段冒号缺失，不能确定对应值');
                    const value = this.value(depth + 1);
                    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
                } else result.push(this.value(depth + 1));
                this.skip();
                if (this.finished(close)) return result;
                if (this.peek() === ',') {
                    this.take(); this.skip();
                    if (this.peek() === close) {
                        this.take(); this.repairs.add('移除尾逗号'); return result;
                    }
                    if (this.index >= this.text.length) this.fail('逗号后缺少下一项，不能补造结果');
                    continue;
                }
                const nextKey = isQuote(this.text[this.index]) || /[A-Za-z_$]/.test(this.text[this.index] ?? '');
                if (object ? nextKey : this.startsValue()) this.repairs.add('补上完整项之间的逗号');
                else this.fail('括号或分隔符不匹配');
            }
        } finally { this.closers.pop(); }
    }
    value(depth = 0) {
        if (depth > MAX_DEPTH || ++this.values > MAX_VALUES) this.fail('JSON 嵌套或条目过多');
        this.skip();
        if (isOpen(this.text[this.index])) return this.container(depth);
        if (isQuote(this.text[this.index])) return this.string();
        const rest = this.text.slice(this.index);
        const literal = /^(true|false|null)(?![\w$])/.exec(rest);
        if (literal) {
            this.index += literal[0].length;
            return literal[0] === 'null' ? null : literal[0] === 'true';
        }
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
        if (number) {
            this.index += number[0].length;
            const value = Number(number[0]);
            if (!Number.isFinite(value)) this.fail('数值超出有效范围');
            return value;
        }
        this.fail(this.index >= this.text.length ? '字段值缺失或被截断' : '存在无法可靠识别的值');
    }
}

function trimWrappers(text, repairs) {
    let current = text.trim();
    for (let pass = 0; pass < 8; pass++) {
        const leading = new JsonReader(current, repairs);
        leading.skip();
        current = current.slice(leading.index);
        const firstOpen = current.search(/[\[{\uFF3B\uFF5B]/);
        const thought = /<(think|thinking)\b[^>]*>/i.exec(current);
        if (thought && (firstOpen < 0 || thought.index < firstOpen)) {
            const afterOpening = thought.index + thought[0].length;
            const end = new RegExp('</' + thought[1] + '\\s*>', 'i').exec(current.slice(afterOpening));
            if (!end) throw new Error('思考标签未结束，不能从中提取结果');
            current = current.slice(afterOpening + end.index + end[0].length).trim();
            repairs.add('移除已结束的思考片段'); continue;
        }
        const fence = [tickFence, '~~~'].find(marker => current.startsWith(marker));
        if (fence) {
            const prefix = new RegExp('^' + fence + '(?:json|javascript|js)?[ \\t]*(?:\\r?\\n)?', 'i').exec(current);
            if (prefix) {
                current = current.slice(prefix[0].length).trim();
                if (current.endsWith(fence)) current = current.slice(0, -fence.length).trim();
                repairs.add('移除代码围栏'); continue;
            }
        }
        return current;
    }
    throw new Error('输出包裹层数过多');
}

function readDocument(source, repairs, layer = 0) {
    if (layer > 2) throw new Error('JSON 字符串重复编码层数过多');
    const text = trimWrappers(source, repairs);
    if (!text) throw new Error('输出为空');
    // Decode a whole escaped JSON document, never replace backslashes inside individual names.
    if (/^[{\[]\s*\\"/.test(text) || /^\[\s*\{\s*\\"/.test(text)) {
        try {
            const encoded = text.replace(/[\r\n\t]/g, char => JSON.stringify(char).slice(1, -1));
            const decoded = JSON.parse('"' + encoded + '"');
            repairs.add('解开额外的 JSON 转义');
            return readDocument(decoded, repairs, layer + 1);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    const reader = new JsonReader(text, repairs);
    reader.skip();
    if (!isOpen(text[reader.index]) && !isQuote(text[reader.index])) {
        const start = text.slice(reader.index).search(/[\[{\uFF3B\uFF5B]/);
        if (start >= 0) { reader.index += start; repairs.add('提取说明文字中的 JSON 正文'); }
    }
    const values = [reader.value()];
    while (true) {
        reader.skip();
        while (isClose(text[reader.index]) || [',', ';', '；'].includes(reader.peek())) {
            reader.take(); repairs.add('移除正文后的多余括号或分隔符'); reader.skip();
        }
        if (reader.index >= text.length) break;
        if (isOpen(text[reader.index])) {
            if (values.length >= 128) throw new Error('独立 JSON 片段过多');
            values.push(reader.value()); continue;
        }
        const suffix = text.slice(reader.index);
        if (/[\[{\uFF3B\uFF5B]/.test(suffix) || /["'“](?:items|floor|keywords)["'”]\s*[:：]/.test(suffix)
            || /^(?:["'“‘]|-?\d|true\b|false\b|null\b)/.test(suffix)) {
            throw new Error('正文后仍有其他 JSON 或数据片段，不能确定唯一结果');
        }
        repairs.add('移除 JSON 后的说明或代码围栏'); break;
    }
    if (values.length > 1) {
        if (!values.every(value => value && !Array.isArray(value) && typeof value === 'object'
            && Object.hasOwn(value, 'floor') && Object.hasOwn(value, 'keywords') && !Object.hasOwn(value, 'items'))) {
            throw new Error('返回了多份 JSON 结果，不能自动选择或合并');
        }
        repairs.add('合并逐楼 JSON 对象');
        return values;
    }
    const value = values[0];
    if (typeof value === 'string' && /^[\s]*[{\["“'‘]/.test(value)) {
        repairs.add('解开重复编码的 JSON 字符串');
        return readDocument(value, repairs, layer + 1);
    }
    return value;
}

export function parseKeywordJSON(content) {
    if (typeof content !== 'string') throw new Error('接口未返回文本内容');
    if (content.length > MAX_LENGTH) throw new Error('JSON 响应超过长度限制（524288 个字符）');
    const repairs = new Set();
    const value = readDocument(content, repairs);
    return { value, repairs: [...repairs] };
}
