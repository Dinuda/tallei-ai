# Tallei Integrations Section — Complete Documentation Index

This directory contains comprehensive documentation extracted from the bundled Figma design file (`Tallei Integrations.html`) submitted for the new Integrations marketing page.

## Overview

The Integrations Section showcases how Tallei bridges multiple AI platforms (ChatGPT, Claude, Gemini) with seamless memory synchronization. The design demonstrates:

- **Left column**: Hero copy with platform badges (3 active, 4 "coming soon")
- **Right column**: Product mockup showing Tallei's invisible operation in ChatGPT with cross-AI memory carryover
- **Theme**: Purple accent (#6b5ead) + warm cream background, distinct from main dashboard green theme
- **Key visual**: Subtle "Tallei syncing" pill in ChatGPT chrome bar with animated pulsing dot

---

## Documentation Files

### 1. **INTEGRATIONS_DESIGN.md** (554 lines, 13 KB)
**Purpose**: Complete design specification and component breakdown

**Contains**:
- Full layout structure (grid system, spacing, max-widths)
- Left column components (eyebrow, headline, subtitles, badges)
- Right column (ChatGPT mockup, chrome bar, sidebar, memory banner, chat)
- Color palette (light + dark themes, CSS variables)
- Typography scale (fonts, weights, sizes)
- SVG symbols inventory
- Animation keyframes
- HTML structure overview
- CSS class reference

**Best for**: Understanding the visual design, color specifications, and detailed component styling

---

### 2. **INTEGRATIONS_COMPONENT_STRUCTURE.md** (308 lines, 7.3 KB)
**Purpose**: React component architecture and implementation recommendations

**Contains**:
- Component hierarchy tree (IntegrationsPage → sub-components)
- TypeScript interface definitions for Props
- CSS architecture options (CSS Modules, BEM, Tailwind hybrid)
- SVG asset handling strategies
- Dark theme implementation patterns
- Data shape and mock data structure
- Animation keyframes (ready to copy)
- Responsive breakpoints
- Testing approach suggestions
- Migration notes for dashboard integration

**Best for**: Developers building React components, planning CSS structure, and setting up TypeScript types

---

### 3. **INTEGRATIONS_QUICK_REFERENCE.md** (256 lines, 6.4 KB)
**Purpose**: Quick lookup guide with key metrics, colors, and checklist

**Contains**:
- Key metrics table (layout dimensions, font sizes, padding)
- Color quick reference (hex + oklch values)
- Typography stack table
- Component inventory checklist (left + right columns)
- All CSS classes to implement
- SVG symbols needed
- Data snapshot (platforms, memory context, chat messages)
- CSS variables preset (copy-paste ready)
- Key takeaways for implementation
- Next steps checklist

**Best for**: Quick reference during development, color picking, and checking implementation status

---

## Quick Start Guide

### Step 1: Review the Design
Read **INTEGRATIONS_DESIGN.md** to understand the layout, components, and styling approach.

### Step 2: Plan Architecture
Follow **INTEGRATIONS_COMPONENT_STRUCTURE.md** to decide on:
- Component hierarchy
- CSS approach (Modules, BEM, or Tailwind)
- SVG handling strategy
- TypeScript prop types

### Step 3: Implement
Use **INTEGRATIONS_QUICK_REFERENCE.md** as a checklist:
- [ ] Copy CSS variables
- [ ] Create Badge component
- [ ] Create MemoryBanner component
- [ ] Create ChatMessage component
- [ ] Implement Tallei pill with pulse animation
- [ ] Set up responsive breakpoints
- [ ] Test hover/active states

---

## Design Highlights

### Layout
- **Split-screen**: 40% / 1fr (left hero vs. right mockup)
- **Responsive**: Uses `clamp()` for fluid typography
- **Spacing**: 72px gap, 80px body padding (desktop)

### Color Theme
- **Primary accent**: `oklch(50% 0.20 278)` — purple
- **Background**: `oklch(97.2% 0.010 78)` — warm cream
- **Dark theme**: `#212121` (ChatGPT mockup)
- **Supports variants**: Blue and teal accent options via color-mix

### Key Components

#### Badge System
- 38×38px white cards with light border
- Tooltip on hover (dark background, white text)
- `.logo-badge.soon` class for grayed-out "coming soon" (opacity 0.32)
- Divider line separates active (3) from upcoming (4)

#### Tallei Pill
- Subtle purple tint background
- Animated pulsing dot (2.4s, ease-in-out)
- Hover state increases background opacity
- Label: "Tallei syncing"

#### Memory Banner
- Shows context from prior Claude session
- Appears in ChatGPT mockup
- Highlights key decisions with `<em>` emphasis
- Source badge shows platform origin

#### Chat Messages
- User message (left avatar: "Y")
- ChatGPT response (SVG avatar, highlighted key point)
- Dark theme (light text on dark bg)

---

## Theme Integration Options

The design uses **purple accent** vs. the main dashboard **green** (#7eb71b):

### Option 1: Separate Page
Create `/dashboard/integrations` with dedicated CSS
- Pros: No theme conflicts, clean implementation
- Cons: Duplicate some styles from dashboard globals

### Option 2: Dashboard Theme Switch
Add purple as alternate accent color
- Pros: Reuse component structure
- Cons: Requires theme toggle UI

### Option 3: Adaptive Component
Build IntegrationsPage to accept theme prop
```tsx
<IntegrationsPage theme="purple" />
```

**Recommendation**: Option 1 (separate page) to maintain simplicity and match the design's distinct visual identity.

---

## Key Metrics Reference

| Metric | Value |
|--------|-------|
| Max-width | 1080px |
| Grid columns | 40% 1fr |
| Gap | 72px |
| Headline size | clamp(36px, 3.6vw, 50px) |
| Badge size | 38×38px |
| Pulse duration | 2.4s |
| Transition (pill) | 0.15s |
| Dark mockup BG | #212121 |
| Accent (purple) | oklch(50% 0.20 278) |

---

## SVG Assets Needed

### Platform Logos (8)
1. ChatGPT (OpenAI) — green #10a37f
2. Claude (Anthropic) — brown #d97757
3. Gemini (Google) — gradient
4. Perplexity — cyan #1fb8cd
5. OpenRouter — indigo #6366f1
6. Grok (xAI) — gray #e5e5e5
7. Claude Code — orange-brown #b5601a
8. (Future integrations)

### Icons (2)
1. Memory icon — clock hand + circle (20×20px)
2. Chat send — arrow (14×14px)

All SVG code is included in the bundled HTML file.

---

## Testing Checklist

- [ ] Badge hover shows tooltip
- [ ] Badge soon state is faded (opacity 0.32)
- [ ] Tallei dot pulses continuously (visible animation)
- [ ] Pill background changes on hover
- [ ] Thread active state visibly different
- [ ] Memory banner is readable on dark mockup BG
- [ ] Chat messages align correctly (avatar + bubble)
- [ ] Responsive: columns stack on mobile
- [ ] Headline scales with viewport (clamp)
- [ ] Colors meet WCAG contrast requirements

---

## File Locations in Project

```
/Users/dinudayaggahavita/Documents/work/tallei-ai/
├── INTEGRATIONS_INDEX.md (this file)
├── INTEGRATIONS_DESIGN.md
├── INTEGRATIONS_COMPONENT_STRUCTURE.md
├── INTEGRATIONS_QUICK_REFERENCE.md
├── dashboard/
│   └── app/
│       └── (future: integrations route)
└── src/
    └── (future: integrations components)
```

---

## Original Source

**Design file**: `/Users/dinudayaggahavita/Downloads/Tallei Integrations.html`
- Format: Bundled HTML with embedded SVG, CSS, and React-ready template
- Theme: Purple accent, warm cream background, dark mockup
- Fonts: DM Sans, DM Mono, Instrument Serif (via Google Fonts)

---

## Key Insights

1. **Invisibility is the selling point**: Tallei pill is subtle, not dominating
2. **Cross-platform memory**: Memory banner demonstrates the core value
3. **Real-world scenario**: Pricing discussion shows practical use case
4. **Future-ready**: Roadmap visible with "coming soon" badges
5. **Responsive design**: Uses modern CSS (clamp, color-mix, oklch)
6. **Performance consideration**: Animations are GPU-friendly (opacity + scale)
7. **Accessibility**: Good contrast, semantic HTML, keyboard-friendly tooltips

---

## Next Steps

1. **Set up component structure** following recommendations in INTEGRATIONS_COMPONENT_STRUCTURE.md
2. **Extract SVG assets** and organize in `/public/assets/logos/`
3. **Create CSS variables** from INTEGRATIONS_QUICK_REFERENCE.md
4. **Build components** in order: Badge → MemoryBanner → ChatMessage → Page
5. **Test responsiveness** and animation performance
6. **Integrate into dashboard** navigation (add link to /integrations)
7. **Update CLAUDE.md** with Integrations section documentation

---

## Support

For questions about:
- **Design specifications**: See INTEGRATIONS_DESIGN.md
- **Component implementation**: See INTEGRATIONS_COMPONENT_STRUCTURE.md
- **Quick lookups**: See INTEGRATIONS_QUICK_REFERENCE.md
- **Original design file**: Check `/Downloads/Tallei Integrations.html`

---

**Last Updated**: April 22, 2026
**Extracted from**: Tallei Integrations.html (bundled design)
**Format**: Complete design specification + React implementation guide
