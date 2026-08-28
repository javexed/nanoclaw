// ── DOM leaves ───────────────────────────────────────────────────────────────
// The helpers everything else calls and which call nothing back. Extracting
// these first keeps every later module a one-way dependency on core/, so the
// split never has to reason about import cycles.

/** querySelector, the shorthand the whole UI is written in. */
// Defaults to HTMLElement, not Element. Every caller in this codebase is
// reaching for .hidden / .dataset / .value / .style — properties Element does
// not have — so an Element default made the common case wrong and forced a type
// argument at hundreds of call sites. Pass one explicitly for SVG or generic
// Element cases.
export const $ = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

/** Inline Lucide icon referencing the SVG sprite in index.html. Returns an HTML
 * string (safe — no user data); styling/color come from the .icon CSS class. */
export function lucide(name: string, cls = ''): string {
  return `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** Same icon as a detached DOM node, for inserting NEXT TO user-controlled text
 * without resorting to innerHTML (keeps the surrounding text XSS-safe). */
export function lucideEl(name: string, cls = ''): ChildNode {
  const t = document.createElement('template');
  t.innerHTML = lucide(name, cls);
  // Never null. firstChild is only null if lucide() produced empty markup —
  // an unknown icon name — and every caller immediately appendChild()s the
  // result, where null throws TypeError. Degrading to an empty text node makes
  // a bad icon name render nothing instead of aborting the surrounding render,
  // and it removes a null-check from every single call site.
  return t.content.firstChild ?? document.createTextNode('');
}

/** HTML-escape for the few places that still build markup as a string.
 * `'` is escaped too: every current attribute interpolation is double-quoted,
 * but nothing enforces that, and a future single-quoted attribute built with
 * esc() would otherwise be a breakout. Cheap insurance, not a fix for a bug. */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// CSS.escape with a fallback — belongs with the DOM helpers rather than being
// injected into every module that builds an attribute selector.
export function cssEscape(s: string): string {
  if (window.CSS && CSS.escape) return CSS.escape(String(s));
  return String(s).replace(/["\\\]]/g, '\\$&');
}
