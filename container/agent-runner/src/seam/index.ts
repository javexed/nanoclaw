// The fork's hook seam, container side. Installed modules import from HERE —
// never from the upstream files the hooks are called from — so the seam's
// internal layout can change without touching a module.
export * from '../providers/hooks.js';
export * from '../runner-hooks.js';
export * from './prompt-sections.js';
