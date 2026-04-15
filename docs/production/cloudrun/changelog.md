# Production Changelog

Use this file to record every production push for the Cloud Run deployment.

Keep entries newest-first. Each entry should include:

- Date
- Services changed
- Summary of what shipped
- Notes about rollout or follow-up

## 2026-04-15

- Services changed: `tallei-dashboard`, `tallei-backend`
- Summary:
  - Split the app into separate Cloud Run services for dashboard and backend.
  - Added Dockerfiles and deploy scripts for each service.
  - Added Secret Manager flows for interactive secret versioning and verification.
  - Added custom-domain mapping for `tallei.com` and `api.tallei.com`.
  - Fixed dashboard production proxy behavior so `/mcp` targets `https://api.tallei.com` instead of localhost.
  - Added production env flags for graph extraction and recall v2.
- Notes:
  - Backend now requires `MEMORY_MASTER_KEY`.
  - Dashboard deploy now requires Google OAuth config and secrets.
  - DNS must point to Cloud Run records before certificate issuance completes.

## Entry Template

```md
## YYYY-MM-DD

- Services changed: `service-a`, `service-b`
- Summary:
  - What changed.
  - What was deployed.
- Notes:
  - Rollout caveats, follow-ups, or links to issues.
```
