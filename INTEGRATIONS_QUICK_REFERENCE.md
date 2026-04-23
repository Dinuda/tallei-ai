# Tallei Integrations Section — Quick Reference

## File Locations
- **Design Analysis**: `/INTEGRATIONS_DESIGN.md` (detailed breakdown)
- **Component Structure**: `/INTEGRATIONS_COMPONENT_STRUCTURE.md` (React recommendations)
- **Original HTML**: `/Downloads/Tallei Integrations.html` (bundled design file)

---

## Key Metrics at a Glance

| Aspect | Value |
|--------|-------|
| Layout | 2-col grid: 40% / 1fr |
| Max-width | 1080px |
| Gap between cols | 72px |
| Body padding | 80px 48px |
| Headline font | Instrument Serif, clamp(36px, 3.6vw, 50px) |
| Primary accent | oklch(50% 0.20 278) [purple] |
| Background color | oklch(97.2% 0.010 78) [warm cream] |
| Dark mockup BG | #212121 |
| Border radius (mockup) | 16px |
| Badge size | 38px × 38px |
| Badge border-radius | 9px |
| Pulse animation | 2.4s ease-in-out, infinite |

---

## Color Quick Reference

### Light Theme (Left side)
```
Background:  #f5f3f0  (oklch equivalent)
Surface:     #ffffff
Accent:      #6b5ead (oklch(50% 0.20 278))
Text dark:   #1a1a2e (oklch(13% 0.012 270))
Text med:    #666666 (oklch(40% 0.010 265))
Text light:  #999999 (oklch(60% 0.008 265))
Border:      #ddd    (oklch(87% 0.008 265))
```

### Dark Theme (Right mockup)
```
BG:          #212121
Hover:       #2d2d2d / #2a2a2a
Text light:  #ececec
Text med:    #d1d1d1
Text dim:    #999999
Text muted:  #888888
Purple hint: rgba(107, 94, 173, 0.12)
```

---

## Typography Stack

| Use | Font | Weight | Size |
|-----|------|--------|------|
| Headline | Instrument Serif | 400 | clamp(36px, 3.6vw, 50px) |
| Subtitle | DM Sans | 400 | 15px |
| Eyebrow | DM Mono | 400 | 10px uppercase |
| Labels | DM Mono | 500 | 11px uppercase |
| Body text | DM Sans | 400 | 13-15px |
| Chat/messages | DM Sans | 400 | 13px |
| Monospace | DM Mono | 400/500 | 10-13px |

---

## Component Inventory

### Left Column
- [ ] Eyebrow ("Integrations")
- [ ] Headline (with <em> italic emphasis)
- [ ] Subtitle copy
- [ ] "Works with" label
- [ ] Badge row (flex, wrap)
  - [ ] ChatGPT badge
  - [ ] Claude badge
  - [ ] Gemini badge
  - [ ] Divider line
  - [ ] Perplexity badge (soon)
  - [ ] Claude Code badge (soon)
  - [ ] OpenRouter badge (soon)
  - [ ] Grok badge (soon)
- [ ] "More coming soon" note

### Right Column (ChatGPT Mockup)
- [ ] Shell container (white card with shadow)
- [ ] Chrome bar (#212121)
  - [ ] ChatGPT logo + name
  - [ ] GPT-4o model badge
  - [ ] Tallei pill (with pulsing dot)
- [ ] Body (dark grid: sidebar + main)
  - [ ] Sidebar
    - [ ] "Recents" label
    - [ ] 5x thread items (1 active)
  - [ ] Main content
    - [ ] Memory banner
      - [ ] Icon (clock/memory)
      - [ ] Heading + source badge
      - [ ] Body text (with emphasis)
    - [ ] Chat messages
      - [ ] User message
      - [ ] ChatGPT response (with highlighted key point)
    - [ ] Input row (placeholder text + send button)

---

## CSS Classes to Implement

```
.wrap
.left / .right
.eyebrow
h1 (with em styling)
.sub
.logos-label
.logos-row
.logo-badge
.logo-badge.soon
.logos-divider
.soon-note

.mock-shell
.gpt-chrome
.gpt-chrome-left / .gpt-chrome-right
.gpt-logo
.gpt-logo-name
.gpt-model-badge
.tallei-pill
.tallei-dot
.tallei-pill-label
@keyframes pulse

.gpt-body
.gpt-sidebar
.gpt-sidebar-label
.gpt-thread
.gpt-thread:hover / .gpt-thread.active

.gpt-main
.memory-banner
.memory-icon
.memory-text
.memory-heading
.memory-src
.memory-body (with em styling)

.chat-area
.msg
.msg-avatar
.msg-avatar.user
.msg-bubble
.msg-bubble strong

.chat-input-row
.chat-input-text
.chat-send
```

---

## SVG Symbols Needed

```
#logo-chatgpt     (OpenAI, #10a37f green)
#logo-claude      (Anthropic, #d97757 brown)
#logo-gemini      (Google, gradient)
#logo-perplexity  (Perplexity, #1fb8cd cyan)
#logo-openrouter  (OpenRouter, #6366f1 indigo)
#logo-grok        (xAI, #e5e5e5 gray)
#logo-claudecode  (Code, #b5601a orange-brown)
#icon-memory      (Clock hand + circle)
```

---

## Data Snapshot

### Active Platforms (3)
1. ChatGPT (OpenAI)
2. Claude (Anthropic)
3. Gemini (Google)

### Upcoming Platforms (4)
1. Perplexity
2. Claude Code
3. OpenRouter
4. Grok

### Memory Banner Context
- From: Claude (prior session)
- Decision: Tiered pricing ($49/mo), ruled out usage-based, enterprise tier pending legal review
- Use case: Appears in ChatGPT when discussing pricing strategy

### Chat Messages
- User: "Given that decision, should we launch with annual-only for the enterprise tier?"
- ChatGPT: Response about ARR, cancellation clauses, 14-day trial recommendation

---

## CSS Variables to Define (Recommended for dashboard)

```css
:root {
  /* Light theme */
  --bg:              oklch(97.2% 0.010 78);
  --surface:         oklch(99.8% 0.003 78);
  --ink:             oklch(13% 0.012 270);
  --ink-2:           oklch(40% 0.010 265);
  --ink-3:           oklch(60% 0.008 265);
  --border:          oklch(87% 0.008 265);
  --border-light:    oklch(92% 0.006 265);
  
  /* Accent (purple) */
  --accent:          oklch(50% 0.20 278);
  --accent-bg:       oklch(95% 0.05 278);
  --accent-mid:      oklch(72% 0.12 278);
  
  /* Shadows */
  --shadow-sm:       0 1px 2px oklch(14% 0.015 265 / 0.04);
  --shadow-md:       0 6px 24px oklch(14% 0.015 265 / 0.08);
  --shadow-lg:       0 24px 64px oklch(14% 0.015 265 / 0.07);
  
  /* Dark override */
  --dark-bg:         #212121;
  --dark-border:     #2d2d2d;
  --dark-text:       #ececec;
}
```

---

## Key Takeaways for Implementation

1. **Split-screen layout**: Light hero (left) contrasts with dark product mockup (right)
2. **Platform badges**: Show active 3, then divider, then 4 "coming soon" with opacity 0.32
3. **Tallei pill**: Subtle purple accent with animated pulsing dot — emphasizes "invisible syncing"
4. **Memory banner**: Demonstrates cross-AI memory carryover (Claude → ChatGPT)
5. **Responsive**: Use `clamp()` for headline; consider 1-col stack on mobile
6. **Theme**: Different from main dashboard (purple instead of green) — consider separate styling or theme switch
7. **Animations**: Only the dot pulses (2.4s, ease-in-out); pill hover has subtle bg transition (0.15s)
8. **Accessibility**: Good contrast, semantic HTML (h1, strong), data-tip tooltips

---

## Next Steps

1. Extract SVG icons into separate files or sprite sheet
2. Create Badge, MemoryBanner, ChatMessage components
3. Set up CSS variables for theming
4. Implement responsive breakpoints
5. Test hover/active states on badges and threads
6. Verify pulse animation performance
7. Consider dark mode toggle for mockup visibility on different screens

