import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SETTINGS, normalizeSettings, processText, buildFloors, reconcileRecords, rulesFingerprint,
    partitionFloors, projectPrompt, composePrompt, retrieveMemories, rankKeywords, containsKeyword,
    queryInputs, fingerprint, summaryOf, splitKeywords, keywordTextOf,
} from '../core.js';

const config = overrides => normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), ...overrides });
function conversation(count) {
    return Array.from({ length: count }, (_, index) => [
        { name: 'User', is_user: true, mes: 'question ' + (index + 1), send_date: index * 2 },
        { name: 'Bot', is_user: false, mes: '<content>reply ' + (index + 1) + '</content><summary>summary ' + (index + 1) + '</summary>', send_date: index * 2 + 1 },
    ]).flat();
}
function summaryRecords(floors, settings = config()) {
    return reconcileRecords(floors, [], new Map(floors.map(floor => [floor.id, processText(floor.text, settings).summary])), rulesFingerprint(settings));
}
const record = (id, floor, extracted, keywords) => ({ id, floor, extracted, keywords });

test('清洗先于提取；保留 content 中嵌套的目标总结', () => {
    const input = '<thinking><summary>错误记忆</summary></thinking><content>对白<summary>正确记忆</summary></content>';
    const result = processText(input, config());
    assert.equal(result.summary, '正确记忆');
    assert.equal(result.cleaned, '<content>对白<summary>正确记忆</summary></content>');
    assert.equal(input.includes('错误记忆'), true);
});
test('多条清洗按顺序替换，支持 $1 和命名提取组', () => {
    const result = processText('BEGIN{hi}END', config({
        cleanupRules: [
            { pattern: 'BEGIN\\{(.*?)\\}END', flags: 'g', replacement: '<memo>$1</memo>' },
            { pattern: 'hi', flags: 'g', replacement: 'hello' },
        ],
        extractPattern: '<memo>(?<memory>.*?)</memo>', extractGroup: 'memory',
    }));
    assert.equal(result.summary, 'hello');
});
test('字面量正则、多个匹配、全匹配组与无匹配', () => {
    assert.equal(processText('<SUMMARY>A</SUMMARY><summary>B</summary>', config({ extractPattern: '/<summary>(.*?)<\\/summary>/gi' })).summary, 'A\n\nB');
    assert.equal(processText('abc123', config({ extractPattern: '\\d+', extractGroup: '0' })).summary, '123');
    assert.equal(processText('abc', config()).summary, '');
    assert.equal(processText('<summary>A</summary>', config({ extractGroup: '9' })).summary, '');
});
test('禁用清洗规则不会执行；非法正则拒绝保存', () => {
    assert.equal(processText('<summary>A</summary>', config({ cleanupRules: [{ enabled: false, pattern: '[', flags: 'g' }] })).summary, 'A');
    assert.throws(() => config({ extractPattern: '[' }), /提取规则/);
    assert.throws(() => config({ cleanupRules: [{ pattern: '[', flags: 'g' }] }), /清洗规则 1/);
    assert.throws(() => config({ extractGroup: 'bad group' }), /提取分组/);
});
test('零长度正则匹配能终止', () => {
    assert.equal(processText('ab', config({ extractPattern: '(?=.)', extractGroup: '0' })).summary, '');
});
test('设置拒绝非法数量，允许 N/M/K 为零', () => {
    assert.equal(config({ recentCount: 0 }).recentCount, 0);
    for (const value of [-1, 1.5, NaN, Infinity, 10001]) assert.throws(() => config({ recallCount: value }));
    assert.throws(() => config({ similarityThreshold: 2 }));
    assert.throws(() => config({ batchSize: 0 }));
});
test('一楼按模型回复计数，多条用户消息归入下一楼，尾部用户消息保留', () => {
    const chat = [
        { is_user: false, name: 'Bot', mes: 'greeting' },
        { is_user: true, mes: 'q1' }, { is_user: true, mes: 'q2' },
        { is_system: true, mes: 'hidden' },
        { is_user: false, mes: 'answer' },
        { is_user: true, mes: 'pending' },
    ];
    const { floors, pending } = buildFloors(chat);
    assert.equal(floors.length, 2);
    assert.equal(floors[1].entries.length, 3);
    assert.equal(floors[1].assistantIndex, 4);
    assert.equal(pending[0].message.mes, 'pending');
});
test('楼层边界为旧召回区 + M + N；短聊天和零值正确', () => {
    const { floors } = buildFloors(conversation(100));
    const split = partitionFloors(floors, config({ recentCount: 8, middleCount: 20 }));
    assert.deepEqual(split.older.map(x => x.floor), Array.from({ length: 72 }, (_, i) => i + 1));
    assert.deepEqual(split.middle.map(x => x.floor), Array.from({ length: 20 }, (_, i) => i + 73));
    assert.deepEqual(split.recent.map(x => x.floor), [93, 94, 95, 96, 97, 98, 99, 100]);
    assert.equal(partitionFloors(floors.slice(0, 2), config()).recent.length, 2);
    assert.equal(partitionFloors(floors, config({ recentCount: 0, middleCount: 0 })).older.length, 100);
});
test('续写时 N=0 仍保留最后一楼', () => {
    const { floors } = buildFloors(conversation(3));
    assert.equal(partitionFloors(floors, config({ recentCount: 0 }), 'continue').recent[0].floor, 3);
});
test('修改用户消息或回复、切换 swipe 都使对应内容标识失效', () => {
    const chat = conversation(2);
    const before = buildFloors(chat).floors;
    chat[0].mes = 'edited question';
    const after = buildFloors(chat).floors;
    assert.notEqual(before[0].id, after[0].id);
    assert.equal(before[1].id, after[1].id);
    chat[3].swipe_id = 1;
    assert.notEqual(buildFloors(chat).floors[1].id, after[1].id);
});
test('删除前方楼层后标识稳定，楼号更新且旧记录被移除', () => {
    const chat = conversation(3);
    const before = summaryRecords(buildFloors(chat).floors);
    before[2].override = 'manual';
    const floors = buildFloors(chat.slice(2)).floors;
    const after = reconcileRecords(floors, before, new Map(), rulesFingerprint(config()));
    assert.equal(after.length, 2);
    assert.equal(after[1].id, before[2].id);
    assert.equal(after[1].floor, 2);
    assert.equal(summaryOf(after[1]), 'manual');
});
test('重复且无日期的消息仍有不同记录 ID', () => {
    const { floors } = buildFloors([{ mes: 'same' }, { mes: 'same' }]);
    assert.notEqual(floors[0].id, floors[1].id);
});
test('更新正则提取结果保留人工覆盖', () => {
    const { floors } = buildFloors(conversation(1));
    const old = summaryRecords(floors);
    old[0].override = 'manual';
    old[0].keywords = ['星钥', '12，12'];
    old[0].keywordText = '星钥, 12，12';
    old[0].keywordSource = 'manual';
    old[0].keywordSummaryHash = 'prior-summary';
    const next = reconcileRecords(floors, old, new Map([[floors[0].id, 'new auto']]), 'new-rules');
    assert.equal(next[0].extracted, 'new auto');
    assert.equal(summaryOf(next[0]), 'manual');
    assert.deepEqual(next[0].keywords, ['星钥', '12，12']);
    assert.equal(keywordTextOf(next[0]), '星钥, 12，12');
    assert.equal(next[0].keywordSource, 'manual');
    assert.equal(next[0].keywordSummaryHash, 'prior-summary');
});
test('关键词命中已满 K 时不调用向量接口', async () => {
    let calls = 0;
    const candidates = [record('a', 1, 'a', ['钥匙']), record('b', 2, 'b', ['钥匙']), record('c', 3, 'c', ['钥匙'])];
    const result = await retrieveMemories(candidates, '钥匙', config({ recallCount: 2 }), async () => { calls++; return []; });
    assert.equal(calls, 0);
    assert.deepEqual(result.hits.map(hit => hit.record.id), ['b', 'c']);
});
test('向量只接收未匹配楼层，补足 K 并按楼层顺序注入', async () => {
    const a = record('a', 1, 'old', ['旧事']);
    const b = record('b', 2, 'match', ['星钥']);
    const c = record('c', 3, 'semantic', ['北境']);
    const result = await retrieveMemories([a, b, c], '星钥', config({ recallCount: 2 }), async (remaining, text, count) => {
        assert.deepEqual(remaining.map(item => item.id), ['a', 'c']);
        assert.equal(count, 1); assert.equal(text, '星钥');
        return [{ record: a, score: .95 }, { record: b, score: 1 }, { record: c, score: .8 }];
    });
    assert.deepEqual(result.hits.map(hit => [hit.record.id, hit.reason]), [['a', 'vector'], ['b', 'keyword']]);
});
test('向量错误保留关键词召回；取消必须向上传播', async () => {
    const candidates = [record('a', 1, 'a', ['星钥']), record('b', 2, 'b', ['雪山'])];
    const result = await retrieveMemories(candidates, '星钥', config(), async () => { throw new Error('offline'); });
    assert.equal(result.hits.length, 1);
    assert.match(result.warning, /offline/);
    await assert.rejects(retrieveMemories(candidates, '星钥', config(), async () => { throw new DOMException('cancel', 'AbortError'); }), { name: 'AbortError' });
});
test('召回去重、拒绝未知 ID 和低阈值结果', async () => {
    const a = record('a', 1, 'a', []);
    const b = record('b', 2, 'b', []);
    const result = await retrieveMemories([a, b], 'unrelated', config(), async () => [
        { record: a, score: .9 }, { record: a, score: .8 }, { id: 'bad', score: 1 }, { record: b, score: .01 },
    ]);
    assert.deepEqual(result.hits.map(hit => hit.record.id), ['a']);
});
test('K=0 或查询为空不会调用向量；候选不足不会硬凑', async () => {
    const vector = () => { throw new Error('should not run'); };
    assert.equal((await retrieveMemories([record('a', 1, 'a')], 'a', config({ recallCount: 0 }), vector)).hits.length, 0);
    assert.equal((await retrieveMemories([record('a', 1, 'a')], '', config(), vector)).hits.length, 0);
});
test('只匹配手动中文关键词；英文有边界且不区分大小写', () => {
    const candidates = [record('a', 1, '获得了赤霄玄灵珠', ['赤霄玄灵珠'])];
    assert.equal(rankKeywords(candidates, '赤霄玄灵珠在哪', config()).length, 1);
    assert.equal(containsKeyword('annual meeting', 'Ann'), false);
    assert.equal(containsKeyword('Ask ANN.', 'ann'), true);
});
test('没有手动词时不匹配总结原文；旧补充词表不再参与匹配', () => {
    const candidates = [
        record('a', 1, '钥匙', ['信物']), record('b', 2, '钥匙'),
        record('c', 3, '钥匙', []), record('d', 4, '钥匙', [' ', '']),
    ];
    const cfg = config({ keywordDictionary: '钥匙' });
    assert.equal('keywordDictionary' in cfg, false);
    assert.deepEqual(rankKeywords(candidates, '钥匙', cfg), []);
});
test('关键词必须命中查询，配置了词不代表无条件召回', () => {
    const candidates = [record('a', 1, '总结可以不包含别名', ['钥匙别名'])];
    assert.equal(rankKeywords(candidates, '无关话题', config()).length, 0);
    assert.equal(rankKeywords(candidates, '想找钥匙别名', config()).length, 1);
});
test('空关键词楼层只进入向量候选，K 满额时无需向量请求', async () => {
    const manual = record('a', 1, '已设关键词', ['钥匙']);
    const empty = record('b', 2, '钥匙同样在这条总结里', []);
    let calls = 0;
    const vector = async candidates => {
        calls++;
        assert.deepEqual(candidates.map(item => item.id), ['b']);
        return [{ record: empty, score: .9 }];
    };
    const full = await retrieveMemories([manual, empty], '钥匙', config({ recallCount: 1 }), vector);
    assert.equal(calls, 0);
    assert.deepEqual(full.hits.map(hit => hit.reason), ['keyword']);
    const gap = await retrieveMemories([manual, empty], '钥匙', config({ recallCount: 2 }), vector);
    assert.equal(calls, 1);
    assert.deepEqual(gap.hits.map(hit => hit.reason), ['keyword', 'vector']);
});
test('所有关键词为空时可以只走向量，关闭向量时不召回', async () => {
    const candidates = [record('a', 1, '钥匙'), record('b', 2, '钥匙', [])];
    const result = await retrieveMemories(candidates, '钥匙', config(), async remaining => {
        assert.deepEqual(remaining, candidates);
        return [{ record: candidates[1], score: .8 }];
    });
    assert.deepEqual(result.hits.map(hit => hit.reason), ['vector']);
    const disabled = await retrieveMemories(candidates, '钥匙', config({ vectorEnabled: false }), () => {
        throw new Error('must not call');
    });
    assert.deepEqual(disabled.hits, []);
});
test('仅对手动命中词计分，去重大小写与全角变体', () => {
    const candidates = [
        record('a', 1, '', ['KEY', 'key', 'ＫＥＹ']),
        record('b', 2, '', ['key', '锁']),
    ];
    const hits = rankKeywords(candidates, 'key 和锁', config());
    assert.deepEqual(hits.map(hit => [hit.record.id, hit.score]), [['b', 2], ['a', 1]]);
});
test('提示词投影使用 index，不依赖被宿主正则修改的 mes', () => {
    const chat = conversation(2);
    const prompt = chat.map((message, index) => ({ ...message, index, mes: 'host formatted ' + index }));
    const projection = projectPrompt(prompt, chat);
    const cfg = config({ recentCount: 1, middleCount: 1 });
    const before = structuredClone(chat);
    const output = composePrompt(projection, partitionFloors(projection.floors, cfg), summaryRecords(projection.floors), [], cfg);
    assert.equal(output[0], prompt[0]);
    assert.match(output[1].mes, /summary 1/);
    assert.equal(output[2], prompt[2]);
    assert.equal(output[3], prompt[3]);
    assert.deepEqual(chat, before);
});
test('三段顺序、当前用户保留、不重复注入最近楼层', () => {
    const chat = conversation(6);
    chat.push({ name: 'User', is_user: true, mes: 'current question' });
    const prompt = chat.map((message, index) => ({ ...message, index }));
    const projection = projectPrompt(prompt, chat);
    const cfg = config({ recentCount: 2, middleCount: 2 });
    const recs = summaryRecords(projection.floors);
    const output = composePrompt(projection, partitionFloors(projection.floors, cfg), recs, [{ record: recs[0] }], cfg);
    assert.equal(output.length, 11);
    assert.equal(output[0], prompt[0]);
    assert.equal(output[1].mes.split('\n')[0], '[历史召回 · 第 1 楼]');
    assert.equal(output[2], prompt[4]);
    assert.equal(output[3].mes.split('\n')[0], '[近期召回 · 第 3 楼]');
    assert.equal(output[4], prompt[6]);
    assert.equal(output[5].mes.split('\n')[0], '[近期召回 · 第 4 楼]');
    assert.equal(output[6], prompt[8]);
    assert.equal(output.includes(prompt[2]), false);
    assert.equal(output.at(-1), prompt.at(-1));
    assert.equal(output.some(message => /summary 2/.test(message.mes)), false);
});
test('中间楼层缺总结可保留原文或只略过模型回复，始终保留用户', () => {
    const chat = conversation(1); chat[1].mes = 'no summary';
    const prompt = chat.map((message, index) => ({ ...message, index }));
    const projection = projectPrompt(prompt, chat);
    const cfg = config({ recentCount: 0, middleCount: 1 });
    const parts = partitionFloors(projection.floors, cfg);
    assert.deepEqual(composePrompt(projection, parts, [], [], cfg), prompt);
    assert.deepEqual(composePrompt(projection, parts, [], [], { ...cfg, missingSummary: 'omit' }), [prompt[0]]);
});
test('swipe 排除正在重生成的回复，前面的用户消息成为 pending', () => {
    const chat = conversation(3);
    const prompt = chat.slice(0, -1).map((message, index) => ({ ...message, index }));
    const projection = projectPrompt(prompt, chat, 'swipe');
    assert.equal(projection.floors.length, 2);
    assert.equal(projection.pending[0].message.mes, 'question 3');
});
test('隐藏消息不影响 index 映射，其他扩展删楼时拒绝不可靠投影', () => {
    const chat = conversation(2);
    chat.splice(1, 0, { is_system: true, mes: 'hidden' });
    const prompt = chat.filter(message => !message.is_system).map((message, index) => ({ ...message, index }));
    assert.equal(projectPrompt(prompt, chat).floors.length, 2);
    assert.throws(() => projectPrompt(prompt.slice(1), chat), /删改上下文/);
});
test('查询 D 按用户消息计数，包含区间内模型回复，D=0 保留当前待回复选项', () => {
    const chat = [...conversation(3), { is_user: true, mes: 'pending' }];
    const projection = buildFloors(chat);
    assert.deepEqual(queryInputs(projection, 1), ['pending']);
    assert.deepEqual(queryInputs(projection, 2), ['question 3', chat[5].mes, 'pending']);
    assert.deepEqual(queryInputs(projection, 0), ['pending']);
    assert.deepEqual(queryInputs(projection, 100), chat.map(message => message.mes));
});
test('多用户、多个模型和系统消息不改变查询的用户边界', () => {
    const chat = [
        { mes: '开场白' },
        { is_user: true, mes: '更早问题' }, { mes: '更早回复' },
        { is_user: true, mes: '目标起点' }, { mes: '角色一说 21' }, { mes: '角色二回复' },
        { is_system: true, extra: { tool_invocations: [] }, mes: '工具内容' },
        { is_user: true, mes: '补充问题' }, { is_user: true, mes: '最新问题' },
    ];
    const projection = buildFloors(chat);
    assert.deepEqual(queryInputs(projection, 2), ['补充问题', '最新问题']);
    assert.deepEqual(queryInputs(projection, 3), ['目标起点', '角色一说 21', '角色二回复', '补充问题', '最新问题']);
    assert.deepEqual(queryInputs(projection, 0), ['补充问题', '最新问题']);
});
test('没有待回复消息时查询仍止于最新用户；没有用户则无查询', () => {
    const chat = conversation(3);
    assert.deepEqual(queryInputs(buildFloors(chat), 2), ['question 2', chat[3].mes, 'question 3']);
    assert.deepEqual(queryInputs(buildFloors(chat), 0), []);
    assert.deepEqual(queryInputs(buildFloors([{ mes: 'intro' }]), 3), []);
});
test('模型正文中的关键词进入查询，thinking 与总结经过正则移除', () => {
    const projection = buildFloors([
        { is_user: true, mes: '前一问题' },
        { mes: '<thinking>隐藏词</thinking><content>线索 21 出现</content><summary>总结词</summary>' },
        { is_user: true, mes: '继续追问' },
    ]);
    const query = queryInputs(projection, 2).map(text => processText(text, config()).dialogue).join('\n');
    const hits = rankKeywords([
        record('a', 1, '旧总结', ['21']),
        record('b', 2, '旧总结', ['隐藏词', '总结词']),
    ], query, config());
    assert.deepEqual(hits.map(hit => hit.record.id), ['a']);
});
test('仅英文逗号分隔关键词，中文逗号和其他标点是词的一部分', () => {
    assert.deepEqual(splitKeywords(' 15,12 , 12，12,15,,a;b、c\nx'), ['15', '12', '12，12', 'a;b、c\nx']);
    const literal = record('a', 1, '总结', splitKeywords('12，12'));
    assert.equal(rankKeywords([literal], '只有 12', config()).length, 0);
    assert.equal(rankKeywords([literal], '12,12', config()).length, 0);
    assert.equal(rankKeywords([literal], '12，12', config()).length, 1);
    const multi = record('b', 2, '总结', splitKeywords('15,12'));
    assert.equal(rankKeywords([multi], '这是 15', config()).length, 1);
    assert.equal(rankKeywords([multi], '这是 12', config()).length, 1);
    assert.equal(rankKeywords([multi], '这是 215 或 112', config()).length, 0);
});
test('关键词原始文本保留标点与空格，旧数组仍按英文逗号显示', () => {
    assert.equal(keywordTextOf({ keywords: ['15', '12'] }), '15,12');
    assert.equal(keywordTextOf({ keywordText: '15, 12，12,', keywords: ['15', '12，12'] }), '15, 12，12,');
    assert.equal(keywordTextOf({ keywordText: '', keywords: ['old'] }), '');
});
test('内容指纹确定且能区分中文修改', () => {
    assert.equal(fingerprint('星钥'), fingerprint('星钥'));
    assert.notEqual(fingerprint('星钥'), fingerprint('星钥二'));
});

test('召回和中间总结都保留多条用户消息、附件以及原始对象顺序', () => {
    const chat = conversation(3);
    chat.splice(1, 0, { name: 'User', is_user: true, mes: 'recall followup', extra: { files: [{ url: 'original-file' }] } });
    chat.splice(4, 0, { name: 'User', is_user: true, mes: 'middle followup', extra: { media: [{ url: 'original-image' }] } });
    const unchanged = structuredClone(chat);
    const prompt = chat.map((message, index) => ({ ...structuredClone(message), index }));
    prompt[1].mes = 'host formatted recall followup';
    prompt[4].mes = 'host formatted middle followup';
    const projection = projectPrompt(prompt, chat);
    const cfg = config({ recentCount: 1, middleCount: 1, recallCount: 1 });
    const recs = summaryRecords(projection.floors);
    const output = composePrompt(projection, partitionFloors(projection.floors, cfg), recs, [{ record: recs[0] }], cfg);
    assert.equal(output[0], prompt[0]);
    assert.equal(output[1], prompt[1]);
    assert.equal(output[2].mes.split('\n')[0], '[历史召回 · 第 1 楼]');
    assert.equal(output[3], prompt[3]);
    assert.equal(output[4], prompt[4]);
    assert.equal(output[5].mes.split('\n')[0], '[近期召回 · 第 2 楼]');
    assert.equal(output[5].name, 'Bot');
    assert.equal(output[6], prompt[6]);
    assert.equal(output[7], prompt[7]);
    assert.deepEqual(chat, unchanged);
});
test('无前置用户的开场白仍可总结，不凭空生成用户消息', () => {
    const chat = [{ name: 'Guide', mes: '<summary>开场总结</summary>' }];
    const prompt = [{ ...chat[0], index: 0 }];
    const projection = projectPrompt(prompt, chat);
    const cfg = config({ recentCount: 0, middleCount: 1 });
    const output = composePrompt(projection, partitionFloors(projection.floors, cfg), summaryRecords(projection.floors), [], cfg);
    assert.equal(output.length, 1);
    assert.equal(output[0].mes, '[近期召回 · 第 1 楼]\n开场总结');
});

test('Tauri 工具调用与结果不独占楼层，近期原文完整保留，M 总结保留用户消息', () => {
    const chat = [
        { is_user: true, name: 'User', mes: '查青石镇', send_date: 1 },
        { is_user: false, name: 'Bot', mes: '', tool_calls: [{ id: 'call-1' }], send_date: 2 },
        { role: 'tool', is_user: false, is_system: true, name: 'search', tool_call_id: 'call-1', mes: '青石镇资料', send_date: 3 },
        { is_user: false, name: 'Bot', mes: '<summary>青石镇位于山脚</summary>', send_date: 4 },
        ...conversation(1),
        { is_user: true, name: 'User', mes: '下一步' },
    ];
    const cfg = config({ recentCount: 1, middleCount: 1, recallCount: 0 });
    const floors = buildFloors(chat).floors;
    assert.equal(floors.length, 2);
    assert.equal(floors[0].entries.length, 4);
    const prompt = chat.map((message, index) => ({ ...structuredClone(message), index }));
    const projection = projectPrompt(prompt, chat);
    const records = summaryRecords(floors, cfg);
    const output = composePrompt(projection, partitionFloors(floors, cfg), records, [], cfg);
    assert.deepEqual(output.map(item => item.mes), ['查青石镇', '[近期召回 · 第 1 楼]\n青石镇位于山脚', chat[4].mes, chat[5].mes, '下一步']);
    assert.equal(output.some(item => item.role === 'tool' || item.tool_calls), false);
    const keep = config({ recentCount: 2, middleCount: 0 });
    const unchanged = composePrompt(projection, partitionFloors(floors, keep), records, [], keep);
    assert.deepEqual(unchanged, prompt);
});

test('宿主剥离旧工具轮后仍使用原楼号与总结标识，当前未完成工具轮原样保留', () => {
    const chat = [
        { is_user: true, name: 'User', mes: 'search' },
        { name: 'Bot', mes: '', tool_calls: [{ id: 'x' }] },
        { role: 'tool', is_system: true, name: 'search', tool_call_id: 'x', mes: 'result' },
        { name: 'Bot', mes: '<summary>记忆</summary>' },
        { is_user: true, name: 'User', mes: 'again' },
        { name: 'Bot', mes: '', tool_calls: [{ id: 'y' }] },
        { role: 'tool', is_system: true, name: 'search', tool_call_id: 'y', mes: 'new result' },
    ];
    const source = [0, 3, 4, 5, 6];
    const prompt = source.map((index, offset) => ({ ...chat[index], index: offset }));
    const projection = projectPrompt(prompt, chat, 'normal', source);
    assert.equal(projection.floors[0].id, buildFloors(chat).floors[0].id);
    assert.equal(projection.pending.length, 3);
    const cfg = config({ recentCount: 0, middleCount: 1 });
    const output = composePrompt(projection, partitionFloors(projection.floors, cfg), summaryRecords(projection.floors, cfg), [], cfg);
    assert.equal(output[1].mes, '[近期召回 · 第 1 楼]\n记忆');
    assert.deepEqual(output.slice(-3), prompt.slice(-3));
});

test('工具执行途中追加的图片回复不会把调用和结果拆成两楼', () => {
    const chat = [
        { is_user: true, mes: '画图并搜索' },
        { mes: '', tool_calls: [{ id: 'image' }, { id: 'search' }] },
        { mes: '已生成图片', extra: { media: ['image.png'] } },
        { role: 'tool', is_system: true, tool_call_id: 'image', mes: 'image result' },
        { role: 'tool', is_system: true, tool_call_id: 'search', mes: 'search result' },
        { mes: '<summary>检索并画出青石镇</summary>' },
    ];
    const { floors, pending } = buildFloors(chat);
    assert.equal(floors.length, 1);
    assert.equal(floors[0].entries.length, 6);
    assert.equal(floors[0].assistantIndex, 5);
    assert.equal(pending.length, 0);
    assert.equal(buildFloors(chat.slice(0, 3)).floors.length, 0);
});
