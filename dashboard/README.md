# Dashboard

This is the Next.js frontend for Tallei.

## Structure

- `app/` contains the active App Router routes.
- `lib/` holds client-side API helpers.
- `auth.ts` configures NextAuth for Google sign-in.
- `proxy.ts` handles route protection and redirects.

## Scripts

Run these from the `dashboard/` directory:

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Notes

- The committed app tree lives in `dashboard/app/`.
- `dashboard/src/app/` was removed because it was a stale scaffold copy.
