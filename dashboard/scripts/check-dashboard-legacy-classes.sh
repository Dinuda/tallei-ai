#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PATTERN='(dashboard-|site-|landing-|pricing-|cnn-|\bbtn\b)'

if rg -n --glob '!app/(public)/**' --glob '!app/components/**' "$PATTERN" app/dashboard; then
  echo "\nLegacy dashboard/public class prefixes found in app/dashboard."
  exit 1
fi

echo "No forbidden legacy class prefixes found in app/dashboard."
