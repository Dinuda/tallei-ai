#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Missing required command: gcloud" >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Missing PROJECT_ID and no default gcloud project is set." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
Usage:
  PROJECT_ID=your-project-id ./deploy/cloudrun/add-secret-versions.sh SECRET_NAME [SECRET_NAME...]

Example:
  PROJECT_ID=actionlog-487112 ./deploy/cloudrun/add-secret-versions.sh \
    INTERNAL_API_SECRET OPENAI_API_KEY JWT_SECRET
USAGE
  exit 1
fi

is_valid_secret_id() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]
}

echo "Project: ${PROJECT_ID}"
for secret_id in "$@"; do
  if ! is_valid_secret_id "$secret_id"; then
    echo "Invalid secret name: ${secret_id}" >&2
    exit 1
  fi

  if ! gcloud secrets describe "$secret_id" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating secret: ${secret_id}"
    gcloud secrets create "$secret_id" \
      --project "$PROJECT_ID" \
      --replication-policy=automatic >/dev/null
  fi

  while true; do
    read -rsp "Enter value for ${secret_id}: " secret_value
    echo
    if [[ -z "$secret_value" ]]; then
      echo "Value cannot be empty. Try again."
      continue
    fi
    break
  done

  printf '%s' "$secret_value" | gcloud secrets versions add "$secret_id" \
    --project "$PROJECT_ID" \
    --data-file=- >/dev/null
  unset secret_value
  echo "Added new version for ${secret_id}"
done

echo "Done."
