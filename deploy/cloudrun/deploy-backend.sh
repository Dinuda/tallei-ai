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

validate_secret_id() {
  local var_name="$1"
  local secret_id="${!var_name:-}"
  [[ -z "$secret_id" ]] && return 0

  if [[ ! "$secret_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "Invalid ${var_name}: expected Secret Manager secret name, got something else." >&2
    echo "Use a secret ID like INTERNAL_API_SECRET, not the raw secret value." >&2
    exit 1
  fi

  if ! gcloud secrets describe "$secret_id" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "Secret not found in project ${PROJECT_ID}: ${secret_id} (from ${var_name})" >&2
    exit 1
  fi
}

ensure_secret_access() {
  local secret_id="$1"
  [[ -z "$secret_id" ]] && return 0

  if ! gcloud secrets add-iam-policy-binding "$secret_id" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${SERVICE_ACCOUNT}" \
    --role "roles/secretmanager.secretAccessor" \
    --quiet >/dev/null 2>&1; then
    echo "Warning: unable to grant roles/secretmanager.secretAccessor on ${secret_id} to ${SERVICE_ACCOUNT}." >&2
    echo "Continuing deploy; if runtime secret access is missing, Cloud Run revision creation will fail." >&2
  fi
}

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-tallei}"
SERVICE_NAME="${BACKEND_SERVICE_NAME:-tallei-backend}"
SERVICE_ACCOUNT="${BACKEND_SERVICE_ACCOUNT:-tallei-backend-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

require_env PROJECT_ID
require_env SERVICE_ACCOUNT
require_env PUBLIC_BASE_URL
require_env FRONTEND_URL
require_env MCP_URL
require_env DATABASE_URL
require_env INTERNAL_API_SECRET
require_env OPENAI_API_KEY
require_env JWT_SECRET
require_env MEMORY_MASTER_KEY
require_env TALLEI_BILLING__LEMONSQUEEZY_API_KEY
require_env TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET
require_env TALLEI_BILLING__LEMONSQUEEZY_PRO_VARIANT_ID
require_env TALLEI_BILLING__LEMONSQUEEZY_POWER_VARIANT_ID
require_env TALLEI_AUTH__CONTINUATION_PRIVATE_KEY
require_env TALLEI_AUTH__CONTINUATION_PUBLIC_KEY

# Accept either a full service account email or a short account name.
if [[ "$SERVICE_ACCOUNT" != *"@"* ]]; then
  SERVICE_ACCOUNT="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
fi

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Invalid or missing service account in project ${PROJECT_ID}: ${SERVICE_ACCOUNT}" >&2
  exit 1
fi

validate_secret_id INTERNAL_API_SECRET
validate_secret_id OPENAI_API_KEY
validate_secret_id JWT_SECRET
validate_secret_id MEMORY_MASTER_KEY
validate_secret_id TALLEI_BILLING__LEMONSQUEEZY_API_KEY
validate_secret_id TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET
validate_secret_id TALLEI_AUTH__CONTINUATION_PRIVATE_KEY
validate_secret_id TALLEI_AUTH__CONTINUATION_PUBLIC_KEY
ensure_secret_access INTERNAL_API_SECRET
ensure_secret_access OPENAI_API_KEY
ensure_secret_access JWT_SECRET
ensure_secret_access MEMORY_MASTER_KEY
ensure_secret_access TALLEI_BILLING__LEMONSQUEEZY_API_KEY
ensure_secret_access TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET
ensure_secret_access TALLEI_AUTH__CONTINUATION_PRIVATE_KEY
ensure_secret_access TALLEI_AUTH__CONTINUATION_PUBLIC_KEY

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

if ! gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPO" \
    --project "$PROJECT_ID" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Tallei Cloud Run images"
fi

echo "Submitting Cloud Build for backend image..."
build_id="$(gcloud builds submit \
  --project "$PROJECT_ID" \
  --tag "$IMAGE_URI" \
  --async \
  --format='value(id)' \
  .)"

if [[ -z "$build_id" ]]; then
  echo "Failed to capture Cloud Build ID for backend deploy." >&2
  exit 1
fi

echo "Cloud Build started: ${build_id}"
while true; do
  build_status="$(gcloud builds describe "$build_id" --project "$PROJECT_ID" --format='value(status)')"
  case "$build_status" in
    SUCCESS)
      echo "Cloud Build succeeded: ${build_id}"
      break
      ;;
    FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
      echo "Cloud Build failed with status ${build_status}: ${build_id}" >&2
      gcloud builds describe "$build_id" --project "$PROJECT_ID" --format='value(logUrl)' >&2 || true
      exit 1
      ;;
    *)
      sleep 5
      ;;
  esac
done

env_vars=(
  "NODE_ENV=production"
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
  "GRAPH_EXTRACTION_ENABLED=${GRAPH_EXTRACTION_ENABLED:-true}"
  "DASHBOARD_GRAPH_V2_ENABLED=${DASHBOARD_GRAPH_V2_ENABLED:-true}"
  "RECALL_V2_ENABLED=${RECALL_V2_ENABLED:-true}"
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
  "TALLEI_BILLING__LEMONSQUEEZY_PRO_VARIANT_ID=${TALLEI_BILLING__LEMONSQUEEZY_PRO_VARIANT_ID}"
  "TALLEI_BILLING__LEMONSQUEEZY_POWER_VARIANT_ID=${TALLEI_BILLING__LEMONSQUEEZY_POWER_VARIANT_ID}"
)

secret_vars=(
  "INTERNAL_API_SECRET=${INTERNAL_API_SECRET}:latest"
  "OPENAI_API_KEY=${OPENAI_API_KEY}:latest"
  "JWT_SECRET=${JWT_SECRET}:latest"
  "MEMORY_MASTER_KEY=${MEMORY_MASTER_KEY}:latest"
  "TALLEI_BILLING__LEMONSQUEEZY_API_KEY=${TALLEI_BILLING__LEMONSQUEEZY_API_KEY}:latest"
  "TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET=${TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET}:latest"
  "TALLEI_AUTH__CONTINUATION_PRIVATE_KEY=${TALLEI_AUTH__CONTINUATION_PRIVATE_KEY}:latest"
  "TALLEI_AUTH__CONTINUATION_PUBLIC_KEY=${TALLEI_AUTH__CONTINUATION_PUBLIC_KEY}:latest"
)

if [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  validate_secret_id SUPABASE_SERVICE_ROLE_KEY
  ensure_secret_access SUPABASE_SERVICE_ROLE_KEY
  secret_vars+=("SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}:latest")
fi
if [[ -n "${QDRANT_API_KEY:-}" ]]; then
  validate_secret_id QDRANT_API_KEY
  ensure_secret_access QDRANT_API_KEY
  secret_vars+=("QDRANT_API_KEY=${QDRANT_API_KEY}:latest")
fi
if [[ -n "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  validate_secret_id GOOGLE_CLIENT_SECRET
  ensure_secret_access GOOGLE_CLIENT_SECRET
  secret_vars+=("GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}:latest")
fi
if [[ -n "${BROWSER_WORKER_API_KEY:-}" ]]; then
  validate_secret_id BROWSER_WORKER_API_KEY
  ensure_secret_access BROWSER_WORKER_API_KEY
  secret_vars+=("BROWSER_WORKER_API_KEY=${BROWSER_WORKER_API_KEY}:latest")
fi
if [[ -n "${KMS_KEY_ID:-}" ]]; then
  validate_secret_id KMS_KEY_ID
  ensure_secret_access KMS_KEY_ID
  secret_vars+=("KMS_KEY_ID=${KMS_KEY_ID}:latest")
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
