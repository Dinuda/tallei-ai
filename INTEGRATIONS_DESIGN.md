# Tallei Integrations Section — Design & Component Breakdown

## Overview
The design file contains a marketing page showcasing the **Integrations Section** with a split-screen layout:
- **Left side**: Hero copy + platform badges (ChatGPT, Claude, Gemini, etc.)
- **Right side**: Product mockup showing Tallei working silently in ChatGPT with memory context

---

## Layout Structure

### Main Container: `.wrap`
- **Grid layout**: 2 columns (`40% 1fr`)
- **Gap**: 72px between columns
- **Max-width**: 1080px
- **Responsive**: Uses `clamp()` for font sizes

---

## Left Column (Hero Section)

### Components:

#### 1. **Eyebrow / Overline**
```
Class: .eyebrow
- Font: DM Mono, 10px, uppercase, 0.14em letter-spacing
- Color: var(--accent) [purple]
- Text: "Integrations"
- Margin-bottom: 22px
```

#### 2. **Main Headline (h1)**
```
Class: h1
- Font: Instrument Serif, 400 weight, italic for <em>
- Size: clamp(36px, 3.6vw, 50px)
- Line-height: 1.1
- Letter-spacing: -0.02em
- Color: var(--ink) [dark]
- Margin-bottom: 18px
- Content: "Use any AI.\nTallei keeps them in sync."
  - <em> tag inside for italic emphasis on "them in sync"
```

#### 3. **Subheading (Subtitle)**
```
Class: .sub
- Font-size: 15px
- Line-height: 1.7
- Color: var(--ink-2) [lighter]
- Max-width: 340px
- Margin-bottom: 44px
- Describes Tallei's value prop
```

#### 4. **Platform Badges Section**
```
Label (.logos-label):
- Font-size: 11px, 500 weight
- Color: var(--ink-3) [muted]
- Margin-bottom: 12px
- Text: "Works with"

Badge Container (.logos-row):
- Display: flex, wrap
- Gap: 6px
- Align-items: center

Individual Badge (.logo-badge):
- Dimensions: 38px × 38px
- Border-radius: 9px
- Background: var(--surface) [white]
- Border: 1px solid var(--border) [light]
- Display: flex center
- Cursor: default
- SVG inside: 20px × 20px

Badge Hover Tooltip (data-tip):
- Position: absolute below badge
- Background: var(--ink) [dark]
- Color: white
- Font-size: 11px
- Padding: 4px 8px
- Border-radius: 5px
- Shows on hover via CSS ::after pseudo-element

"Soon" Badges (.logo-badge.soon):
- Opacity: 0.32 (grayed out)
- Applied to: Perplexity, Claude Code, OpenRouter, Grok

Divider (.logos-divider):
- Width: 1px, height: 22px
- Background: var(--border)
- Margin: 0 2px
- Between active and "coming soon" badges

Coming Soon Note (.soon-note):
- Font-size: 11px
- Color: var(--ink-3)
- Margin-top: 12px
```

---

## Right Column (Product Mockup)

### Main Container: `.right`
- Position: relative
- Contains the ChatGPT-like shell mockup

### 1. **Shell Container (.mock-shell)**
```
- Background: var(--surface) [white]
- Border: 1px solid var(--border)
- Border-radius: 16px
- Overflow: hidden
- Box-shadow: Triple-layer shadow
  * 0 1px 2px rgba(lightened dark, 0.04)
  * 0 6px 24px rgba(lightened dark, 0.08)
  * 0 24px 64px rgba(lightened dark, 0.07)
```

### 2. **GPT Chrome Bar (.gpt-chrome)**
```
- Background: #212121 [dark gray]
- Display: grid, 2 columns (200px 1fr)
- Height: 44px
- Padding: 0

Left Section (.gpt-chrome-left):
- Border-right: 1px solid #2d2d2d
- Display: flex, center-aligned
- Padding: 0 16px
- Gap: 8px

Logo Group (.gpt-logo):
- Display: flex, gap 7px
- SVG: 18px × 18px
- Name (.gpt-logo-name):
  * Font-size: 13px, weight 500
  * Color: #ececec
  * Letter-spacing: -0.01em

Right Section (.gpt-chrome-right):
- Display: flex, center-aligned, flex-end
- Padding: 0 16px
- Gap: 8px

Model Badge (.gpt-model-badge):
- Font-size: 11px
- Font-family: DM Mono
- Color: #888
- Background: #2d2d2d
- Border-radius: 5px
- Padding: 3px 9px
- Text: "GPT-4o"
```

### 3. **Tallei Pill (.tallei-pill)**
**This is the key visual of the integration**
```
- Display: flex, center-aligned
- Gap: 5px
- Background: color-mix(purple 12%, transparent)
- Border: 1px solid color-mix(purple 30%, transparent)
- Border-radius: 20px
- Padding: 3px 10px 3px 7px
- Cursor: pointer
- Transition: background 0.15s

On Hover:
- Background: color-mix(purple 18%, transparent)

Dot (.tallei-dot):
- Width/Height: 6px
- Border-radius: 50%
- Background: var(--accent-mid) [lighter purple]
- Animation: pulse 2.4s ease-in-out infinite
  * 0%, 100%: opacity 1, scale 1
  * 50%: opacity 0.5, scale 0.8

Label (.tallei-pill-label):
- Font-size: 11px
- Color: var(--accent-mid)
- Font-family: DM Sans, weight 500
- Text: "Tallei syncing"
```

### 4. **GPT Body (.gpt-body)**
```
- Display: grid, 2 columns (200px 1fr)
- Background: #212121
- Min-height: 320px

Left: Sidebar
Right: Main content area
```

#### **Sidebar (.gpt-sidebar)**
```
- Border-right: 1px solid #2d2d2d
- Padding: 12px 8px
- Display: flex column, gap 1px

Sidebar Label (.gpt-sidebar-label):
- Font-size: 9.5px
- Color: #555
- Letter-spacing: 0.08em
- Text-transform: uppercase
- Padding: 4px 8px 8px
- Font-family: DM Mono
- Text: "Recents"

Threads (.gpt-thread):
- Font-size: 12px
- Color: #888
- Padding: 7px 10px
- Border-radius: 7px
- Cursor: pointer
- Overflow: ellipsis

States:
- Default: #888 text, transparent bg
- Hover: #bbb text, #2a2a2a bg
- Active (.gpt-thread.active): #ececec text, #2d2d2d bg
  * Class on "Q3 pricing model"

Thread List:
- Brand positioning
- Agency contract v3
- Q3 pricing model [active]
- Hiring brief — eng
- Onboarding copy
```

#### **Main Content (.gpt-main)**
```
- Display: flex column
- Contains: memory banner + chat area + input
```

### 5. **Memory Banner (.memory-banner)**
**Showcases Tallei's value: surfacing prior context**
```
- Margin: 14px 18px 0
- Background: color-mix(purple 8%, #212121)
- Border: 1px solid color-mix(purple 22%, transparent)
- Border-radius: 10px
- Padding: 10px 14px
- Display: flex, flex-start aligned
- Gap: 10px

Memory Icon (.memory-icon):
- SVG: 20px × 20px
- Color: var(--accent-mid)
- Flex-shrink: 0
- Margin-top: 1px
- SVG: circle + clock hand path (time/memory symbol)

Memory Text (.memory-text):
- Flex: 1

Heading (.memory-heading):
- Font-size: 11px, weight 500
- Color: var(--accent-mid)
- Margin-bottom: 3px
- Display: flex, gap 6px, align-items center
- Text: "Memory from your last session"

Source Badge (.memory-src):
- Display: flex, gap 4px
- Opacity: 0.7
- SVG: 11px × 11px (Claude logo)
- Span: 10px, DM Mono, text "via Claude"

Body (.memory-body):
- Font-size: 12px
- Color: #999
- Line-height: 1.5
- Content shows specific decisions from prior session
- <em> tags inside: color #c4c4c4, font-style normal (highlight key decisions)
```

### 6. **Chat Area (.chat-area)**
```
- Padding: 16px 18px
- Display: flex column
- Gap: 14px
- Flex: 1 (grows to fill space)

Message (.msg):
- Display: flex
- Gap: 10px

Avatar (.msg-avatar):
- Width/Height: 26px
- Border-radius: 50%
- Background: #333
- Flex-shrink: 0
- Display: flex center
- Font-size: 10px
- Color: #aaa
- User variant: background #3d3d3d
- Letters: "Y" for user, SVG for ChatGPT

Bubble (.msg-bubble):
- Font-size: 13px
- Line-height: 1.6
- Color: #d1d1d1
- Padding-top: 3px
- Max-width: 90%
- <strong> tags: color #ececec, weight 500
- Content: Conversation about pricing decisions

Messages:
1. User message: "Given that decision, should we launch with annual-only for the enterprise tier?"
2. ChatGPT response: About ARR, cancellation clauses, trial strategy
```

### 7. **Chat Input Row (.chat-input-row)**
```
- Margin: 0 18px 16px
- Background: #2d2d2d
- Border-radius: 10px
- Padding: 10px 14px
- Display: flex, center-aligned
- Gap: 10px
- Border: 1px solid #3a3a3a

Input Text (.chat-input-text):
- Flex: 1
- Font-size: 13px
- Color: #666
- Font-family: DM Sans
- Placeholder text: "Message ChatGPT…"

Send Button (.chat-send):
- Width/Height: 28px
- Border-radius: 7px
- Background: #555
- Border: none
- Cursor: pointer
- Display: flex center
- SVG: 14px × 14px, fill #222
```

---

## Color Palette (CSS Variables)

### Light Theme (Left side, backgrounds):
```css
--bg:        oklch(97.2% 0.010 78)      /* Off-white warm */
--surface:   oklch(99.8% 0.003 78)      /* Pure white */
--ink:       oklch(13%  0.012 270)      /* Dark (text) */
--ink-2:     oklch(40%  0.010 265)      /* Medium gray (secondary text) */
--ink-3:     oklch(60%  0.008 265)      /* Light gray (muted text) */
--border:    oklch(87%  0.008 265)      /* Light border */
--border-2:  oklch(92%  0.006 265)      /* Lighter border */
```

### Accent Colors (Purple theme):
```css
--accent:     oklch(50%  0.20  278)     /* Main purple */
--accent-bg:  oklch(95%  0.05  278)     /* Very light purple bg */
--accent-mid: oklch(72%  0.12  278)     /* Medium purple (highlights) */
```

### Dark Section (ChatGPT mockup):
```
#212121      /* Dark bg */
#2d2d2d      /* Slightly lighter dark */
#2a2a2a      /* Hover state dark */
#3a3a3a      /* Border dark */
#ececec      /* Light text on dark */
#d1d1d1      /* Medium text on dark */
#888         /* Dim text on dark */
#555         /* Very dim text on dark */
```

---

## Typography

### Font Families:
1. **DM Sans** (sans-serif)
   - Used for: body, UI labels, input
   - Weights: 300, 400, 500

2. **DM Mono** (monospace)
   - Used for: eyebrow, badges, code-like elements
   - Weights: 400, 500

3. **Instrument Serif** (serif)
   - Used for: headlines (h1)
   - Styles: normal, italic
   - Weight: 400

### Type Scale:
```
Eyebrow:        10px
Badge label:    11px
Memory heading: 11px, 500wt
Sidebar label:  9.5px
Subheading:     15px
Model badge:    11px
Chat/messages:  13px
Headline (h1):  clamp(36px, 3.6vw, 50px)
```

---

## SVG Icons Used

### Platform Logos:
- `#logo-chatgpt` — OpenAI green (#10a37f)
- `#logo-claude` — Brown (#d97757)
- `#logo-gemini` — Multi-color gradient (#4285f4 → #9b72cb → #d96570)
- `#logo-perplexity` — Cyan (#1fb8cd)
- `#logo-openrouter` — Indigo (#6366f1)
- `#logo-grok` — Light gray (#e5e5e5)
- `#logo-claudecode` — Orange-brown (#b5601a)

### Icons:
- `#icon-memory` — Circle with clock hand (memory symbol)
- Chat send icon (arrow shape) — inlined in button

---

## Animation & Transitions

### Tallei Dot Pulse:
```css
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(0.8); }
}
/* Duration: 2.4s, easing: ease-in-out, infinite */
```

### Button/Pill Transitions:
- `.tallei-pill:hover` — background color change, 0.15s

---

## Responsive Behavior

### Desktop (base):
- Headline: clamp(36px, 3.6vw, 50px) — scales with viewport
- Two-column grid at max-width 1080px
- Body padding: 80px 48px

### Typography:
- Uses `clamp()` for fluid scaling
- Min/max line-heights defined

---

## HTML Structure Key Elements

### Main Content Wrapper:
```
<div class="wrap">
  <div class="left">
    <!-- Hero section -->
  </div>
  <div class="right">
    <div class="mock-shell">
      <!-- ChatGPT mockup -->
    </div>
  </div>
</div>
```

### SVG Sprite Usage:
```html
<svg style="display:none" xmlns="http://www.w3.org/2000/svg">
  <symbol id="logo-..."><!-- paths --></symbol>
  ...
</svg>

<!-- Usage: -->
<svg viewBox="0 0 24 24"><use href="#logo-chatgpt"></use></svg>
```

---

## Tweaks Panel (Hidden UI Control)

### Purpose:
Edit mode for design preview — shows options to:
1. **Page background**: Warm cream vs. Clean white
2. **Tallei accent**: Purple vs. Blue vs. Teal

### Classes:
- `#tweaks-panel` — Fixed bottom-right, initially hidden
- Shown via `__activate_edit_mode` postMessage

### Color Variants:
```javascript
const accentMap = {
  purple: ['oklch(50% 0.20 278)', 'oklch(95% 0.05 278)', 'oklch(72% 0.12 278)'],
  blue:   ['oklch(50% 0.18 240)', 'oklch(95% 0.05 240)', 'oklch(72% 0.12 240)'],
  teal:   ['oklch(50% 0.16 185)', 'oklch(95% 0.05 185)', 'oklch(70% 0.12 185)'],
}
```

---

## Component Names & Classes Summary

| Component | Class(es) | Purpose |
|-----------|-----------|---------|
| Container | `.wrap` | Main 2-col layout |
| Section | `.left` / `.right` | Hero vs. mockup |
| Overline | `.eyebrow` | "Integrations" label |
| Headline | `h1` | Main title |
| Subtitle | `.sub` | Description |
| Badge group | `.logos-row` | Platform badge container |
| Badge | `.logo-badge` | Single platform logo |
| Badge soon | `.logo-badge.soon` | Grayed-out "coming soon" |
| Divider | `.logos-divider` | Visual separator |
| Shell | `.mock-shell` | ChatGPT mockup container |
| Chrome bar | `.gpt-chrome` | Title bar |
| Pill | `.tallei-pill` | "Syncing" indicator |
| Sidebar | `.gpt-sidebar` | Chat list |
| Memory banner | `.memory-banner` | Context from prior session |
| Chat area | `.chat-area` | Message display |
| Chat input | `.chat-input-row` | Message input field |

---

## Integrations Concept

The design demonstrates:

1. **Multi-AI support**: Show ChatGPT, Claude, Gemini as live integrations
2. **Seamless background operation**: Tallei pill shows it's "syncing" — not obtrusive
3. **Context carryover**: Memory banner shows decisions from a prior Claude session appearing in ChatGPT
4. **Connector roadmap**: Perplexity, Claude Code, OpenRouter, Grok marked as "coming soon"
5. **Conversation continuity**: Real-world scenario of a pricing discussion using prior context across AI tools

---

## Key Design Insights

- **Minimal branding**: Tallei presence is subtle (just the pill) — emphasizes seamless, background operation
- **Color psychology**: Purple accent is energetic but not aggressive; works as "silent guardian" motif
- **Contrast strategy**: Light left side (hero) vs. dark right side (dark theme product mockup) — shows Tallei works in any environment
- **Data-driven labels**: `data-tip` tooltips on badges provide context without cluttering
- **Responsive type**: Uses `clamp()` to scale headline naturally across devices
- **Accessibility**: Uses semantic HTML (h1, strong), good contrast on dark theme (light text)

