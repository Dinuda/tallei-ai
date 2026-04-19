# Dashboard

This is the Next.js frontend for Tallei.

## Structure

- `app/` contains the active App Router routes.
- `lib/` holds client-side API helpers.
- `auth.ts` configures NextAuth for Google sign-in.
- `proxy.ts` handles route protection and redirects.

## Scripts

Run these from the `dashboard/` :

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
