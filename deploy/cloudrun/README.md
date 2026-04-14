# Google Cloud Run Deployment (Secure + Custom Domains)

This setup deploys two Cloud Run services:

- `tallei-dashboard` on `app.<your-domain>`
- `tallei-backend` on `api.<your-domain>`

This split keeps routing simple and secure while preserving your current architecture.

## 1) Prerequisites

- `gcloud` CLI installed and authenticated
- A Google Cloud project with billing enabled
- A domain you control

Enable required APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

## 2) Create service accounts (least privilege)

```bash
PROJECT_ID="your-project-id"

gcloud iam service-accounts create tallei-backend-sa \
  --project "$PROJECT_ID" \
  --display-name "Tallei Backend Service Account"

gcloud iam service-accounts create tallei-dashboard-sa \
  --project "$PROJECT_ID" \
  --display-name "Tallei Dashboard Service Account"
```

Grant only secret access needed for runtime:

```bash
BACKEND_SA="tallei-backend-sa@${PROJECT_ID}.iam.gserviceaccount.com"
DASHBOARD_SA="tallei-dashboard-sa@${PROJECT_ID}.iam.gserviceaccount.com"
```

After creating secrets in the next step, bind secret accessor role per secret:

```bash
gcloud secrets add-iam-policy-binding INTERNAL_API_SECRET \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${BACKEND_SA}" \
  --role "roles/secretmanager.secretAccessor"
```

Repeat for each secret consumed by each service account.

## 3) Create secrets in Secret Manager

Example:

```bash
printf '%s' 'super-long-random-value' | gcloud secrets create INTERNAL_API_SECRET \
  --project "$PROJECT_ID" \
  --replication-policy "automatic" \
  --data-file=-

printf '%s' 'sk-...' | gcloud secrets create OPENAI_API_KEY \
  --project "$PROJECT_ID" \
  --replication-policy "automatic" \
  --data-file=-
```

Recommended secret names for scripts:

- `INTERNAL_API_SECRET`
- `OPENAI_API_KEY`
- `JWT_SECRET`
- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_SECRET` (optional)
- `SUPABASE_SERVICE_ROLE_KEY` (optional)
- `QDRANT_API_KEY` (optional)
- `MEMORY_MASTER_KEY` (recommended in production)
- `BROWSER_WORKER_API_KEY` (optional)

## 4) Deploy backend

From repo root:

```bash
export PROJECT_ID="your-project-id"
export REGION="us-central1"
export SERVICE_ACCOUNT="tallei-backend-sa@${PROJECT_ID}.iam.gserviceaccount.com"

export PUBLIC_BASE_URL="https://api.example.com"
export FRONTEND_URL="https://app.example.com"
export DASHBOARD_BASE_URL="https://app.example.com"
export MCP_URL="https://api.example.com/mcp"
export DATABASE_URL="postgresql://..."
export REDIS_URL="redis://..."
export QDRANT_URL="https://..."
export SUPABASE_URL="https://<project>.supabase.co"
export GOOGLE_CLIENT_ID="..."
export GOOGLE_REDIRECT_URI="https://api.example.com/api/auth/google/callback"

export INTERNAL_API_SECRET_SECRET="INTERNAL_API_SECRET"
export OPENAI_API_KEY_SECRET="OPENAI_API_KEY"
export JWT_SECRET_SECRET="JWT_SECRET"

export SUPABASE_SERVICE_ROLE_KEY_SECRET="SUPABASE_SERVICE_ROLE_KEY"
export QDRANT_API_KEY_SECRET="QDRANT_API_KEY"
export MEMORY_MASTER_KEY_SECRET="MEMORY_MASTER_KEY"
export GOOGLE_CLIENT_SECRET_SECRET="GOOGLE_CLIENT_SECRET"

./deploy/cloudrun/deploy-backend.sh
```

## 5) Deploy dashboard

From repo root:

```bash
export PROJECT_ID="your-project-id"
export REGION="us-central1"
export SERVICE_ACCOUNT="tallei-dashboard-sa@${PROJECT_ID}.iam.gserviceaccount.com"

export NEXTAUTH_URL="https://app.example.com"
export NEXT_PUBLIC_APP_URL="https://app.example.com"
export BACKEND_URL="https://api.example.com"
export API_PROXY_TARGET="https://api.example.com"
export GOOGLE_CLIENT_ID="..."

export INTERNAL_API_SECRET_SECRET="INTERNAL_API_SECRET"
export NEXTAUTH_SECRET_SECRET="NEXTAUTH_SECRET"
export GOOGLE_CLIENT_SECRET_SECRET="GOOGLE_CLIENT_SECRET"

./deploy/cloudrun/deploy-dashboard.sh
```

## 6) Map custom domains

Map each service to its subdomain:

```bash
gcloud beta run domain-mappings create \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --service tallei-dashboard \
  --domain app.example.com

gcloud beta run domain-mappings create \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --service tallei-backend \
  --domain api.example.com
```

Then add the DNS records shown by:

```bash
gcloud beta run domain-mappings describe \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --domain app.example.com
```

Repeat for `api.example.com`.

## 7) Security checklist

- Use strong random values for `INTERNAL_API_SECRET`, `JWT_SECRET`, and `NEXTAUTH_SECRET`.
- Store all sensitive values in Secret Manager, not `.env` files in production.
- Keep backend and dashboard on separate service accounts.
- Keep `FRONTEND_URL` exact (`https://app.example.com`) so CORS is tight.
- Keep Cloud Run min instances at `0` while testing cost; raise only if needed.
