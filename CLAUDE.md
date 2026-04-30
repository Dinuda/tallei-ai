# Tallei — Claude Project Guide

## Overview
Tallei is a cross-AI ghost memory system that bridges Claude, ChatGPT, and Gemini via:
- **MCP server** (Node.js/Express backend) — handles memory save/recall via vector search
- **Next.js dashboard** — UI for managing memories and OAuth connector setup
- **PostgreSQL + pgvector** — persistent vector store with mem0ai SDK
- **OpenAI** — embeddings (text-embedding-3-small) and summarization (gpt-4o-mini)

**Primary goal**: Make memory I/O blazingly fast so Claude's MCP tools never block.

---

## Architecture & Key Files

### Backend (`src/`)
| Path | Purpose |
|------|---------|
| `src/index.ts` | Express server entry point |
| `src/mcp/server.ts` | MCP tool definitions + OAuth auth; token caching + scope checks |
| `src/services/memory.ts` | Singleton Memory instance, fire-and-forget saves, recall cache |
| `src/services/summarizer.ts` | OpenAI gpt-4o-mini summarization (title, key points, decisions) |
| `src/services/auth.ts` | Google OAuth + session JWT for dashboard auth |
| `src/routes/*.ts` | HTTP route handlers |
| `src/db/index.ts` | PostgreSQL connection pool & schema init |

### Frontend (`dashboard/`)
| Path | Purpose |
|------|---------|
| `dashboard/app/globals.css` | **NEW THEME**: light greenish-yellow, lime accent (#7eb71b), DM Sans + Plus Jakarta Sans fonts |
| `dashboard/app/layout.tsx` | Root layout (with Providers, TopNav from linter) |
| `dashboard/app/page.tsx` | Landing page — hero, feature grid, decorative radial blobs |
| `dashboard/app/(auth)/login/page.tsx` | Google OAuth login card |
| `dashboard/app/dashboard/setup/page.tsx` | **Step-by-step connector wizard** — 4-step flow with progress dots, auto-advance on copy |
| `dashboard/app/dashboard/page.tsx` | Memory feed with search, platform color badges, shimmer skeleton |
| `dashboard/app/dashboard/keys/page.tsx` | API key deprecation notice (OAuth migration) |
| `dashboard/app/dashboard/layout.tsx` | Sidebar nav + topbar, uses next-auth signOut |
| `dashboard/lib/api.ts` | API URL builder, `mcpServerUrl()` helper |

---

## Core Performance Optimizations (Recent)

### Memory Service (`src/services/memory.ts`)
- **Singleton Memory instance**: Reused across all requests; was creating new instances (re-initializing connections) on every call
- **Fire-and-forget `saveMemory()`**: Returns immediately with stub; heavy work (summarize → embed → store) runs in background
  - **Result**: `save_memory` MCP tool now ~10ms latency (was 2–4s)
- **Recall result cache (60s TTL)**: Vector search results cached per `(userId, query, limit)`; invalidates on new saves
  - **Result**: `recall_memories` ~5ms on warm cache (was 300–500ms on every call)

### MCP Server (`src/mcp/server.ts`)
- **OAuth token cache (10min TTL)**: `oauthVerifier.verifyAccessToken()` results cached per token
  - **Result**: Avoids repeated crypto/DB verification on every request

**When adding new MCP tools**: Always consider caching if the operation hits OpenAI, a vector DB, or repeats frequently within a short window.

---

## Design System (New Theme)

### Colors
- **Background**: `#f8fdf2` (off-white, very pale yellow-green)
- **Surface/Cards**: `#ffffff` (pure white)
- **Accent**: `#7eb71b` (lime green) — used for primary buttons, active states, highlights
- **Text primary**: `#182506` (dark green)
- **Text secondary**: `#3d5c18` (muted green)
- **Text muted**: `#7a9a4a` (lighter green)
- **Border light**: `#e4f5c6` (very pale lime)
- **Border**: `#cce89e` (pale lime)

### Fonts
- **Display/Headlines** (`h1`–`h3`): `DM Sans` 700–800 wt
- **Body/UI**: `Plus Jakarta Sans` 400–600 wt

### Common CSS Variables
```css
--bg: #f8fdf2
--surface: #ffffff
--accent: #7eb71b
--accent-hover: #6aa015
--accent-light: #e6f5c8
--accent-dim: #cde99a
--text: #182506
--text-2: #3d5c18
--text-muted: #7a9a4a
--border: #cce89e
--border-light: #e4f5c6
--radius-md: 14px
--radius-lg: 20px
```

### Card/Button patterns
- Cards: `background: var(--surface)`, `border: 1px solid var(--border-light)`, `box-shadow: var(--shadow-sm)`, rounded `var(--radius-lg)`
- Primary buttons: `background: var(--accent)`, white text, shadow with accent glow
- On hover: buttons lift (`translateY(-1px)`), cards lift slightly, shadows deepen
- Form inputs: `background: var(--surface)`, `border: var(--border)`, focus ring is `3px rgba(126,183,27,.18)`

---

## Common Tasks

### Adding a new MCP tool
1. Define the tool in `src/mcp/server.ts` in `buildMcpServer()`
2. Implement the handler in `src/services/` (or inline if very simple)
3. **Consider caching**: If the handler hits OpenAI, pgvector, or repeats frequently, cache results
4. Return results as `{ content: [{ type: "text", text: "..." }] }` or error

### Adding a new API route
1. Create a new route file in `src/routes/` (e.g., `src/routes/custom.ts`)
2. Export a Router instance
3. Wire it into `src/index.ts` with `app.use("/api/custom", customRouter)`
4. For auth: use `authMiddleware` + `requireScopes([...])` in route handlers

### Updating the dashboard theme
- Edit `dashboard/app/globals.css` CSS variables at the top
- All color, radius, shadow, and animation settings flow through variables
- Fonts are imported at the top; add new Google Fonts imports there

### Deploying the MCP server
- The MCP server is hosted at `process.env.NEXT_PUBLIC_API_BASE_URL` + `/mcp`
- Must be **publicly reachable over HTTPS** for Claude.ai connectors
- Users copy the MCP URL from `/dashboard/setup` and paste it into Claude settings

---

## Key Constraints & Conventions

### Turn Protocol (Critical)

**First turn:** Call `recall_memories` reflexively to load previous context, preferences, and memories. This is the ONLY reflexive recall.

**Subsequent turns:** Do NOT call `recall_memories` reflexively. Only call when the user references prior sessions or the task requires past context.

### Save & Checkpoint Protocol

- **Conversation checkpoints:** When user says "save"/"checkpoint", or you produced substantial output (>800 chars) or structured content, save a `document-note` titled "Conversation checkpoint" with the full transcript.
- **Auto-save:** For new structured content (files, lists, tables), call `remember(kind="document-note")` without asking. Append footer: `📎 Auto-saved as @doc:<ref> · reply **undo** to delete`
- **Undo:** If user replies "undo"/"del" after footer, call `undo_save` with the ref.

### Collab Tasks Protocol (Critical)

**Existing task:** If user says `continue/resume/proceed task <uuid>` or includes a task UUID, call `collab_check_turn` first. Do NOT call `recall_memories` for collab state.

**New task:** Before creating:
1. **Role Approval Gate:** Propose roles, get explicit "yes" before proceeding.
2. **Iteration Roadmap:** After approval, show numbered turns + deliverables + done criteria. Include constraint: text/PDF/code only, no PPTX or images.
3. Then create the task.

**Visible Handoffs:** After every output, never say just "continue task". State: (a) who is next, (b) exactly what they will do, (c) continue command. After every `collab_take_turn`, show the FULL submitted output visibly in Claude's chat first, then brief summary, then handoff. Never replace the submitted output with a summary-only bullet list.

### Don't Break Memory Performance
- The fire-and-forget pattern in `saveMemory()` is intentional: never await the full pipeline in the MCP handler
- If adding new summarization or preprocessing steps, keep them in the background worker, not the foreground response
- Test MCP tool latency with `curl` to ensure responses are sub-100ms

### Naming conventions
- **MCP tool names**: snake_case (e.g., `save_memory`, `recall_memories`)
- **API routes**: kebab-case paths (e.g., `/api/memories`, `/api/api-keys`)
- **React components**: PascalCase
- **CSS class names**: kebab-case (e.g., `.step-card`, `.memory-feed`)

### Git & commits
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `perf:`
- Large features go on feature branches; merge via PR
- **Important**: After merging UI changes, run `npx tsc --noEmit` in `dashboard/` to catch TS errors

### Linting & formatting
- Dashboard uses Next.js defaults (no explicit ESLint config shown, but assume standard rules apply)
- Backend has no linting configured yet — consider adding if style becomes inconsistent

---

## Environment Variables

### Backend (`.env`)
```
DATABASE_URL=postgresql://...
OPENAI_API_KEY=sk-...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
JWT_SECRET=<random-secret>
```

### Frontend (`.env.local` or via build)
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000  # or production URL
```

---

## Testing & Debugging

### MCP tools
Test directly via curl:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <oauth_access_token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall_memories","arguments":{"query":"user preferences","limit":5}}}'
```

### Dashboard
```bash
cd dashboard && npm run dev
# http://localhost:3000
```

### Memory operations
Look at `src/services/memory.ts` cache validity:
- If recalls feel slow: check if cache is expiring too quickly (60s TTL) or if recalls are cache-missing frequently
- If saves are slow: the background worker may be stalled; check `console.error` logs for OpenAI/pgvector failures

---

## Future Improvements
- [ ] Add background job queue (Bull, Inngest) for more reliable memory persistence instead of fire-and-forget
- [ ] Implement incremental recall: stream partial results while vector search completes
- [ ] Add memory editing UI (delete only exists now)
- [ ] Support for custom summarization prompts per user
- [ ] Rate limiting on MCP tools to prevent abuse
- [ ] Audit logging for memory access
