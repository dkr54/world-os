import { MODULE_KEY } from './core.js';

/** Keep one live form in a native dialog, preserving drafts and host back navigation. */
export function mountFloatingWindow(panel, { host, enabled, onEnabledChange }) {
    const launcher = document.createElement('button');
    launcher.id = 'fm-launcher';
    launcher.type = 'button';
    launcher.className = 'fm-launcher';
    launcher.textContent = '楼层记忆';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-controls', panel.id);
    launcher.setAttribute('aria-expanded', 'false');

    const compact = document.createElement('div');
    compact.id = 'floor-memory-settings';
    compact.className = 'floor-memory fm-compact';
    const label = document.createElement('label');
    label.className = 'checkbox_label';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'fm-enabled';
    label.append(toggle, document.createTextNode('启用楼层记忆'));
    compact.append(label);
    host.append(compact);
    document.body.append(launcher, panel);

    // Stable Tauri layout ABI: the dialog receives surface-local IME insets.
    panel.dataset.ttMobileSurface = 'fullscreen-window';
    launcher.dataset.ttMobileSurface = 'free-window';

    const insideToggle = panel.querySelector('[name="enabled"]');
    const closeButton = panel.querySelector('#fm-window-close');
    const scroll = panel.querySelector('.fm-window-body');
    const setEnabled = value => {
        toggle.checked = insideToggle.checked = Boolean(value);
        const state = value ? '已启用' : '已关闭';
        panel.querySelector('#fm-enabled-state').textContent = state;
        launcher.dataset.enabled = String(Boolean(value));
        launcher.setAttribute('aria-label', '打开楼层记忆（' + state + '）');
        launcher.title = '楼层记忆 · ' + state + '（拖动调整位置）';
    };
    for (const input of [toggle, insideToggle]) {
        input.addEventListener('change', () => {
            setEnabled(input.checked);
            onEnabledChange(input.checked);
        });
    }
    setEnabled(enabled);

    let suppressClick = false;
    let savedScrollTop = 0;
    scroll.addEventListener('scroll', () => { if (panel.open) savedScrollTop = scroll.scrollTop; });
    const close = () => { savedScrollTop = scroll.scrollTop; panel.close(); };
    panel.addEventListener('beforetoggle', event => {
        if (event.newState === 'closed') savedScrollTop = scroll.scrollTop;
    });
    launcher.addEventListener('click', event => {
        if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
        suppressClick = false;
        if (panel.open) return;
        // The host back handler closes the last open dialog in DOM order.
        document.body.append(panel);
        panel.showModal();
        closeButton.focus({ preventScroll: true });
        scroll.scrollTop = savedScrollTop;
        launcher.setAttribute('aria-expanded', 'true');
    });
    closeButton.addEventListener('click', close);
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') event.stopPropagation();
    });
    panel.addEventListener('close', () => {
        if (panel.open) return;
        launcher.setAttribute('aria-expanded', 'false');
        launcher.focus({ preventScroll: true });
    });

    // Store ratios, so rotating/resizing cannot strand the entrance off screen.
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
        panel.style.setProperty('--fm-viewport-height', (globalThis.visualViewport?.height ?? innerHeight) + 'px');
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
            .catch(error => console.warn('[Floor Memory] Layout subscription:', error.message));
    } catch (error) { console.warn('[Floor Memory] Layout subscription:', error.message); }
    refreshLayout();
    return { setEnabled };
}
