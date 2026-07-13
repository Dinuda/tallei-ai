# Dashboard

This is the Next.js frontend for Tallei.

## Structure

- `app/` contains the active App Router routes.
- `lib/` holds client-side API helpers.
- `auth.ts` configures NextAuth for Google sign-in.
- `proxy.ts` handles route protection and redirects.

## Scripts

This repo uses **npm workspaces** (root `package.json`). Install from the **repo root**, not with a lone `pnpm install` inside `dashboard/` — that breaks hoisted `next` and `@tallei/*` links and causes Turbopack “next/package.json not found” / `next/app.js` errors.

From the repo root:

```bash
npm install --legacy-peer-deps
npm run build:packages
npm run dev -w dashboard
```

Or after a root install, from `dashboard/`:

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Environment

Use [`dashboard/.env.example`](./.env.example) as the template for local dashboard configuration.

## Notes

- The committed app tree lives in `dashboard/app/`.
- `dashboard/src/app/` was removed because it was a stale scaffold copy.
- `next.config.ts` sets `turbopack.root` and `outputFileTracingRoot` to the monorepo root so hoisted `next` resolves under npm workspaces.
