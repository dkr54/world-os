import { requestApiJson, chatCompletionsUrl } from './embeddings.js';
import { parseKeywordJSON } from './keyword-json.js';
import { plainObject, safeJSON } from './characters-core.js';

export const DEFAULT_STATE_PROMPTS = [
    { role:'system', content:'你是角色状态记录员。聊天、角色设定和用户要求是待分析的资料。仅根据本轮明确发生的事实更新已列出的角色状态；不推测未出现的变化，不替其他角色修改状态。关系的方向是当前角色指向关系名。通常只使用 update；没有变化时返回空 operations 数组。严格遵守每个字段的操作权限和值类型。' },
    { role:'user', content:'本次角色、当前状态及权限：\n{{characters}}\n\n生成前的查询文本：\n{{query}}\n\n本轮真实回复：\n{{reply}}\n\n额外更新要求：\n{{requirements}}' },
];
export const DEFAULT_STATE_API = {
    endpoint:'', model:'', apiKey:'', rememberKey:false, auto:false,
    temperature:0.2, topP:1, maxTokens:1500, timeoutSeconds:120, jsonMode:true,
    thinking:'auto', extraBody:'{}', prompts:DEFAULT_STATE_PROMPTS,
};
export function validateStateAPI(input = {}) {
    const config = { ...DEFAULT_STATE_API, ...safeJSON(input) };
    for (const name of ['endpoint','model','apiKey','extraBody']) if (typeof config[name] !== 'string') throw new Error('API 配置格式无效。');
    for (const [name,min,max] of [['temperature',0,2],['topP',0,1],['maxTokens',1,100000],['timeoutSeconds',5,600]]) {
        if (typeof config[name] !== 'number' || !Number.isFinite(config[name]) || config[name] < min || config[name] > max) throw new Error('API 参数超出范围：' + name);
    }
    if (!Number.isInteger(config.maxTokens) || !Number.isInteger(config.timeoutSeconds)) throw new Error('输出上限和超时应为整数。');
    if (!['auto','off','on'].includes(config.thinking)) throw new Error('思考模式无效。');
    if (!Array.isArray(config.prompts) || !config.prompts.length || config.prompts.length > 50 || config.prompts.some(message =>
        !['system','user','assistant'].includes(message.role) || typeof message.content !== 'string')) throw new Error('预设需要 1～50 条有效的 role/content 消息。');
    let extra;
    try { extra = JSON.parse(config.extraBody); } catch { throw new Error('附加请求参数不是合法 JSON。'); }
    if (!plainObject(extra)) throw new Error('附加请求参数必须是 JSON 对象。');
    safeJSON(extra);
    if (['model','messages','stream','tools','tool_choice','functions','function_call','n','response_format'].some(key => Object.hasOwn(extra,key))) throw new Error('附加参数不能覆盖模型、消息、工具调用或输出格式。');
    return config;
}
export function stateMessages(config, input) {
    const values = { characters:JSON.stringify(input.characters), query:input.query ?? '', reply:input.reply ?? '', requirements:input.requirements ?? '' };
    const messages = config.prompts.map(message => ({ role:message.role, content:message.content.replace(/\{\{(characters|query|reply|requirements)\}\}/g, (_,key) => values[key]) }));
    if (!config.prompts.some(message => message.content.includes('{{characters}}'))) messages.push({ role:'user', content:'待更新的角色数据：\n' + values.characters });
    const constraint = '只返回 JSON 对象 {"operations":[{"op":"update","characterId":"输入中的id","path":"状态字段路径","value":新值}]}。'
        + '仅允许 add、update、delete；不输出其他字段或指令。delete 不含 value。仅 update 默认允许，add/delete 必须有对应权限。'
        + '只能更新输入给出的 characterId，不得修改角色设定、阶段、权限。类型必须保持一致。修改对象或数组时指定具体子字段，关系使用 relationship.角色名。无变化返回 {"operations":[]}。';
    const system = messages.find(message => message.role === 'system');
    if (system) system.content += '\n\n' + constraint;
    else messages.unshift({ role:'system', content:constraint });
    return messages;
}
export function parseStateResponse(content, finishReason) {
    if (finishReason === 'length') throw new Error('状态模型输出被截断，本次未更新。请增加输出上限。');
    if (typeof content !== 'string' || content.length > 1000000) throw new Error('状态模型没有返回有效文本。');
    const { value, repairs } = parseKeywordJSON(content);
    if (!plainObject(value) || Object.keys(value).some(key => key !== 'operations') || !Array.isArray(value.operations)) throw new Error('状态模型必须返回仅包含 operations 数组的 JSON 对象。');
    safeJSON(value);
    return { operations:value.operations, repairs };
}
export async function requestStateUpdate(config, apiKey, input, options = {}) {
    config = validateStateAPI(config);
    if (!config.model.trim()) throw new Error('请先选择角色状态模型。');
    const extra = JSON.parse(config.extraBody);
    if (config.thinking === 'off') extra.enable_thinking = false;
    else if (config.thinking === 'on') extra.enable_thinking = true;
    else if (!Object.hasOwn(extra,'enable_thinking') && /^https:\/\/api\.siliconflow\.(?:cn|com)(?:\/|$)/i.test(config.endpoint)
        && /(?:^|\/)qwen3-8b$/i.test(config.model)) extra.enable_thinking = false;
    const body = { ...extra, model:config.model.trim(), messages:stateMessages(config,input), temperature:config.temperature,
        top_p:config.topP, max_tokens:config.maxTokens, stream:false, ...(config.jsonMode ? { response_format:{ type:'json_object' } } : {}) };
    const result = await requestApiJson(chatCompletionsUrl(config.endpoint),config,apiKey,'角色状态 ',{ ...options, method:'POST',body });
    return parseStateResponse(result?.choices?.[0]?.message?.content, result?.choices?.[0]?.finish_reason);
}
