import { MODULE_KEY } from './core.js';

/** World OS shell: retain live app pages, drafts, and the native mobile dialog contract. */
export function mountFloatingWindow(panel, { host, enabled, onEnabledChange, masterEnabled = true, onMasterChange = () => {} }) {
    const launcher = document.createElement('button');
    launcher.id = 'wo-launcher';
    launcher.type = 'button';
    launcher.className = 'wo-launcher';
    launcher.textContent = 'world os';
    launcher.setAttribute('aria-label', '打开 world os');
    launcher.title = 'world os（拖动调整位置）';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-controls', panel.id);
    launcher.setAttribute('aria-expanded', 'false');

    const compact = document.createElement('div');
    compact.id = 'world-os-settings';
    compact.className = 'floor-memory fm-compact';
    const label = document.createElement('label');
    label.className = 'checkbox_label';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'wo-enabled';
    label.append(toggle, document.createTextNode('启用 world os'));
    compact.append(label);
    host.append(compact);
    document.body.append(launcher, panel);

    // Stable Tauri layout ABI: the dialog receives surface-local IME insets.
    panel.dataset.ttMobileSurface = 'fullscreen-window';
    launcher.dataset.ttMobileSurface = 'free-window';

    const insideToggle = panel.querySelector('[name="enabled"]');
    insideToggle.id = 'fm-enabled';
    const masterToggle = panel.querySelector('#wo-master-enabled');
    const setWorldEnabled = value => {
        toggle.checked = masterToggle.checked = Boolean(value);
        panel.querySelector('#wo-master-status').textContent = value ? '已启用' : '已关闭：停止上下文注入、时间推进和自动状态更新。';
    };
    for (const input of [toggle, masterToggle]) input.addEventListener('change', () => {
        setWorldEnabled(input.checked); onMasterChange(input.checked);
    });
    setWorldEnabled(masterEnabled);
    const closeButton = panel.querySelector('#wo-window-close');
    const scroll = panel.querySelector('.wo-window-body');
    const setEnabled = value => {
        insideToggle.checked = Boolean(value);
        const state = value ? '已启用' : '已关闭';
        panel.querySelector('#fm-enabled-state').textContent = state;
        panel.querySelector('#wo-open-floor-memory').setAttribute('aria-label', '楼层记忆（' + state + '）');
    };
    for (const input of [insideToggle]) {
        input.addEventListener('change', () => {
            setEnabled(input.checked);
            onEnabledChange(input.checked);
        });
    }
    setEnabled(enabled);

    const pages = new Map([...panel.querySelectorAll('[data-wo-page]')].map(page => [page.dataset.woPage, page]));
    const appButtons = new Map([...panel.querySelectorAll('[data-wo-app]')].map(button => [button.dataset.woApp, button]));
    const back = panel.querySelector('#wo-back');
    const title = panel.querySelector('#wo-window-title');
    const positions = new Map();
    let currentPage = 'home';
    const rememberScroll = () => { if (panel.open) positions.set(currentPage, scroll.scrollTop); };
    const showPage = (name, focus = true) => {
        const target = pages.get(name);
        if (!target) return;
        rememberScroll();
        const previous = currentPage;
        currentPage = name;
        for (const [key, page] of pages) page.hidden = key !== name;
        panel.dataset.page = name;
        title.textContent = target.dataset.woTitle;
        back.hidden = name === 'home';
        panel.querySelector('#fm-enabled-state').hidden = name !== 'floor-memory';
        scroll.scrollTop = positions.get(name) ?? 0;
        panel.dispatchEvent(new CustomEvent('world-os:page', { detail: { name } }));
        if (focus && panel.open) {
            const control = name === 'home' ? appButtons.get(previous) ?? closeButton : back;
            control.focus({ preventScroll: true });
        }
    };
    panel.addEventListener('click', event => {
        const button = event.target.closest?.('[data-wo-app]'), name = button?.dataset.woApp;
        if (button && appButtons.get(name) === button) showPage(name);
    });
    back.addEventListener('click', () => showPage('home'));
    scroll.addEventListener('scroll', rememberScroll);
    showPage('home', false);

    let suppressClick = false;
    const close = () => { rememberScroll(); panel.close(); };
    const finishClose = () => {
        if (panel.open) return;
        launcher.setAttribute('aria-expanded', 'false');
        launcher.focus({ preventScroll: true });
    };
    panel.addEventListener('beforetoggle', event => {
        if (event.newState === 'closed') {
            rememberScroll();
            // Run after close() removes modality, without waiting for a rendering frame.
            // Older WebViews without beforetoggle still use the native close event below.
            queueMicrotask(finishClose);
        }
    });
    launcher.addEventListener('click', event => {
        if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
        suppressClick = false;
        if (panel.open) return;
        // The host back handler closes the last open dialog in DOM order.
        showPage('home', false);
        document.body.append(panel);
        panel.showModal();
        closeButton.focus({ preventScroll: true });
        scroll.scrollTop = positions.get('home') ?? 0;
        launcher.setAttribute('aria-expanded', 'true');
    });
    closeButton.addEventListener('click', close);
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') event.stopPropagation();
    });
    panel.addEventListener('close', finishClose);

    // Preserve the existing launcher storage key during the World OS rename.
    // Ratios keep the entrance reachable after rotating or resizing.
    const positionKey = MODULE_KEY + '.launcherPosition';
    let position = { x: 1, y: 0.72 };
    try {
        const saved = JSON.parse(localStorage.getItem(positionKey));
        if (saved && [saved.x, saved.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) position = saved;
    } catch { /* The launcher also works when local storage is unavailable. */ }
    let snapshot, drag;
    const bounds = () => {
        const viewport = globalThis.visualViewport;
        const frame = snapshot?.safeFrame ?? {
            left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
            width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
        };
        const left = frame.left + 8, top = frame.top + 8;
        return {
            left, top,
            right: Math.max(left, frame.left + frame.width - launcher.offsetWidth - 8),
            bottom: Math.max(top, frame.top + frame.height - (snapshot?.ime?.keyboardOffset ?? 0) - launcher.offsetHeight - 8),
        };
    };
    const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
    const place = (left, top) => {
        const area = bounds();
        const x = clamp(left, area.left, area.right), y = clamp(top, area.top, area.bottom);
        launcher.style.left = x + 'px';
        launcher.style.top = y + 'px';
        return { x: (x - area.left) / (area.right - area.left || 1), y: (y - area.top) / (area.bottom - area.top || 1) };
    };
    const refreshLayout = () => {
        panel.style.setProperty('--wo-viewport-height', (globalThis.visualViewport?.height ?? innerHeight) + 'px');
        const area = bounds();
        place(area.left + position.x * (area.right - area.left), area.top + position.y * (area.bottom - area.top));
    };
    launcher.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        const rect = launcher.getBoundingClientRect();
        suppressClick = false;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        launcher.setPointerCapture(event.pointerId);
    });
    launcher.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        position = place(drag.left + dx, drag.top + dy);
    });
    const finishDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        suppressClick = drag.moved && event.type === 'pointerup';
        if (drag.moved) {
            try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Session placement is still retained. */ }
        }
        drag = undefined;
        if (launcher.hasPointerCapture(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
    };
    launcher.addEventListener('pointerup', finishDrag);
    launcher.addEventListener('pointercancel', finishDrag);
    launcher.addEventListener('lostpointercapture', () => { drag = undefined; });
    globalThis.addEventListener('resize', refreshLayout);
    globalThis.visualViewport?.addEventListener('resize', refreshLayout);
    globalThis.visualViewport?.addEventListener('scroll', refreshLayout);
    try {
        const layout = globalThis.__TAURITAVERN__?.api?.layout;
        if (layout) Promise.resolve(layout.subscribe(value => { snapshot = value; refreshLayout(); }))
            .catch(error => console.warn('[world os] Layout subscription:', error.message));
    } catch (error) { console.warn('[world os] Layout subscription:', error.message); }
    refreshLayout();
    return { setEnabled, setWorldEnabled, showApp(name) { showPage(name,false); }, openApp(name) { if (!panel.open) launcher.click(); showPage(name); },
        registerApp(name, { button, page }) {
            if (!name.startsWith('lab:') || pages.has(name)) throw new Error('应用入口重复或名称无效。');
            button.dataset.woApp = name; page.dataset.woPage = name; pages.set(name,page); appButtons.set(name,button);
        },
        unregisterApp(name) {
            if (!name.startsWith('lab:')) return;
            if (currentPage === name) showPage('home');
            pages.delete(name); appButtons.delete(name); positions.delete(name);
        },
    };
}
