export const WORLD_KEY = 'world_os';
export const WORLD_EVENT = 'world-os:settings';
export function worldEnabled(ctx) { return ctx.extensionSettings?.[WORLD_KEY]?.enabled !== false; }
export function announceWorldChange(kind = 'settings') { document.dispatchEvent(new CustomEvent(WORLD_EVENT, { detail:{ kind } })); }
