# Collab Tasks UI/UX Redesign Plan
## Tallei Dashboard — `/dashboard/collab/[id]` & `/dashboard/collab`

**Date:** 2026-04-29  
**Scope:** Collab Task detail page + Collab Task list page  
**Goal:** Transform the current functional-but-cluttered UI into a polished, scannable, and delightful multi-agent collaboration experience.

---

## Stakeholder Decisions

| Question | Decision |
|----------|----------|
| 1. Markdown scope | **Full GitHub-flavored markdown** — tables, code blocks, headings, bold, lists, blockquotes, horizontal rules. Use `streamdown` (already installed) + `shiki` for syntax highlighting. |
| 2. Desktop breakpoint | **1280px** for two-column layout. Single column below. |
| 3. Iteration timeline visibility | **Collapsible**. Default collapsed for tasks with >6 iterations, expanded for ≤6. |
| 4. Document previews | **Drawer/slide-out panel** from the right side. |
| 5. Polling strategy | **20-second interval** (was 2s). Prominent refresh button always visible. Hard timeout limit kept at 10 minutes. Show "last updated" timestamp. |
| 6. Brand direction | **Professional and clean**. Lean into Tallei green (`#7eb71b`) as primary brand accent. Actor colors (ChatGPT green, Claude orange) used as secondary accents only. |

---

## The Team

### 1. Maya Chen — Information Architect & Layout Designer
**Specialty:** Content hierarchy, grid systems, responsive behavior, whitespace strategy.  
**Philosophy:** *"If everything is important, nothing is."*

**Assigned areas:**
- **Two-column layout** for desktop (1280px breakpoint)
  - Left column (~65%): Live output + Transcript — the "reading" surfaces
  - Right column (~35%): Status, docs, plan, actions — "check and act" surfaces
- **Content priority tiers:**
  - P0: Latest output (elevated, borderless, full markdown)
  - P1: Status header + action bar
  - P2: Transcript history
  - P3: Documents, plan, setup (collapsible right column sections)
- **Responsive:** Single column < 1280px, sticky action bar becomes bottom sheet on mobile
- **Spacing system:** 4px-base scale (4, 8, 12, 16, 24, 32, 48)

### 2. Jordan Okonkwo — Interaction Designer & Motion Specialist
**Specialty:** Micro-interactions, state transitions, real-time feedback, scroll behaviors.  
**Philosophy:** *"Motion should explain, not decorate."*

**Assigned areas:**
- **Actor handoff animation:** Arrow "passes" between avatars with spring physics. Next actor's avatar gets subtle color glow pulse.
- **New entry animation:** Transcript cards slide in with `translateY(12px) + opacity` using spring(1, 0.8, 10)
- **Smart scroll:** Auto-scroll to new content unless user scrolled up to read history (then show "New message" pill)
- **Toast notification:** "Claude responded · Turn 3" top-right, auto-dismiss 3s
- **Button tactility:** 2px `translateY` press state
- **Document drawer:** Slide in from right with backdrop

### 3. Sofia Lindström — Visual Designer & Design Systems Lead
**Specialty:** Color systems, typography, component libraries, iconography, accessibility.  
**Philosophy:** *"Consistency builds trust."*

**Assigned areas:**
- **Tallei design token consolidation** in `globals.css`:
  ```css
  /* Actor semantic tokens */
  --actor-chatgpt: #10a37f;
  --actor-chatgpt-bg: #ecfdf5;
  --actor-chatgpt-border: #bbf7d0;
  --actor-chatgpt-text: #166534;
  --actor-claude: #d97757;
  --actor-claude-bg: #fff7ed;
  --actor-claude-border: #fdba74;
  --actor-claude-text: #9a3412;
  
  /* Status tokens */
  --status-success-bg: #ecfdf5;
  --status-success-text: #166534;
  --status-warning-bg: #fff7ed;
  --status-warning-text: #9a3412;
  --status-error-bg: #fff1f2;
  --status-error-text: #be123c;
  
  /* Elevation */
  --elevation-card: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02);
  --elevation-float: 0 10px 30px rgba(0,0,0,0.08), 0 4px 6px rgba(0,0,0,0.04);
  --elevation-sticky: 0 -4px 20px rgba(0,0,0,0.06);
  ```
- **Elevation system:** Replace "all borders" with 3 shadow levels
- **Typography hierarchy:** Display → Heading → Body → Caption
- **Iconography:** Lucide icons throughout

### 4. Raj Patel — UX Researcher & Content Strategist
**Philosophy:** *"Words are interface."*

**Copy rewrite:**

| Current | Proposed |
|---------|----------|
| "Waiting on ChatGPT for 74m 26s" | "ChatGPT is drafting… · 74m elapsed" |
| "Stalled – nudge again?" | "No response in 30m. Send a reminder?" |
| "Next actor: ChatGPT" | "ChatGPT's turn" |
| "iter 2" | "Turn 2 of 6" |
| "Mark done" | "Finish task" |
| "Extend +2 iterations" | "Add 2 more turns" |
| "Nudge ChatGPT" | "Remind ChatGPT" |

Also: Empty states with friendly placeholders, document cards with metadata instead of raw previews.

### 5. Aisha Diallo — Frontend Engineer & DesignOps
**Philosophy:** *"A beautiful design that doesn't ship is just a picture."*

**Component architecture:**
```
dashboard/app/dashboard/collab/[id]/components/
├── CollabLayout.tsx         (two-column wrapper)
├── StatusHeader.tsx         (horizontal, compact)
├── LatestOutput.tsx         (markdown-rendered, elevated)
├── IterationTimeline.tsx    (collapsible stepper)
├── TranscriptCard.tsx       (actor-tinted bg, markdown)
├── DocumentCard.tsx         (file icon, metadata, drawer)
├── CriteriaPanel.tsx        (collapsible accordion)
└── ActionBar.tsx            (contextual, hierarchical)
```

**Tech stack:**
- Markdown: `streamdown` (already installed) + `shiki` for syntax highlighting
- Animations: CSS transitions + `motion` library (already installed)
- Icons: `lucide-react` (already installed)
- Styling: CSS Modules (keep existing pattern)

**Accessibility mandates:**
- All status changes via `aria-live` regions
- Color never conveys meaning alone (icons + text always)
- Full keyboard navigation
- `prefers-reduced-motion` respected

---

## Key Redesign Highlights

### Layout
**Before:** Single column, cards inside cards, no priority.  
**After:** Two-column at 1280px+. Left = read. Right = check & act.

### Latest Output
**Before:** Same bordered card as everything else. 8-line clamp. Plain text.  
**After:** Elevated card (no border), full height by default, syntax-highlighted markdown, prominent actor badge.

### Iteration Timeline (NEW)
**Before:** No timeline. Scroll to infer sequence.  
**After:** Horizontal stepper showing turns. Collapsible for >6 iterations. Current turn highlighted.

### Documents
**Before:** Plain text list with raw preview dumps.  
**After:** File cards with icon, size, line count. Drawer for full preview.

### Actions
**Before:** 6 flat buttons, no hierarchy.  
**After:** Contextual hierarchy. Primary (filled), secondary (ghost), destructive (text-only). Irrelevant actions hidden.

### Polling
**Before:** Every 2 seconds.  
**After:** Every 20 seconds. Prominent refresh button. "Last updated" timestamp.

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Add semantic tokens to `globals.css`
- [ ] Create component directory structure
- [ ] Build `CollabLayout` two-column wrapper
- [ ] Update `page.module.css` with new layout classes

### Phase 2: Core Content
- [ ] `StatusHeader` — horizontal, compact
- [ ] `LatestOutput` — markdown rendering, elevated
- [ ] `TranscriptCard` — actor-tinted backgrounds, markdown
- [ ] `IterationTimeline` — collapsible stepper

### Phase 3: Context Panel
- [ ] `DocumentCard` — drawer preview
- [ ] `CriteriaPanel` — collapsible accordion
- [ ] `ActionBar` — contextual, hierarchical

### Phase 4: Polish
- [ ] Handoff animations
- [ ] Spring entry physics
- [ ] Toast notifications
- [ ] Button states
- [ ] Polling changes (20s interval)

### Phase 5: Copy & QA
- [ ] Copy rewrites
- [ ] Empty states
- [ ] Cross-browser testing
- [ ] Accessibility audit

---

## Success Metrics

1. Task comprehension time < 2 seconds ("whose turn is it?")
2. Locate specific iteration < 10 seconds
3. Action clarity — user correctly predicts "Finish Task" behavior
4. No FCP regression, animations ≥ 60fps
5. Internal team rates ≥ 4/5 on "would I trust this product?"

---

*Plan approved. Ready for implementation upon explicit "proceed" command.*
