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

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
Usage:
  PROJECT_ID=your-project-id SERVICE_ACCOUNT=svc@project.iam.gserviceaccount.com \
  ./deploy/cloudrun/verify-secrets.sh SECRET_NAME [SECRET_NAME...]

Checks:
  - secret name format
  - secret exists
  - at least one ENABLED version exists
  - optional: service account has roles/secretmanager.secretAccessor
USAGE
  exit 1
fi

is_valid_secret_id() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]
}

errors=0
echo "Project: ${PROJECT_ID}"
if [[ -n "$SERVICE_ACCOUNT" ]]; then
  echo "Service account: ${SERVICE_ACCOUNT}"
fi

for secret_id in "$@"; do
  echo "Checking ${secret_id}..."

  if ! is_valid_secret_id "$secret_id"; then
    echo "  FAIL: invalid secret name format."
    errors=$((errors + 1))
    continue
  fi

  if ! gcloud secrets describe "$secret_id" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "  FAIL: secret does not exist."
    errors=$((errors + 1))
    continue
  fi
  echo "  OK: secret exists."

  latest_enabled="$(
    gcloud secrets versions list "$secret_id" \
      --project "$PROJECT_ID" \
      --filter="state=ENABLED" \
      --sort-by="~name" \
      --limit=1 \
      --format="value(name)"
  )"

  if [[ -z "$latest_enabled" ]]; then
    echo "  FAIL: no ENABLED secret versions found."
    errors=$((errors + 1))
  else
    echo "  OK: latest enabled version is ${latest_enabled}."
  fi

  if [[ -n "$SERVICE_ACCOUNT" ]]; then
    has_access="$(
      gcloud secrets get-iam-policy "$secret_id" \
        --project "$PROJECT_ID" \
        --flatten="bindings[].members" \
        --filter="bindings.role=roles/secretmanager.secretAccessor AND bindings.members=serviceAccount:${SERVICE_ACCOUNT}" \
        --format="value(bindings.members)"
    )"
    if [[ -z "$has_access" ]]; then
      echo "  FAIL: service account is missing roles/secretmanager.secretAccessor."
      errors=$((errors + 1))
    else
      echo "  OK: service account has Secret Accessor."
    fi
  fi
done

if [[ "$errors" -gt 0 ]]; then
  echo "Verification failed with ${errors} error(s)." >&2
  exit 1
fi

echo "All checks passed."
