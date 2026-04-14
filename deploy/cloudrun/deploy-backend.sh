#!/usr/bin/env bash
set -euo pipefail

required_cmds=(gcloud git)
for cmd in "${required_cmds[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-tallei}"
SERVICE_NAME="${SERVICE_NAME:-tallei-backend}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

require_env PROJECT_ID
require_env SERVICE_ACCOUNT
require_env PUBLIC_BASE_URL
require_env FRONTEND_URL
require_env MCP_URL
require_env DATABASE_URL
require_env INTERNAL_API_SECRET_SECRET
require_env OPENAI_API_KEY_SECRET
require_env JWT_SECRET_SECRET

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

if ! gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPO" \
    --project "$PROJECT_ID" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Tallei Cloud Run images"
fi

gcloud builds submit \
  --project "$PROJECT_ID" \
  --tag "$IMAGE_URI" \
  .

env_vars=(
  "NODE_ENV=production"
  "PORT=8080"
  "HOST=0.0.0.0"
  "PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
  "FRONTEND_URL=${FRONTEND_URL}"
  "DASHBOARD_BASE_URL=${DASHBOARD_BASE_URL:-$FRONTEND_URL}"
  "MCP_URL=${MCP_URL}"
  "DATABASE_URL=${DATABASE_URL}"
  "DATABASE_URL_FALLBACK=${DATABASE_URL_FALLBACK:-$DATABASE_URL}"
  "SUPABASE_URL=${SUPABASE_URL:-}"
  "REDIS_URL=${REDIS_URL:-}"
  "QDRANT_URL=${QDRANT_URL:-}"
  "QDRANT_COLLECTION_NAME=${QDRANT_COLLECTION_NAME:-memories_v1}"
  "EMBEDDING_MODEL=${EMBEDDING_MODEL:-text-embedding-3-small}"
  "ENABLE_SUPABASE_RLS_POLICIES=${ENABLE_SUPABASE_RLS_POLICIES:-true}"
  "MEMORY_DUAL_WRITE_ENABLED=${MEMORY_DUAL_WRITE_ENABLED:-false}"
  "MEMORY_SHADOW_READ_ENABLED=${MEMORY_SHADOW_READ_ENABLED:-false}"
  "MCP_RATE_LIMIT_PER_MINUTE=${MCP_RATE_LIMIT_PER_MINUTE:-240}"
  "MEMORY_API_RATE_LIMIT_PER_MINUTE=${MEMORY_API_RATE_LIMIT_PER_MINUTE:-180}"
  "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}"
  "GOOGLE_REDIRECT_URI=${GOOGLE_REDIRECT_URI:-}"
  "BROWSER_WORKER_BASE_URL=${BROWSER_WORKER_BASE_URL:-}"
  "BROWSER_WORKER_WS_ENDPOINT=${BROWSER_WORKER_WS_ENDPOINT:-}"
  "BROWSER_SESSION_TTL_MS=${BROWSER_SESSION_TTL_MS:-900000}"
  "BROWSER_HEADLESS=${BROWSER_HEADLESS:-true}"
  "BROWSER_MAX_STUDENT_RETRIES=${BROWSER_MAX_STUDENT_RETRIES:-2}"
  "BROWSER_LLM_FALLBACK_ENABLED=${BROWSER_LLM_FALLBACK_ENABLED:-true}"
  "CLAUDE_CONNECTOR_MCP_URL=${CLAUDE_CONNECTOR_MCP_URL:-}"
  "CLAUDE_PROJECT_INSTRUCTIONS_TEMPLATE=${CLAUDE_PROJECT_INSTRUCTIONS_TEMPLATE:-}"
)

secret_vars=(
  "INTERNAL_API_SECRET=${INTERNAL_API_SECRET_SECRET}:latest"
  "OPENAI_API_KEY=${OPENAI_API_KEY_SECRET}:latest"
  "JWT_SECRET=${JWT_SECRET_SECRET}:latest"
)

if [[ -n "${SUPABASE_SERVICE_ROLE_KEY_SECRET:-}" ]]; then
  secret_vars+=("SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY_SECRET}:latest")
fi
if [[ -n "${QDRANT_API_KEY_SECRET:-}" ]]; then
  secret_vars+=("QDRANT_API_KEY=${QDRANT_API_KEY_SECRET}:latest")
fi
if [[ -n "${MEMORY_MASTER_KEY_SECRET:-}" ]]; then
  secret_vars+=("MEMORY_MASTER_KEY=${MEMORY_MASTER_KEY_SECRET}:latest")
fi
if [[ -n "${GOOGLE_CLIENT_SECRET_SECRET:-}" ]]; then
  secret_vars+=("GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_SECRET}:latest")
fi
if [[ -n "${BROWSER_WORKER_API_KEY_SECRET:-}" ]]; then
  secret_vars+=("BROWSER_WORKER_API_KEY=${BROWSER_WORKER_API_KEY_SECRET}:latest")
fi
if [[ -n "${KMS_KEY_ID_SECRET:-}" ]]; then
  secret_vars+=("KMS_KEY_ID=${KMS_KEY_ID_SECRET}:latest")
fi

env_csv="$(IFS=,; echo "${env_vars[*]}")"
secrets_csv="$(IFS=,; echo "${secret_vars[*]}")"

gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE_URI" \
  --platform managed \
  --service-account "$SERVICE_ACCOUNT" \
  --ingress all \
  --allow-unauthenticated \
  --execution-environment gen2 \
  --cpu "${CPU:-1}" \
  --memory "${MEMORY:-1Gi}" \
  --concurrency "${CONCURRENCY:-80}" \
  --timeout "${TIMEOUT_SECONDS:-300}" \
  --min-instances "${MIN_INSTANCES:-0}" \
  --max-instances "${MAX_INSTANCES:-10}" \
  --set-env-vars "$env_csv" \
  --set-secrets "$secrets_csv"

echo "Backend deployed: ${SERVICE_NAME}"
gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format="value(status.url)"
