# Webchat design language

The webchat PWA (`index.html`, `app.js`, `style.css`) is partly built and
extended by Claude agents working from this repo. The design language is only
as consistent as what's written down for them to read — this file is that
source of truth. When you add or change UI, conform to the contracts below.

There is **one enforced token layer**: colors. Radius, type, and motion tokens
were added later (see `style.css` `:root`) and existing code still uses literal
values — so this doc also records the **migration target** and the
old → new mapping. New code MUST use the tokens; touched code SHOULD be migrated.

---

## 1. Tokens

All tokens are CSS custom properties on `:root` (and the theme blocks for
colors). Never hardcode a value a token already covers.

### Color (theme-aware — defined per theme in `style.css`)

| Token | Role |
|-------|------|
| `--bg`, `--surface`, `--surface2` | page / panel / inset backgrounds |
| `--text`, `--text-dim` | primary / secondary text |
| `--border` | hairlines, dividers, input borders |
| `--accent`, `--accent-strong` | primary brand / interactive; `-strong` = foreground on a tint |
| `--accent2`, `--agent` | secondary brand + the agent's identity color (NOT status colors) |
| `--danger`, `--delete-color`, `--delete-strong` | destructive actions |
| `--success`, `--success-strong` | success / "on" / connected status |
| `--warning`, `--warning-strong` | caution / pending / degraded status |
| `--shadow` | box-shadow color |

`--success` / `--warning` exist specifically so status colors stop being
hardcoded. Before this layer, call sites used `#2ea043` (green) and `#ffd54f`
(amber) directly — both are light-theme landmines and a second green/amber that
won't match the brand. Route all status color through these tokens. Use the
`-strong` variant when the color is **text on a tinted background** (matches the
existing `--accent-strong` convention for AA contrast).

Do **not** repurpose `--accent2`/`--agent` for status — `--agent` is the
assistant's identity hue and carries meaning elsewhere.

### Radius — `--radius-sm|md|lg|pill`

`4px` / `8px` / `12px` / `999px`. The codebase had ~15 distinct radii
(2/3/4/6/7/8/9/12/14/16px…) that are visually indistinguishable. Collapse:

| Old literal | Token |
|-------------|-------|
| `2px`, `3px`, `4px` | `--radius-sm` |
| `6px`, `7px`, `8px`, `9px` | `--radius-md` |
| `10px`, `12px`, `14px`, `16px` | `--radius-lg` |
| `999px` | `--radius-pill` |
| `50%` | keep inline (circular avatars/dots — geometry, not a token) |

### Type — `--fs-xs|sm|base|lg|xl`

Defined in **rem**, rooted at the `[data-font]` base. The Small/Medium/Large
setting now sets `font-size` on the **root** element (the `data-font` attribute
lives on `<html>`), so the scale is the rem base and reaches every rem-sized
element — not just `em`/inherited text. This fixed a real bug: of ~195
`font-size` declarations, ~159 were fixed `px` and silently ignored the setting.
All px font-sizes have been converted to rem at the 15px medium base
(`N/15`), so the conversion preserved current sizes — Medium renders
pixel-identical; Small/Large now scale the whole UI.

`rem` is **nesting-independent** — unlike `em` it never compounds, so font-size
tokens can be used anywhere without reasoning about ancestors.

| Token | ~px @15 base | Use |
|-------|--------------|-----|
| `--fs-xs` | 11 | meta, hints, badges, timestamps |
| `--fs-sm` | 13 | secondary text, form labels, buttons |
| `--fs-base` | 15 | body text, messages |
| `--fs-lg` | 18 | section / panel titles |
| `--fs-xl` | 21 | view headings |

The px→rem conversion **preserved exact sizes** (faithful `N/15rem`); it did not
snap to the scale above. Consolidating the long tail of one-off sizes onto these
five tokens is a separate, deliberate visual pass — when you do it, this is the
mapping:

| Old literal | Token |
|-------------|-------|
| `9–11px` (`≤0.733rem`) | `--fs-xs` |
| `11.5–13px` (`~0.8–0.867rem`) | `--fs-sm` |
| `14–15px` (`~0.933–1rem`) | `--fs-base` |
| `16–18px` (`~1.067–1.2rem`) | `--fs-lg` |
| `20px+` (`≥1.333rem`) | `--fs-xl` |

The 32 existing `em` font-sizes were left as-is — they already scale via
inheritance (they resolve against `#app`, which inherits the scaling root).
`#app` still carries a narrower base inside the mobile `@media` block for
density; that only affects `em`/inherited text, not the rem base.

### Motion — `--transition`

`0.15s ease`. One standard duration (it already dominates). Property-specific
transitions are fine (`transition: background var(--transition)`); reach for a
different duration only with intent (e.g. the drawer slide).

---

## 2. Buttons — four roles

Text buttons use a `.btn` base plus one role modifier. Built and in use:

| Role | Class | What it was | When |
|------|-------|-------------|------|
| Primary | `.btn .btn-primary` | `btn-save` (×11) | the main commit action of a form/dialog (Save, Create, Connect). Has `flex: 1` — it fills its action row, matching every form's layout. |
| Secondary | `.btn .btn-secondary` | `create-agent-btn` (×12) | secondary actions (Probe, Browse, + New …) |
| Ghost | `.btn .btn-ghost` | `dash-refresh-btn`, `drafter-btn` | low-emphasis (refresh, suggest-from-prompt) |
| Danger | `.btn .btn-danger` | `btn-delete` (×4 + confirm modal) | destructive actions |

Filled-surface text colors route through `--on-accent` (primary) and
`--on-danger` (danger hover), not hardcoded `#000`/`#fff`.

**Layout modifiers** (no color — combine with a role): `.btn-list-footer`
(`margin` + `flex-shrink: 0`) for a "+ New …" button pinned at the bottom of a
scrolling list.

One severity → one weight. **All** delete buttons (agent/room/model/user) and
the confirm-modal destructive button share `.btn-danger` — keep that uniformity;
don't reintroduce a "quiet" delete variant.

**Not part of this set** (bespoke components — leave as-is): the icon buttons
`.lightbox-btn` (circular media-overlay), `.settings-btn`, `.file-picker-btn`;
the `.agent-status-btn` segmented toggle; and `.btn-cancel` (the confirm-modal
cancel). `.drafter-btn` is retained only as a JS hook + layout — its visual role
is `.btn-ghost`.

---

## 3. Dismissal contract

Every dismissable surface should answer "how do I make this go away" the same
way. Target: a shared helper `dismissable(el, { onClose })` that wires all three:

- **Escape** closes the topmost surface.
- **Backdrop tap** closes it (desktop too, not mobile-only).
- **History entry** (`pushState` + `popstate`) so the OS/Android back gesture
  closes it instead of leaving the PWA.

Current state to converge: ESC already closes settings, lightbox, confirm modal,
model picker, mention popup, overflow menu; full-views use a `viewStack` +
`popstate`. The gap is the **detail asides + members panel on desktop** (× only,
no ESC / no backdrop). Wire them through the same helper.

---

## 4. Feedback channels — three, with a rule

| Channel | API | Fires for |
|---------|-----|-----------|
| Transcript bubble | `appendSystem()` (×18) | **conversation-domain events only** — agent joined, file shared, an in-room approval |
| Toast | `showToast()` (×72) | **operation outcomes** — saved, copied, failed, status changed |
| Inline text | (login, perms) | **field validation** — bad token, missing name |

Rule of thumb: if it isn't part of the *conversation*, it does not belong in the
transcript. Notably, Web Push setup currently narrates `Push: fetching VAPID
key…`, `Push: subscribing…`, etc. via `appendSystem` into whatever room you're
in — that's operational telemetry in your message history. Move multi-step
operational status to toasts or the settings panel.

No native `confirm()` / `alert()` — use `showConfirmModal()` (already universal
at all 8 destructive sites).

---

## 5. Microcopy

- **Sentence case everywhere** — headings included ("Agent details", not "Agent
  Details").
- **Ellipsis = the `…` character**, never three dots (`...`).
- **Verb discipline:** *wire* / *unwire* is the verb for linking a **room and an
  agent** (distinctive, and matches the docs/matrix). *assign* is the verb for
  the separate **model → agent** relationship (matches `/api/agents/:id/model`)
  — don't "wire" a model. Reserve *add* / *new* for **creation**. (So:
  "Wire agent", "Wire selected", but "Assigned to N agents" for a model, and
  "+ New agent" to create one.)
- **Empty states:** one sentence, sentence case, no trailing period
  (e.g. "No unwired agents — switch to New to create one").

---

## 6. Lists & navigation

The sidebar is the canonical list surface — flat room rows plus the nested
thread tree under the active room. These rules keep any list (rooms, threads,
agents, models) reading the same.

**Row anatomy.** A row is a flex line: an optional leading glyph/identity mark, a
`flex: 1` label that truncates with ellipsis (`overflow:hidden;
text-overflow:ellipsis; white-space:nowrap`), then trailing markers (unread dot /
mention badge / kebab). The kebab is **hover/focus-revealed** (`opacity: 0` →
`1` on `:hover, :focus-within`), never always-on.

**Three row states — three distinct treatments.** They must never collapse into
each other (the bug the thread tree had: active and hover were both plain
`--surface2`, indistinguishable, and active also matched the active *room*):

| State | Treatment |
|-------|-----------|
| Hover | `background: var(--surface2)` (+ brighten text to `--text`) |
| Active / selected | accent — `background: color-mix(in srgb, var(--accent) 12%, transparent)` + `color: var(--accent-strong)` + an accent left bar. **Never** reuse the hover background for active. |
| Unread | a 7–8px `--accent` dot (`--radius-pill`), trailing. A mention escalates to the warning-colored `@` badge (higher signal). |

**Identity vs selection color.** A room carries its **own hue** on the row's
left border (`roomColor`) — that's identity and is independent of selection. The
accent bar/tint above signals *selected*. Don't conflate the two.

**Nesting via a per-row spine.** A nested list (the thread tree) drops onto its
**own full-width line** beneath its parent row — `#room-list li:has(.thread-list)
{ flex-wrap: wrap }` + `.thread-list { flex-basis: 100% }` — then indents with a
left margin. Draw the tree spine as **each child row's `border-left`**, not a
container border: that way the active child's accent bar simply recolors the
spine segment with no layout shift, and the "+ New …" footer aligns by carrying a
transparent spine slot (`border-left: 2px solid transparent`).

**Glyphs.** List-row glyphs (`#` topic, `@` agent) live in their own
fixed-width span tinted `--text-dim`, brightening on hover/active — a quiet
prefix, `aria-hidden`, kept **out of the label string** (so truncation and
styling are independent).

**Create affordance.** The "+ New …" row sits at the end of the list, aligned
with the rows, `--text-dim` → `--accent` on hover. Microcopy follows §5: reserve
*new* for creation ("+ New agent", "+ New model"). The **thread** list is the
exception: it uses a bare inline "+" button placed on the room row (or the last
thread row), not a footer "+ New thread" row.

## 7. Enforcing this

Once code is migrated onto the tokens, add a stylelint
`declaration-property-value-allowed-list` for `border-radius`, `font-size`, and
`transition-duration` so literal values fail CI instead of accumulating. Until
the migration lands, the rule would be all-red — introduce it *after*, not
before. Keep this doc in sync when the contract changes; agents read it as the
spec.
