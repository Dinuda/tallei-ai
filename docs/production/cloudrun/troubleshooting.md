# Troubleshooting

This page captures the most common production failures from this deployment.

## `Permission denied on secret ...`

Typical error:

```text
The service account used must be granted roles/secretmanager.secretAccessor
```

Cause:

- Secret exists but service account cannot read it.
- Or a service got a wrong secret reference.

Fix:

```bash
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --project actionlog-487112 \
  --member "serviceAccount:<service-account-email>" \
  --role "roles/secretmanager.secretAccessor"
```

Use verifier:

```bash
PROJECT_ID="actionlog-487112" \
SERVICE_ACCOUNT="<service-account-email>" \
./deploy/cloudrun/verify-secrets.sh SECRET_NAME
```

## `Invalid ... expected Secret Manager secret name`

Cause:

- Deployer exported raw secret value instead of Secret Manager ID.

Wrong:

```bash
export OPENAI_API_KEY="sk-..."
```

Correct:

```bash
export OPENAI_API_KEY="OPENAI_API_KEY"
```

Add actual values with:

```bash
PROJECT_ID="actionlog-487112" ./deploy/cloudrun/add-secret-versions.sh OPENAI_API_KEY
```

## `Missing required env var: MEMORY_MASTER_KEY`

Cause:

- Backend deploy now requires `MEMORY_MASTER_KEY` as a Secret Manager ID.

Fix:

```bash
export MEMORY_MASTER_KEY="MEMORY_MASTER_KEY"
PROJECT_ID="actionlog-487112" ./deploy/cloudrun/verify-secrets.sh MEMORY_MASTER_KEY
```

## `Missing required env var: GOOGLE_CLIENT_SECRET`

Cause:

- Dashboard deploy requires Google OAuth client secret as a Secret Manager ID.

Fix:

```bash
export GOOGLE_CLIENT_SECRET="GOOGLE_CLIENT_SECRET"
PROJECT_ID="actionlog-487112" ./deploy/cloudrun/verify-secrets.sh GOOGLE_CLIENT_SECRET
```

## Backend deploy unexpectedly uses dashboard service account

Cause:

- Stale shell vars.

Fix:

Use service-specific vars:

- `BACKEND_SERVICE_ACCOUNT` for backend deploy.
- `DASHBOARD_SERVICE_ACCOUNT` for dashboard deploy.

Clear ambiguous vars:

```bash
unset SERVICE_ACCOUNT SERVICE_NAME
```

## Vertex document search auth and runtime verification (production)

Use this checklist when Vertex indexing/search does not appear in production logs.

Known deployment values:
- `PROJECT_ID=actionlog-487112`
- `REGION=us-central1`
- `SERVICE_NAME=tallei-backend`

### 1) Confirm backend runtime service account

```bash
gcloud run services describe tallei-backend \
  --region us-central1 \
  --project actionlog-487112 \
  --format='value(spec.template.spec.serviceAccountName)'
```

### 2) Confirm service account has Discovery Engine permissions

```bash
gcloud projects get-iam-policy actionlog-487112 \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:tallei-dashboard-sa@actionlog-487112.iam.gserviceaccount.com" \
  --format="table(bindings.role)"
```

Ensure a Discovery Engine role is present (for example `roles/discoveryengine.editor`).

If missing:

```bash
gcloud projects add-iam-policy-binding actionlog-487112 \
  --member="serviceAccount:tallei-dashboard-sa@actionlog-487112.iam.gserviceaccount.com" \
  --role="roles/discoveryengine.editor"
```

### 3) Confirm required APIs are enabled

```bash
gcloud services list --enabled --project actionlog-487112 \
  --filter="name:discoveryengine.googleapis.com OR name:aiplatform.googleapis.com"
```

### 4) Confirm backend Vertex env vars on the active revision

```bash
gcloud run services describe tallei-backend \
  --region us-central1 \
  --project actionlog-487112 \
  --format='json(spec.template.spec.containers[0].env)'
```

Verify:
- `TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH=true`
- `TALLEI_VERTEX_SEARCH__DATA_STORE=...`
- `TALLEI_VERTEX_SEARCH__SERVING_CONFIG=...`
- `TALLEI_GOOGLE__PROJECT_ID=actionlog-487112` (or your intended project)

### 5) Runtime smoke-check signals

After uploading a test document and calling `prepare_response` with an `@doc:` query, logs should include:
- `event: "document_search_route_decision"` with `mode: "vertex"`
- `event: "vertex_document_search"` with `status: "success"`
- `event: "vertex_document_index"` for new/updated docs

If `mode` is `legacy`, inspect the `reason` field in `document_search_route_decision` and adjust flags/allowlists.

## Dashboard `/mcp` proxies to `127.0.0.1:3000` in production

Typical logs:

```text
Failed to proxy http://127.0.0.1:3000/mcp ECONNREFUSED
```

Cause:

- Rewrite target resolved to local fallback at build/runtime.

Fix already applied in code:

- [`dashboard/next.config.ts`](../../../dashboard/next.config.ts)
- [`dashboard/Dockerfile`](../../../dashboard/Dockerfile)

Redeploy dashboard with:

```bash
export API_PROXY_TARGET="https://api.tallei.com"
export BACKEND_URL="https://api.tallei.com"
./deploy/cloudrun/deploy-dashboard.sh
```

## Domain mapping stuck in `CertificatePending`

Cause:

- DNS records not matching Cloud Run mapping output.
- DNS not propagated yet.
- Old host records still present.

Fix:

1. Check authoritative nameservers first.
2. Ensure apex A/AAAA records match Cloud Run exactly.
3. Ensure `api` CNAME points to `ghs.googlehosted.com.`.
4. Wait for propagation and retry.

## `zsh: command not found: watch`

`watch` is not installed by default on macOS.

Use loop:

```bash
while true; do
  date
  dig +short @8.8.8.8 tallei.com A
  dig +short @8.8.8.8 api.tallei.com CNAME
  sleep 60
done
```
