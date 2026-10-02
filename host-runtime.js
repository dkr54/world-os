/** TauriTavern host integration; no Rust commands or Node backend are required. */
export function isTauriTavern(runtime = globalThis) {
    return Boolean(runtime.__TAURITAVERN__ || runtime.__TAURI_RUNNING__ || runtime.__TAURITAVERN_MAIN_READY__);
}

export function runtimeLabel(runtime = globalThis) {
    if (!isTauriTavern(runtime)) return 'SillyTavern';
    return /android/i.test(runtime.navigator?.userAgent ?? '') ? 'TauriTavern · Android' : 'TauriTavern';
}

/** Early mobile boot may expose only the marker; wait for the actual ready promise. */
export async function waitForHostReady(runtime = globalThis, { timeoutMs = 15000 } = {}) {
    const start = Date.now();
    const wait = () => new Promise(resolve => setTimeout(resolve, 25));
    while (isTauriTavern(runtime) && !(runtime.__TAURITAVERN__?.ready ?? runtime.__TAURITAVERN_MAIN_READY__)) {
        if (Date.now() - start >= timeoutMs) throw new Error('TauriTavern 尚未就绪，请重新启动应用。');
        await wait();
    }
    const ready = runtime.__TAURITAVERN__?.ready ?? runtime.__TAURITAVERN_MAIN_READY__;
    if (ready) {
        let timer;
        try {
            await Promise.race([ready, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('TauriTavern 启动超时，请重新启动应用。')), timeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }
    while (typeof runtime.SillyTavern?.getContext !== 'function') {
        if (Date.now() - start >= timeoutMs) throw new Error('未找到聊天扩展接口，请重新加载宿主。');
        await wait();
    }
}

const importHostModule = path => import(path);

/** Use the same public frontend projection as TauriTavern 2.3.0, including stripped tools. */
export async function tauriPromptSource(chat, type, ctx, {
    runtime = globalThis, loadModule = importHostModule, promptLength,
} = {}) {
    if (!isTauriTavern(runtime)) return undefined;
    let messages = chat.filter(message => !message.is_system
        || (ctx.mainApi === 'openai' && (message.role === 'tool' || Object.hasOwn(message.extra ?? {}, 'tool_invocations'))));
    if (type === 'swipe') messages.pop();
    // Live Agent handoff can retain tools even when legacy strip-old-tools is enabled.
    if (messages.length !== promptLength && ctx.mainApi === 'openai' && ctx.chatCompletionSettings?.function_calling
        && ctx.chatCompletionSettings?.strip_old_tool_calls) {
        const { stripOldToolTurns } = await loadModule('/scripts/tauritavern/tool-turn-projection.js');
        if (typeof stripOldToolTurns !== 'function') throw new Error('宿主缺少工具消息投影接口，请更新 TauriTavern 至 2.3.0 或更高版本。');
        messages = stripOldToolTurns(messages);
    }
    const indices = new Map(chat.map((message, index) => [message, index]));
    return messages.map(message => {
        const index = indices.get(message);
        if (index === undefined) throw new Error('无法对应 TauriTavern 的工具消息投影。');
        return index;
    });
}

/** Await native Android saving, so a failed picker/write is not reported as successful. */
export async function downloadMemory(data, fileName, {
    runtime = globalThis, loadModule = importHostModule,
} = {}) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    if (isTauriTavern(runtime)) {
        const { downloadBlobWithRuntime } = await loadModule('/scripts/file-export.js');
        if (typeof downloadBlobWithRuntime !== 'function') throw new Error('宿主缺少文件导出接口，请更新 TauriTavern 至 2.3.0 或更高版本。');
        return await downloadBlobWithRuntime(blob, fileName);
    }
    const url = runtime.URL.createObjectURL(blob);
    const anchor = runtime.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => runtime.URL.revokeObjectURL(url), 1000);
    return { mode: 'browser', savedPath: '' };
}

export function apiNetworkError(url, runtime = globalThis) {
    if (!isTauriTavern(runtime)) return '无法访问接口，请检查网络、跨域 CORS 和 HTTPS/HTTP 限制。';
    let local = false;
    try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch {}
    return 'TauriTavern 无法访问接口，请检查当前设备的网络、接口的 CORS 跨域许可和 HTTPS/HTTP 限制。'
        + (local ? '手机版中的 localhost/127.0.0.1 指手机自身；电脑上的接口请填写电脑的局域网地址。' : '');
}
