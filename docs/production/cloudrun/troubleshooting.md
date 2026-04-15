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
