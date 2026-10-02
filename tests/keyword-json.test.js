import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../core.js';
import { parseKeywordJSON } from '../keyword-json.js';
import { parseKeywordResponse, requestAIKeywords, applyAIKeywords } from '../keyword-ai.js';

const records = [7, 8, 9].map(floor => ({ id: 'floor-' + floor, floor, extracted: '第 ' + floor + ' 楼总结' }));
const items = [
    { floor: 7, keywords: ['示例角色甲', '行宫'] },
    { floor: 8, keywords: [] },
    { floor: 9, keywords: ['青石镇', '12，12'] },
];
const json = JSON.stringify({ items });
const expected = items.map(item => ({ id: 'floor-' + item.floor, keywords: item.keywords }));
const fence = String.fromCharCode(96).repeat(3);
const successCases = [
    ['正文最右侧多一个右大括号', json + '}'],
    ['正文后多个多余闭括号与分隔符', json + '}}] ;'],
    ['BOM 和首尾空白', '\uFEFF \n' + json + '\n'],
    ['前后说明和代码围栏', '结果如下：\n' + fence + 'json\n' + json + '\n' + fence + '\n提取完毕。'],
    ['已结束思考中的伪结果忽略', '<think>{"items":[{"floor":99,"keywords":[]}]}</think>\n' + json],
    ['思考前有说明及注释', '// 前置注释 {不要读取}\n思考：<think>{"items":[]}</think>\n' + json],
    ['单引号', json.replaceAll('"', "'")],
    ['弯引号', json.replace(/"([^"]*)"/g, '“$1”')],
    ['未加引号的字段名', json.replace(/"(items|floor|keywords)":/g, '$1:')],
    ['字符串外的中文冒号与逗号', '{"items"：[{"floor"：7，"keywords"：["示例角色甲"，"行宫"]}，{"floor"：8，"keywords"：[]}，{"floor"：9，"keywords"：["青石镇"，"12，12"]}]}'],
    ['全角括号', '｛"items"：［｛"floor"：7，"keywords"：［"示例角色甲"，"行宫"］｝，｛"floor"：8，"keywords"：［］｝，｛"floor"：9，"keywords"：［"青石镇"，"12，12"］｝］｝'],
    ['对象与数组尾逗号', '{"items":[{"floor":7,"keywords":["示例角色甲","行宫",],},{"floor":8,"keywords":[],},{"floor":9,"keywords":["青石镇","12，12",],},],}'],
    ['完整项之间漏逗号', '{"items":[{"floor":7 "keywords":["示例角色甲" "行宫"]} {"floor":8,"keywords":[]} {"floor":9,"keywords":["青石镇","12，12"]}]}'],
    ['已知字段漏冒号', '{"items" [{"floor" 7,"keywords" ["示例角色甲","行宫"]},{"floor" 8,"keywords" []},{"floor" 9,"keywords" ["青石镇","12，12"]}]}'],
    ['行注释与块注释', '/* 返回 {不要读取} */\n{"items":[\n// 第七楼\n' + JSON.stringify(items[0]) + ',/* 中间说明 */' + JSON.stringify(items[1]) + ',' + JSON.stringify(items[2]) + ']}'],
    ['最后一项完整但少外层闭括号', json.slice(0, -2)],
    ['数组闭括号遗漏但父对象有闭括号', json.slice(0, -2) + '}'],
    ['JSON 被再次编码为字符串', JSON.stringify(json)],
    ['JSON 被编码两次', JSON.stringify(JSON.stringify(json))],
    ['多余的一层反斜杠转义', JSON.stringify(json).slice(1, -1)],
    ['逐行返回楼层对象', items.map(item => JSON.stringify(item)).join('\n')],
    ['逐楼对象间带逗号', items.map(item => JSON.stringify(item)).join(',\n')],
];
for (const [name, content] of successCases) {
    test('容错：' + name, () => {
        assert.deepEqual(parseKeywordResponse(content, records, 8), expected);
    });
}

test('合法 JSON 字符串中的结构符号、中文逗号、引号、路径和注释标记完整保留', () => {
    const words = ['12，12', '{{user}}', '城门[东]{}', '“双引号”', '"引号"', "O'Connor", 'https://example.com/a//b',
        '/*原词*/', 'C:\\town\\gate', '表情😀', '三个反引号' + fence, '全角｛［：，］｝'];
    const value = { items: [{ floor: 7, keywords: words }] };
    const result = parseKeywordResponse(JSON.stringify(value), records.slice(0, 1), 30);
    assert.deepEqual(result[0].keywords, words);
    assert.deepEqual(parseKeywordJSON(JSON.stringify(value)).repairs, []);
});
test('无效反斜杠保留字面含义，不吞掉字符；单引号内转义还原', () => {
    const content = String.raw`{items:[{floor:7,keywords:["\q门",'O\'Connor']}]} `;
    const result = parseKeywordResponse(content, records.slice(0, 1), 8);
    assert.deepEqual(result[0].keywords, ['\\q门', "O'Connor"]);
});
test('单楼对象、字符串楼号与关键词字符串兼容；中文逗号仍是词的一部分', () => {
    let repairs;
    const result = parseKeywordResponse('{"floor":" 7 ","keywords":"示例角色甲,12，12"}', records.slice(0, 1), 8, {
        onRepair: value => { repairs = value; },
    });
    assert.deepEqual(result, [{ id: 'floor-7', keywords: ['示例角色甲', '12，12'] }]);
    assert.equal(repairs.length, 3);
});
test('修复后按实际楼号保存，乱序结果不改变映射或覆盖其他楼', () => {
    const input = [{ id: 'other', floor: 4, extracted: '已有总结', keywords: ['手动保留'] }, ...records];
    const result = parseKeywordResponse(JSON.stringify([...items].reverse()) + '}', records, 8);
    const next = applyAIKeywords(input, records, result);
    assert.equal(next[0], input[0]);
    assert.deepEqual(next.slice(1).map(record => record.keywords), items.map(item => item.keywords));
});

const failureCases = [
    ['关键词字符串中断', '{"items":[{"floor":7,"keywords":["罗翎'],
    ['转义字符中断', '{"items":[{"floor":7,"keywords":["罗翎' + '\\'],
    ['Unicode 转义中断', '{"items":[{"floor":7,"keywords":["' + '\\u12'],
    ['完整字段名后没有值', '{"items":[{"floor":7,"keywords":'],
    ['逗号后内容截断', json.slice(0, -2) + ','],
    ['重复对象字段', '{"items":[{"floor":7,"floor":8,"keywords":[]}]}'],
    ['两份完整候选结果', json + '\n' + json],
    ['示例后另有正式结果', '示例：' + json + '\n正式结果：' + json],
    ['JSON 后有另一个标量', json + '\nfalse'],
    ['尚未结束的思考', '<think>内部JSON：' + json],
    ['说明后的尚未结束思考', '先思考：<think>' + json],
    ['未闭合注释', '{"items":/* 没有结束'],
    ['关键词无引号且不能确定边界', '{"items":[{"floor":7,"keywords":[示例角色甲]}]}'],
    ['不能执行 JavaScript 表达式', '{"items":(globalThis.__keywordRepairExecuted=true,[])}'],
    ['原始换行截断关键词', '{"items":[{"floor":7,"keywords":["罗\n翎"]}]}'],
];
for (const [name, content] of failureCases) {
    test('拒绝猜测：' + name, () => {
        assert.throws(() => parseKeywordResponse(content, records, 8), /无法可靠修复/);
        assert.equal(globalThis.__keywordRepairExecuted, undefined);
    });
}
test('容错后仍拒绝缺楼、多楼、重复楼号、未知楼号与非字符串关键词', () => {
    const invalid = [
        items.slice(0, 2), [...items, { floor: 10, keywords: [] }],
        [items[0], { floor: '7', keywords: [] }, items[2]],
        [items[0], items[1], { floor: 99, keywords: [] }],
        [items[0], items[1], { floor: 9, keywords: [123] }],
        [items[0], items[1], { floor: 9, keywords: null }],
    ];
    for (const value of invalid) assert.throws(() => parseKeywordResponse(JSON.stringify({ items: value }) + '}', records, 8), /数量|未知／重复楼号或无效关键词/);
});
test('深度与长度限制避免异常输出拖住界面', () => {
    assert.throws(() => parseKeywordJSON('['.repeat(40) + '0' + ']'.repeat(40)), /嵌套/);
    assert.throws(() => parseKeywordJSON(' '.repeat(512 * 1024 + 1)), /限制/);
});
test('JSON 原型字段按普通数据处理，不污染对象原型', () => {
    const parsed = parseKeywordJSON('{"__proto__":{"polluted":true},"items":[]}').value;
    assert.equal(Object.hasOwn(parsed, '__proto__'), true);
    assert.equal({}.polluted, undefined);
});
test('实际请求本地修复后再清洗并报告操作，没有追加模型请求；长度截断依旧拒绝', async () => {
    const config = normalizeSettings({ aiKeywordEndpoint: 'https://example.invalid/v1', aiKeywordModel: 'test' });
    let metrics, calls = 0;
    const response = finish_reason => ({ ok: true, json: async () => ({
        choices: [{ finish_reason, message: { content: '{"items":[{"floor":"7","keywords":["{{user}}","旅行者","示例角色甲","12，12"],},],}}' } }],
    }) });
    const result = await requestAIKeywords(records.slice(0, 1), config, '', {
        names: { user: '旅行者' }, onMetrics: value => { metrics = value; },
        fetchImpl: async () => { calls++; return response('stop'); },
    });
    assert.deepEqual(result, [{ id: 'floor-7', keywords: ['示例角色甲', '12，12'] }]);
    assert.equal(calls, 1);
    assert.ok(metrics.jsonRepairs.some(note => note.includes('多余括号')));
    assert.ok(metrics.jsonRepairs.some(note => note.includes('尾逗号')));
    await assert.rejects(requestAIKeywords(records.slice(0, 1), config, '', { fetchImpl: async () => response('length') }), /截断/);
});

test('合法 JSON 的随机转义与 Unicode 字符逐字保留，不被容错规则误改', () => {
    let seed = 1709;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const characters = ['"', "'", '\\', '{', '}', '[', ']', ',', '，', '：', '“', '”', '‘', '’', '/', '\n', '\r', '\t', '\0', '\u2028', '😀', '罗', 'a'];
    for (let sample = 0; sample < 200; sample++) {
        const words = Array.from({ length: 4 }, () => Array.from({ length: 32 }, () => characters[next() % characters.length]).join(''));
        const source = { items: [{ floor: 7, keywords: words }], extra: [true, false, null, 1.25e4] };
        const actual = parseKeywordJSON(JSON.stringify(source));
        assert.deepEqual(actual.value, source, 'sample ' + sample);
        assert.deepEqual(actual.repairs, []);
    }
});
