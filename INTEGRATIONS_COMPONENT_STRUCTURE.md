# React Component Structure for Integrations Section

## Recommended Component Hierarchy

```
IntegrationsPage
├── Container (.wrap)
├── LeftSection (.left)
│   ├── Eyebrow / Label
│   ├── Headline (h1)
│   ├── Subheading
│   └── PlatformBadgesSection
│       ├── BadgesLabel
│       └── BadgeRow
│           ├── Badge (ChatGPT)
│           ├── Badge (Claude)
│           ├── Badge (Gemini)
│           ├── Divider
│           ├── Badge (Perplexity - soon)
│           ├── Badge (Claude Code - soon)
│           ├── Badge (OpenRouter - soon)
│           └── Badge (Grok - soon)
│       └── SoonNote
└── RightSection (.right)
    └── ChatGPTMockup
        ├── ChromeBar
        │   ├── LogoSection
        │   └── ModelBadge + TalleiPill
        └── ChatGPTBody
            ├── Sidebar
            │   ├── SidebarLabel
            │   └── ThreadList
            │       ├── Thread (hover/active states)
            │       ├── Thread
            │       ├── Thread
            │       ├── Thread
            │       └── Thread
            └── MainContent
                ├── MemoryBanner
                │   ├── MemoryIcon
                │   ├── MemoryHeading
                │   ├── SourceBadge (Claude)
                │   └── MemoryBody
                ├── ChatArea
                │   ├── Message (user)
                │   └── Message (ChatGPT response)
                └── ChatInputRow
                    ├── InputText
                    └── SendButton
```

## Component Props & Data Structure

### Badge Component
```typescript
interface BadgeProps {
  logoId: string;           // e.g. "logo-chatgpt"
  tooltip: string;          // e.g. "ChatGPT"
  isSoon?: boolean;        // grayed out if true
  size?: 'sm' | 'md';      // 38px default
}
```

### Thread Component
```typescript
interface ThreadProps {
  text: string;
  isActive?: boolean;
  onClick?: () => void;
}
```

### Message Component
```typescript
interface MessageProps {
  type: 'user' | 'assistant';
  content: string;          // or React node
  avatarLabel?: string;     // 'Y', 'ChatGPT' emoji
}
```

### MemoryBanner Component
```typescript
interface MemoryBannerProps {
  title: string;
  sourceLogoId: string;     // e.g. "logo-claude"
  sourceName: string;       // e.g. "Claude"
  content: string;          // Rich content with emphasis
}
```

## CSS Architecture

### Global Styles
- Reset: `* { margin: 0; padding: 0; box-sizing: border-box; }`
- Body: flexbox center, padding, font setup
- Root CSS variables (--bg, --surface, --ink, --accent, etc.)

### Component Scoping
Option 1: CSS Modules per component
```
IntegrationsPage.module.css
ChromeBar.module.css
MemoryBanner.module.css
etc.
```

Option 2: BEM convention in single file
```css
.integrations {}
.integrations__left {}
.integrations__eyebrow {}
.integrations__badges {}
.integrations__badge {}
.integrations__badge--soon {}
.integrations__right {}
.integrations__mock-shell {}
.gpt-chrome {}
.gpt-chrome__left {}
.gpt-chrome__logo {}
.tallei-pill {}
.tallei-pill__dot {}
.memory-banner {}
.memory-banner__icon {}
.memory-banner__heading {}
.chat-area {}
.msg {}
.msg__avatar {}
.msg__bubble {}
```

Option 3: Tailwind + custom CSS variables (hybrid)
- Use Tailwind for layout/spacing
- Use CSS variables for theming
- Custom CSS for animations

## SVG Asset Handling

### Option 1: SVG Sprite Sheet (Current Design)
```tsx
// SVGSprites.tsx
export const SVGSprites = () => (
  <svg style={{ display: 'none' }} xmlns="http://www.w3.org/2000/svg">
    <symbol id="logo-chatgpt" viewBox="0 0 24 24">
      {/* paths */}
    </symbol>
    {/* ... more symbols */}
  </svg>
);

// Usage:
<svg viewBox="0 0 24 24"><use href="#logo-chatgpt" /></svg>
```

### Option 2: Import SVG Files
```tsx
import ChatGPTLogo from '@/assets/logos/chatgpt.svg';

<img src={ChatGPTLogo} alt="ChatGPT" width={20} height={20} />
// or
<ChatGPTLogo width={20} height={20} />
```

### Option 3: React Icon Library
```tsx
import { FaOpenai } from 'react-icons/fa';
<FaOpenai size={20} color="#10a37f" />
```

## Dark Theme Implementation

Since mockup uses dark theme (#212121), options:
1. Extract to separate `integrations-dark.css` component
2. Use CSS custom properties + class toggle
3. Use Next.js built-in dark mode with Tailwind

Example:
```tsx
export const ChatGPTMockup = ({ darkMode = true }) => (
  <div className={darkMode ? 'mock-shell dark' : 'mock-shell'}>
    {/* ... */}
  </div>
);
```

```css
.mock-shell {
  background: var(--surface);
  color: var(--ink);
}

.mock-shell.dark {
  background: #212121;
  color: #ececec;
}

.mock-shell.dark .gpt-chrome {
  background: #212121;
}
```

## Data / Props Shape

### Integrations Page Data
```typescript
type IntegrationsPageData = {
  section: 'integrations';
  headline: {
    text: string;
    emphasis: string;  // "them in sync" part
  };
  subheading: string;
  platforms: {
    active: Badge[];     // ChatGPT, Claude, Gemini
    upcoming: Badge[];   // Perplexity, Grok, etc.
  };
  mockup: {
    appName: 'ChatGPT';
    model: 'GPT-4o';
    threads: Thread[];
    memoryBanner: MemoryBanner;
    chat: Message[];
  };
};
```

## Animation Keyframes

```css
@keyframes pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.8);
  }
}

/* Applied to .tallei-dot */
.tallei-dot {
  animation: pulse 2.4s ease-in-out infinite;
}
```

## Responsive Considerations

### Breakpoints
Based on current design using `clamp()`:
- Headline scales: `clamp(36px, 3.6vw, 50px)`
- Consider adding mobile breakpoint for 2-col → 1-col stack

```css
@media (max-width: 768px) {
  .wrap {
    grid-template-columns: 1fr;
    gap: 48px;
  }
  
  .right {
    /* scale mockup or hide on small screens */
    transform: scale(0.8);
    transform-origin: top center;
  }
}
```

## Testing Approach

### Component Tests
```typescript
describe('Badge', () => {
  it('renders logo SVG', () => {});
  it('shows tooltip on hover', () => {});
  it('applies .soon class for upcoming badges', () => {});
});

describe('MemoryBanner', () => {
  it('renders source logo and name', () => {});
  it('highlights emphasized text in memory body', () => {});
});

describe('IntegrationsPage', () => {
  it('renders left and right sections', () => {});
  it('shows 3 active badges and divider before 4 upcoming', () => {});
});
```

### E2E / Visual Tests
- Hover states on badges (tooltip)
- Tallei pill pulse animation
- Responsive layout shift at breakpoints

## Migration Notes for Existing Tallei Dashboard

The design uses a different theme (purple + warm cream) vs. current Tallei green (#7eb71b).

Options:
1. **Create as separate page** at `/integrations` route with its own styling
2. **Integrate into existing theme** by adapting to current green palette
3. **Add theme toggle** to support multiple accent colors (purple, green, blue, teal)

Given the design's emphasis on Tallei being "invisible," consider:
- Create `/dashboard/integrations` as a marketing/education page
- Keep existing dashboard pages on current green theme
- Show this mockup as "how Tallei works in ChatGPT" educational content

