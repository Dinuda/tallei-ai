# Cloud Run Flow (Step-by-step)

This is the end-to-end production flow used for `tallei.com` and `api.tallei.com`.

## 1) Prerequisites

```bash
gcloud auth login
gcloud config set project actionlog-487112
gcloud config set run/region us-central1
```

Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

## 2) Service Accounts

```bash
PROJECT_ID="actionlog-487112"

gcloud iam service-accounts create tallei-backend-sa \
  --project "$PROJECT_ID" \
  --display-name "Tallei Backend Service Account"

gcloud iam service-accounts create tallei-dashboard-sa \
  --project "$PROJECT_ID" \
  --display-name "Tallei Dashboard Service Account"
```

## 3) Secrets

Add/update versions interactively:

```bash
PROJECT_ID="actionlog-487112" ./deploy/cloudrun/add-secret-versions.sh \
  INTERNAL_API_SECRET OPENAI_API_KEY JWT_SECRET MEMORY_MASTER_KEY NEXTAUTH_SECRET GOOGLE_CLIENT_SECRET
```

Grant IAM:

```bash
BACKEND_SA="tallei-backend-sa@actionlog-487112.iam.gserviceaccount.com"
DASHBOARD_SA="tallei-dashboard-sa@actionlog-487112.iam.gserviceaccount.com"

for s in INTERNAL_API_SECRET OPENAI_API_KEY JWT_SECRET MEMORY_MASTER_KEY GOOGLE_CLIENT_SECRET; do
  gcloud secrets add-iam-policy-binding "$s" \
    --project actionlog-487112 \
    --member "serviceAccount:${BACKEND_SA}" \
    --role "roles/secretmanager.secretAccessor"
done

for s in INTERNAL_API_SECRET NEXTAUTH_SECRET GOOGLE_CLIENT_SECRET; do
  gcloud secrets add-iam-policy-binding "$s" \
    --project actionlog-487112 \
    --member "serviceAccount:${DASHBOARD_SA}" \
    --role "roles/secretmanager.secretAccessor"
done
```

Verify before deploy:

```bash
PROJECT_ID="actionlog-487112" \
SERVICE_ACCOUNT="$BACKEND_SA" \
./deploy/cloudrun/verify-secrets.sh INTERNAL_API_SECRET OPENAI_API_KEY JWT_SECRET MEMORY_MASTER_KEY

PROJECT_ID="actionlog-487112" \
SERVICE_ACCOUNT="$DASHBOARD_SA" \
./deploy/cloudrun/verify-secrets.sh INTERNAL_API_SECRET NEXTAUTH_SECRET GOOGLE_CLIENT_SECRET
```

## 4) Deploy Backend

```bash
export PROJECT_ID="actionlog-487112"
export REGION="us-central1"
export BACKEND_SERVICE_NAME="tallei-backend"
export BACKEND_SERVICE_ACCOUNT="tallei-backend-sa@actionlog-487112.iam.gserviceaccount.com"

export PUBLIC_BASE_URL="https://api.tallei.com"
export FRONTEND_URL="https://tallei.com"
export DASHBOARD_BASE_URL="https://tallei.com"
export MCP_URL="https://api.tallei.com/mcp"
export DATABASE_URL="postgresql://..."
export DATABASE_URL_FALLBACK="$DATABASE_URL"
export SUPABASE_URL="https://<project>.supabase.co"
export REDIS_URL="redis://..."
export QDRANT_URL="https://..."
export QDRANT_COLLECTION_NAME="memories_v1"
export GOOGLE_CLIENT_ID="..."
export GOOGLE_REDIRECT_URI="https://api.tallei.com/api/auth/google/callback"

export INTERNAL_API_SECRET="INTERNAL_API_SECRET"
export OPENAI_API_KEY="OPENAI_API_KEY"
export JWT_SECRET="JWT_SECRET"
export GOOGLE_CLIENT_SECRET="GOOGLE_CLIENT_SECRET"
export QDRANT_API_KEY="QDRANT_API_KEY"
export SUPABASE_SERVICE_ROLE_KEY="SUPABASE_SERVICE_ROLE_KEY"
export MEMORY_MASTER_KEY="MEMORY_MASTER_KEY"

./deploy/cloudrun/deploy-backend.sh
```

## 5) Deploy Dashboard

```bash
unset BACKEND_SERVICE_NAME BACKEND_SERVICE_ACCOUNT
unset OPENAI_API_KEY JWT_SECRET SUPABASE_SERVICE_ROLE_KEY QDRANT_API_KEY MEMORY_MASTER_KEY

export DASHBOARD_SERVICE_NAME="tallei-dashboard"
export DASHBOARD_SERVICE_ACCOUNT="tallei-dashboard-sa@actionlog-487112.iam.gserviceaccount.com"

export NEXTAUTH_URL="https://tallei.com"
export AUTH_URL="https://tallei.com"
export AUTH_TRUST_HOST="true"
export NEXT_PUBLIC_APP_URL="https://tallei.com"
export BACKEND_URL="https://api.tallei.com"
export API_PROXY_TARGET="https://api.tallei.com"
export GOOGLE_CLIENT_ID="..."

export INTERNAL_API_SECRET="INTERNAL_API_SECRET"
export NEXTAUTH_SECRET="NEXTAUTH_SECRET"
export GOOGLE_CLIENT_SECRET="GOOGLE_CLIENT_SECRET"

./deploy/cloudrun/deploy-dashboard.sh
```

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are required for dashboard auth.

## 6) Domain Mappings

```bash
gcloud beta run domain-mappings create \
  --project actionlog-487112 \
  --region us-central1 \
  --service tallei-dashboard \
  --domain tallei.com

gcloud beta run domain-mappings create \
  --project actionlog-487112 \
  --region us-central1 \
  --service tallei-backend \
  --domain api.tallei.com
```

Then configure DNS from mapping output. See [dns.md](./dns.md).

## 7) Post-deploy Checks

```bash
gcloud run services describe tallei-backend --project actionlog-487112 --region us-central1 --format="yaml(status.conditions,status.latestReadyRevisionName)"
gcloud run services describe tallei-dashboard --project actionlog-487112 --region us-central1 --format="yaml(status.conditions,status.latestReadyRevisionName)"
```

```bash
curl -i https://api.tallei.com/health
curl -i https://tallei.com/health
```
