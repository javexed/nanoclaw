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

## 2b. Controls — pick by data shape

Never reach for a bare checkbox or a bespoke widget. Match the control to the
data:

- **Binary on/off** → a **toggle switch** (`.setting-toggle`) or a **segmented
  Off/On** (`.setting-options`). Use the segmented Off/On when the setting sits
  in a column of other segmented controls (visual consistency — e.g. the
  Features column); use the switch for a standalone inline setting. **Never a
  raw `<input type="checkbox">` on its own** — it reads as a form field, not a
  setting.
- **One of a few (2–4) mutually-exclusive options** → a **segmented control**
  (`.setting-options`) or a **radio group** (`.setting-radios`). Not a dropdown
  for small N, not checkboxes.
- **One of many (long/dynamic list)** → a `<select>` dropdown (e.g. the model
  pickers).
- **Several independent flags at once** → the only place a checkbox *list* is
  right; even then prefer a short stack of toggles if there are only a few.

The default for a settings surface is a switch or a segmented Off/On. If you're
about to write `type="checkbox"`, stop and use one of the above.

## 3. Surfaces, cards & icons

### Surface cards

The standard way to group a block of content is a **surface card**:

```css
background: var(--surface2);
border: 1px solid var(--border);
border-radius: var(--radius-md);   /* 8px */
padding: 14px 16px;                /* tighter for dense rows */
```

This is the app's primary container language — agent/model rows, wired-agent
rows, the Help topics. A content view should read as a **left-aligned stack of
these cards on the app's surfaces**, not as a centred column of prose. (Cautionary
example: the Help page first shipped as a centred `60ch` column of tiny dim
`--fs-xs` text — it read like a pasted-in document. Re-casting each topic as a
surface card made it feel native.)

### Card header — icon + title

A card's header is a flex row (`align-items: center; gap: 8px`): a small icon
(~18px, `color: var(--accent)`, `flex-shrink: 0`) followed by a title at
`--fs-base` / `font-weight: 600` / `var(--text)`. The accent icon ties each card
into the app's iconography.

### Icons — one sprite, `<use>` everywhere

Icons are inline SVG sprites. Each is a `<symbol id="i-name" viewBox="0 0 24 24">`
in the single `<svg>` block at the top of `index.html`, rendered with
`<svg class="icon" aria-hidden="true"><use href="#i-name"></use></svg>`. They're
Lucide-style 24px **stroke** icons that inherit `currentColor`. **Define once,
`<use>` everywhere** — never paste a raw `<svg>` per call site. To add one, add a
new `<symbol>` to that block; reuse existing ids where they map (`i-bot` = agent,
`i-cpu` = model, `i-pin` = pin, `i-key` = credentials, `i-user` = person/room,
`i-layout-dashboard` = wiring/topology, `i-help`, …).

### Body vs hint type (reinforces §1 Type)

`--fs-base` + `var(--text)` is for **readable body content** — anything someone
sits and reads (messages, card/Help body). The `--fs-xs` + `var(--text-dim)`
pairing (the `.setting-help` / `.setting-label` styles) is for **terse hints and
labels only** — a one-line field hint, an uppercased group label. Don't set
paragraphs in `--fs-xs`; it reads as fine print. Secondary body copy is
`var(--text-dim)` at `--fs-base`, never `--fs-xs`.

---

## 4. Dismissal contract

Every dismissable surface should answer "how do I make this go away" the same
way. Target: a shared helper `dismissable(el, { onClose })` that wires all three:

- **Escape** closes the topmost surface — exactly one layer per press.
- **Backdrop tap** closes it (desktop too, not mobile-only).
- **History entry** (`pushState` + `popstate`) so the OS/Android back gesture
  closes it instead of leaving the PWA.

**Full-screen views** (dashboard, topology, wiring, agents, models, permissions)
are tracked in a `viewStack` and each pushes a history entry, so the Back button,
the OS back gesture, **and Escape** all close them. The ESC handler for these runs
in the **capture phase** and yields (`blockingOverlayOpen()`) when a modal /
popover / menu is open, so that higher layer's own ESC handler takes the keypress
first — one Escape, one layer. Any new full-screen view must register through
`openView(name, teardown)` to inherit all three dismissals; do not show/hide a
full surface by toggling its `hidden` attribute alone.

Current state to converge: ESC closes settings, lightbox, confirm modal, model
picker, mention popup, overflow menu, all full-screen views (`viewStack` +
`popstate` + capture-phase ESC), **and the detail asides + members panel**
(`closeTopDetailAside()` — the aside is one layer above its view, so the first
Escape closes the aside, the next closes the view). Remaining gap: asides have
no backdrop-tap or history entry yet — × and Escape only.

---

## 5. Feedback channels — four, with a rule

| Channel | API | Fires for |
|---------|-----|-----------|
| Transcript bubble | `appendSystem()` (×18) | **conversation-domain events only** — agent joined, file shared, an in-room approval |
| Toast | `showToast()` (×72) | **operation outcomes** — saved, copied, failed, status changed |
| Inline text | (login, perms) | **field validation** — bad token, missing name |
| Persistent banner | `#connection-banner`, `#update-banner` | **standing states needing user action** — connection lost, a new version ready |
| Inline spinner | `.btn-spinner` (+ `wizardBusy()`) | **in-progress** — the "doing something" signal, on the control/row that's working |

A standing state gets a persistent, one-tap-actionable banner — never a toast
(it expires) and never a silent deferral. The update banner exists because the
service-worker takeover used to defer its reload until the tab went hidden:
invisible on mobile (the tab is always visible in use; iOS freezes JS on
background), so installed PWAs sat versions behind with no signal.

**In-progress lives on the thing that's working, never in a toast.** A press
that starts async work shows its wait *on the pressed control* — `wizardBusy(btn,
'Probing…')` clears the label, drops in a `.btn-spinner`, disables, and returns a
restore fn for the `finally`. A list that's fetching shows the same ring inline
as its first row ("Loading catalog…", "Searching…"), not a blank pane or a
toast. One spinner primitive (`.btn-spinner`, a `currentColor` ring on the
`lightbox-spin` keyframe) so every wait reads identically. Toasts are for
*outcomes*; a spinner is the *wait* — don't announce "Loading…" in a toast.

Rule of thumb: if it isn't part of the *conversation*, it does not belong in the
transcript. Notably, Web Push setup currently narrates `Push: fetching VAPID
key…`, `Push: subscribing…`, etc. via `appendSystem` into whatever room you're
in — that's operational telemetry in your message history. Move multi-step
operational status to toasts or the settings panel.

No native `confirm()` / `alert()` — use `showConfirmModal()` (already universal
at all 8 destructive sites).

---

## 6. Microcopy

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
- **Term — "user credentials":** the bring-your-own-key feature is **"user
  credentials"** in the UI. Never "member credentials" (the old label) or "BYOK"
  (internal jargon — `byok` no longer appears anywhere). The per-room states are
  *off* / *optional* / *required*.
- **Prose budget — surfaces are controls, not documents.** No explainer
  paragraphs in panels or forms; a control must be self-evident from its label
  and affordance. A standing hint line (one line, no trailing period) is
  allowed only when: a control would be **inexplicable** without it (disabled
  by a missing prerequisite); there's an **irreversibility/safety** consequence
  ("Stored once, never shown again"); or it's the **empty state**. Everything
  else moves to tooltips (`title`), placeholders, outcome toasts, or Help —
  e.g. "toggle, then save" is what a Save button already says; delete it.
  - **Default posture: label only.** A new control ships with *nothing but its
    label*. Adding any hint, description, or ⓘ paragraph is a deliberate
    exception you must justify against the three gates above before writing it —
    not the default you trim back later. When in doubt, ship the label alone;
    prose can always be added if it's genuinely missed, but the burden is on
    adding it, not removing it.
  - **The ⓘ paragraph is the *only* home for "what/how/why" copy**, it's
    hidden by default, and it is at most 2–3 sentences. If a control has an ⓘ,
    it does **not** also get a standing hint saying the same thing — one or the
    other, never both.
  - **Before committing any UI change, audit every user-facing string you
    added.** For each, name which gate lets it stay; if none does, delete it or
    move it to a `title`/placeholder. A control's own label + a result toast
    almost always covers it.

---

## 7. Lists & navigation

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
| Active / selected | `background: var(--surface2)` **plus an inset accent glow** (`box-shadow: inset 0 0 8px color-mix(in srgb, var(--accent) 15%, transparent)`) — the glow is what separates active from a plain-surface2 hover. Text stays neutral (`--text`), **not** an accent-colored label, and the row keeps its **identity** left border (room hue / thread `--thread-color`), which is independent of selection. Don't tint the label or the border with accent. |
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

---

### Shared row classes travel with their structure

A row class like `.skill-source-row` is a **contract, not just a coat of
paint**: it assumes the companion structure its first user built — an info
wrapper with `flex: 1; min-width: 0` so unbreakable content (URLs, ids)
shrinks and ellipsizes instead of shoving the row's control off-screen, and
row children that expect the wrapper's column layout. Reusing the class bare
has produced off-screen buttons twice (MCP drawer tool rows; the Settings MCP
registry row). The rule: **copy the whole row recipe (wrapper included) or
mint your own class** — never borrow just the class name. The same applies to
form containers: `.agent-detail-form label` styles every `<label>` inside it
(column layout, and its `display: flex` beats the `hidden` attribute), so
labels that need different behavior must out-specify it explicitly.

## 8. Views

The PWA has one chat surface plus a set of **full-views** — full-screen sections
(siblings of `#chat`) opened from the header **overflow menu** (⋯): **Manage**
(Agents / Models), **Topology**, **Wiring**, **Permissions**, **Settings**, and
**Help**. Each is a `<section id="…" hidden>` with a `.dash-header` (a
`.mobile-back` chevron + title) and a scrollable `.dash-body`.

Open/close is uniform — copy an existing trio (e.g. `openMatrix` /
`teardownMatrix` / `toggleMatrix`): `hideOtherFullViews('<name>')`, toggle the
section's `hidden`, flip the `in-dashboard` body class, and route history through
`openView('<name>', teardown)` / `closeView('<name>')` so the OS/browser back
gesture works. A new view MUST also add its `keep !== '<name>'` branch to
`hideOtherFullViews` or it will stack on top of the others. Settings is the
exception — a `.modal-overlay`, not a full-view.

---

## 9. Enforcing this

Once code is migrated onto the tokens, add a stylelint
`declaration-property-value-allowed-list` for `border-radius`, `font-size`, and
`transition-duration` so literal values fail CI instead of accumulating. Until
the migration lands, the rule would be all-red — introduce it *after*, not
before. Keep this doc in sync when the contract changes; agents read it as the
spec.

## Model identity

One convention wherever a model appears (registry list, detail panel, Ollama
host cards): **kind badge + bare model name + dim host meta** (`.model-row-host`
/ card meta). Never bake the endpoint into the display name — older entries
that did are display-normalized by `modelDisplayParts()`. Kind is identity,
not data entry: render it as the badge plus a one-line explainer
(`modelKindExplainer()`), never as a form field. Live endpoint facts
(installed · size · in-memory) use the same wording in the detail strip and
the host cards so the two surfaces can't disagree.

The Models tab has exactly two surfaces: **Selectable models** (top — what
agent settings offers; every row opens its detail) and **Servers** (bottom —
Ollama hosts and the LiteLLM router, each listing what it serves). Server
rows never open a detail; they carry a single +/− toggle that adds/removes
the model from the selectable list (kind decided by the server type), plus
per-card actions (pull on Ollama hosts, roster refresh on the router).

---

## Composer popups

Anything that pops above the composer (`.mention-popover`, `#slash-menu`)
shares **one look**: anchored inside `#message-form` (iOS keyboard viewport),
`bottom: calc(100% + 4px)`, same chrome (6px radius, `0 4px 16px` shadow,
`0.867rem`), horizontal rows — the key term in `--accent` (mention slug /
slash command), the rest dimmed inline. New composer popups mirror
`.mention-popover`; don't invent a third style.

Selection semantics: picking a **text completion** inserts it; picking an
**action** (e.g. the bulk `/clear all`) fires it directly — and any confirm
modal it opens must be deferred past the triggering keypress
(`setTimeout(…, 0)`), or the same Enter auto-confirms it.

---

## Install-row — installable features (Settings + wizard)

An installable feature (auto routing, TTS voice models, Whisper dictation, Codex)
is one `.setting-group.install-row` line: **name left, action right**, three
states —

1. `Install` (secondary button)
2. `Installing…` — disabled **with a spinner** via `wizardBusy(btn, 'Installing…')`,
   the SAME busy affordance the step-0 provider installs use; a progress `<pre>`
   log (`.wizard-code`) appears below. Do **not** just set `textContent =
   'Installing…'` — plain text reads as a lesser affordance than the spinner
   elsewhere. Keep install "Installing…" states spinner-consistent.
3. green `✓ Installed` badge (`.install-badge`, `--success`, no button)

**The wizard Features step reuses this exact pattern**, and each optional feature
leads with a `.setting-toggle` enable switch — MCP & skills catalog, Read Aloud
(TTS), Voice Dictation (STT) all start with the toggle; their install-row + `✓`
badge appear only once the feature is toggled on. When adding a feature to the
wizard: **toggle first, then the install-row, then the badge**, and share one
install/poll path with the Settings surface (element-id sets + a re-render
callback) so both stay in lockstep. An "installed" badge must reflect *reality*
(probe the backend, not an env flag) — a stale flag lies (see `ttsBackendUp`).

No explainer paragraph — the feature's own surface is the explanation; a
tooltip on the badge may point at it. The **only** standing hint is the
missing-prerequisite case: the Install flow sets up the LiteLLM router first
(no shell, no `/add-litellm`), so the button stays live and the hint explains
the extra step ("Sets up the LiteLLM router, then installs auto routing…").

Trap: `.btn` and `.install-badge` set `display: inline-flex` (author origin),
which beats the UA `[hidden]{display:none}` — so `el.hidden = true` does nothing
and a hidden button/badge still renders. `.install-row [hidden]` re-asserts it for
elements inside a row, and `.install-badge[hidden]` for standalone badges (the
wizard puts badges outside a row). Keep both rules — a missing one shows
"…installed" on a fresh install. Any new `display:`-carrying element you toggle
via `hidden` needs its own `[hidden]{display:none}` restate.

---

## Scroll containment

The app is a fixed `100dvh` flex shell — **the document must never be a
scroller**. `html, body { overflow: hidden }` locks it (iOS ignores root
`overscroll-behavior` in installed PWAs, so an overflowing document means
gestures drag the whole shell). All scrolling happens in internal containers.

Every internal scroller needs the full recipe:

- `flex: 1; min-height: 0; overflow-y: auto` — without the first two, a
  flex-column child grows past the shell instead of scrolling (the mobile
  sidebar bug), and the gesture goes to whatever is behind it.
- membership in the **grouped `overscroll-behavior: contain` rule** at the tail
  of `style.css` ("PWA scroll containment") — one list, add new scrollers
  there, so hitting a list edge never chains to the surface behind.

Tab bars and other horizontal strips that can overflow a phone width get
`overflow-x: auto` + hidden scrollbar + `flex-shrink: 0` children — never
`overflow: visible` (that clips the trailing tab unreachably).

---

## Privilege-gated surfaces

Admin-and-above UI ships **hidden in the markup** (`hidden` attribute) and is
revealed by `probeIsOwner()` after auth resolves. Two client flags, one rule:

| Flag | True for | Gates |
|------|----------|-------|
| `isAdminView` | any admin+ (`/api/users` succeeded) | MCP tab/menu, Skills tab/menu, the slash-command menu |
| `isOwnerView` | owner (own roles in the response) | owner-only writes — room assignment, permissions panel, skill-collection registry |

The client hiding is **UX, not security** — every gated endpoint re-checks
server-side (`isAnyAdmin` / `hasAdminPrivilege` / `isGlobalAdmin`). Don't
surface a control whose only outcome for the viewer is "Permission denied"
(the pre-gate slash menu did exactly that).
