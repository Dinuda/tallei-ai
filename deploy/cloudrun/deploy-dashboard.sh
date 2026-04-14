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
SERVICE_NAME="${SERVICE_NAME:-tallei-dashboard}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

require_env PROJECT_ID
require_env SERVICE_ACCOUNT
require_env NEXTAUTH_URL
require_env NEXT_PUBLIC_APP_URL
require_env BACKEND_URL
require_env API_PROXY_TARGET
require_env INTERNAL_API_SECRET_SECRET
require_env NEXTAUTH_SECRET_SECRET

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
  ./dashboard

env_vars=(
  "NODE_ENV=production"
  "NEXTAUTH_URL=${NEXTAUTH_URL}"
  "NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}"
  "BACKEND_URL=${BACKEND_URL}"
  "API_PROXY_TARGET=${API_PROXY_TARGET}"
  "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}"
)

secret_vars=(
  "INTERNAL_API_SECRET=${INTERNAL_API_SECRET_SECRET}:latest"
  "NEXTAUTH_SECRET=${NEXTAUTH_SECRET_SECRET}:latest"
)

if [[ -n "${GOOGLE_CLIENT_SECRET_SECRET:-}" ]]; then
  secret_vars+=("GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_SECRET}:latest")
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

echo "Dashboard deployed: ${SERVICE_NAME}"
gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format="value(status.url)"
