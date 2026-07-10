# Dashboard — Claude Project Guide

See also [AGENTS.md](./AGENTS.md) for Next.js 16-specific agent rules.

## Overview

Next.js 16 dashboard for Tallei memory product. Proxies most `/api/*` and `/mcp` traffic to the Express backend; keeps a small set of local API routes.

## Live routes

| Route | File | Purpose |
|-------|------|---------|
| `/dashboard` | `app/dashboard/page.tsx` | Memory feed |
| `/dashboard/documents` | `app/dashboard/documents/page.tsx` | Document library |
| `/dashboard/setup` | `app/dashboard/setup/page.tsx` | MCP connector wizard |
| `/dashboard/billing` | `app/dashboard/billing/page.tsx` | Billing |
| `/dashboard/memory-cleanup` | `app/dashboard/memory-cleanup/page.tsx` | Cleanup admin |
| `/dashboard/mcp-events` | `app/dashboard/mcp-events/page.tsx` | MCP activity log |
| `/dashboard/memory` | `app/dashboard/memory/page.tsx` | Redirects to `/dashboard` |

Public marketing: `app/(public)/page.tsx`, `app/(public)/home-content.tsx`.

## Nav vs routes

[`app/dashboard/layout.tsx`](app/dashboard/layout.tsx) sidebar includes:

- **Implemented:** Memories, Documents, AI Assistants (`/dashboard/setup`), Billing, Memory Cleanup, Activity
- **Nav only (no page yet):** Channels (`/dashboard/channels`), Connected Apps (`/dashboard/integrations`)

Do not document removed loop/conductor pages (`/dashboard/loops`, etc.).

## API proxy pattern

[`next.config.ts`](next.config.ts) rewrites:

- **Local handlers** (not proxied): `collab`, `tasks`, `developer`, `documents`, `integrations`, `channels`, `billing`, `memories`, `keys`, `mcp-events`, NextAuth routes
- **Everything else under `/api/*`** → backend (`API_PROXY_TARGET` / `BACKEND_URL`)
- `/mcp`, `/health`, OAuth discovery (`/.well-known/*`, `/token`, `/register`) → backend

## Reusable UI kit (kept for rebuild)

| Path | Contents |
|------|----------|
| `src/components/ai-elements/` | Conversation, message, prompt-input, tool, reasoning, canvas, interactive-prompt-menu |
| `src/components/ui/` | shadcn-style primitives (button, card, dialog, etc.) |

Safe to extend for a future conductor rebuild. Conductor-specific components were removed.

## Theme

Edit CSS variables at the top of [`app/globals.css`](app/globals.css):

- Background: `#f8fdf2`, accent: `#7eb71b`
- Fonts: DM Sans (display), Plus Jakarta Sans (body)

## Dev commands

```bash
cd dashboard
npm run dev          # http://localhost:3001
npx tsc --noEmit     # typecheck after UI changes
npm run build
```

Root workspace install covers dashboard deps: `npm install --legacy-peer-deps` from repo root.

## Related docs

- [Root CLAUDE.md](../CLAUDE.md)
- [setup.md](../setup.md)
- [docs/product-scope.md](../docs/product-scope.md)
