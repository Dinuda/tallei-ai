# Cloud Run Production Guide

This guide documents the production deployment for this repository using two Cloud Run services:

- Dashboard: `tallei-dashboard` (serves `https://tallei.com`)
- Backend: `tallei-backend` (serves `https://api.tallei.com`)

## Read This First

- Full deployment sequence: [flow.md](/Users/dinudayaggahavita/Documents/work/tallei-ai/docs/production/cloudrun/flow.md)
- Domain and DNS details: [dns.md](/Users/dinudayaggahavita/Documents/work/tallei-ai/docs/production/cloudrun/dns.md)
- Failure playbook: [troubleshooting.md](/Users/dinudayaggahavita/Documents/work/tallei-ai/docs/production/cloudrun/troubleshooting.md)

## Scripts Used

All scripts are in [`deploy/cloudrun/`](/Users/dinudayaggahavita/Documents/work/tallei-ai/deploy/cloudrun):

- `add-secret-versions.sh`: hidden-input secret value entry.
- `verify-secrets.sh`: validates secret IDs, latest versions, and IAM access.
- `deploy-backend.sh`: backend image build + deploy.
- `deploy-dashboard.sh`: dashboard image build + deploy.

## Important Convention

Secret-related environment variables in deploy scripts are Secret Manager IDs, not raw secret values.  
Example:

```bash
export INTERNAL_API_SECRET="INTERNAL_API_SECRET"
```

Not:

```bash
export INTERNAL_API_SECRET="actual-secret-value"
```
