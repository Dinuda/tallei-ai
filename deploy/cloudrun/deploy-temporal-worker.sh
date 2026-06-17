#!/usr/bin/env bash
set -euo pipefail

# Deploys the Temporal worker as a dedicated always-on Cloud Run service.
# Temporal Server itself must run on a persistent Docker host (see docker-compose.yml --profile temporal).

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-tallei}"
SERVICE_NAME="${TEMPORAL_WORKER_SERVICE_NAME:-tallei-temporal-worker}"
SERVICE_ACCOUNT="${TEMPORAL_WORKER_SERVICE_ACCOUNT:-tallei-backend-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Missing required env var: PROJECT_ID" >&2
  exit 1
fi

if [[ "$SERVICE_ACCOUNT" != *"@"* ]]; then
  SERVICE_ACCOUNT="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
fi

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

echo "Submitting Cloud Build for Temporal worker image (reuses backend Dockerfile)..."
build_id="$(gcloud builds submit \
  --project "$PROJECT_ID" \
  --tag "$IMAGE_URI" \
  --async \
  --format='value(id)' \
  .)"

echo "Cloud Build started: ${build_id}"
while true; do
  build_status="$(gcloud builds describe "$build_id" --project "$PROJECT_ID" --format='value(status)')"
  case "$build_status" in
    SUCCESS) break ;;
    FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
      echo "Cloud Build failed: ${build_status}" >&2
      exit 1
      ;;
    *) sleep 5 ;;
  esac
done

TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-}"
TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
TEMPORAL_TASK_QUEUE="${TEMPORAL_TASK_QUEUE:-tallei-loops}"

if [[ -z "$TEMPORAL_ADDRESS" ]]; then
  echo "Missing required env var: TEMPORAL_ADDRESS (host:port of self-hosted Temporal server)" >&2
  exit 1
fi

echo "Deploying Cloud Run service ${SERVICE_NAME}..."
gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE_URI" \
  --service-account "$SERVICE_ACCOUNT" \
  --no-allow-unauthenticated \
  --min-instances 1 \
  --max-instances 3 \
  --cpu 1 \
  --memory 1Gi \
  --command npm \
  --args run,temporal:worker \
  --set-env-vars "NODE_ENV=production,TALLEI_TEMPORAL__ENABLED=true,TALLEI_TEMPORAL__ADDRESS=${TEMPORAL_ADDRESS},TALLEI_TEMPORAL__NAMESPACE=${TEMPORAL_NAMESPACE},TALLEI_TEMPORAL__TASK_QUEUE=${TEMPORAL_TASK_QUEUE}" \
  --set-secrets "TALLEI_DB__URL=DATABASE_URL:latest,TALLEI_LLM__OPENAI_API_KEY=OPENAI_API_KEY:latest,TALLEI_AUTH__JWT_SECRET=JWT_SECRET:latest,TALLEI_HTTP__INTERNAL_API_SECRET=INTERNAL_API_SECRET:latest"

echo "Deployed ${SERVICE_NAME} -> ${IMAGE_URI}"
