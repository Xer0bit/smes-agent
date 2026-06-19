#!/usr/bin/env bash
set -euo pipefail

# Preview service regression preflight:
# 1) Starts preview-service locally on a test port
# 2) Posts malformed EcoImpactCounter payload (known bad pattern)
# 3) Verifies update succeeds after auto-fix (HTTP 200)
# 4) Verifies src/main.tsx serves JS module content (not HTML fallback)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PREVIEW_TEST_PORT:-3101}"
PROJECT_ID="preflight-project"
LOG_FILE="${PREVIEW_PREFLIGHT_LOG:-/tmp/preview-preflight.log}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR/preview-service"

NODE_ENV=development PORT="$PORT" node server.js >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 25); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 25 ]]; then
    echo "[preflight] preview-service failed to become healthy"
    tail -n 120 "$LOG_FILE" || true
    exit 1
  fi
done

PAYLOAD_FILE="$(mktemp)"
RESP_FILE="$(mktemp)"
HEADERS_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"

cat > "$PAYLOAD_FILE" <<'JSON'
{
  "files": [
    {
      "path": "src/components/EcoImpactCounter.tsx",
      "content": "import React from 'react';\n\ntype CounterProps = { target: number; duration: number; suffix?: string; prefix?: string };\n\nfunction AnimatedCounter({ target, duration, suffix = ', prefix = '' }: CounterProps) {\n  return <div>{prefix}{target}{suffix}</div>;\n}\n\nexport default AnimatedCounter;\n"
    },
    {
      "path": "src/pages/Auth.tsx",
      "content": "import React from 'react';\n\nconst field = {\n  name: ',\n};\n\nexport default function Auth() {\n  return <div>{field.name}</div>;\n}\n"
    },
    {
      "path": "src/pages/Products.tsx",
      "content": "import React from 'react';\n\nexport default function Products() {\n  window.history.replaceState({}, ', window.location.pathname);\n  return <div>Products</div>;\n}\n"
    }
  ]
}
JSON

STATUS_CODE="$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
  -X POST "http://127.0.0.1:${PORT}/preview/${PROJECT_ID}/update" \
  -H "Content-Type: application/json" \
  --data-binary @"$PAYLOAD_FILE")"

if [[ "$STATUS_CODE" != "200" ]]; then
  echo "[preflight] update failed: HTTP ${STATUS_CODE}"
  cat "$RESP_FILE"
  tail -n 120 "$LOG_FILE" || true
  exit 1
fi

curl -sSI "http://127.0.0.1:${PORT}/preview/${PROJECT_ID}/src/main.tsx" >"$HEADERS_FILE"

if ! grep -qiE '^Content-Type: (application|text)/javascript' "$HEADERS_FILE"; then
  echo "[preflight] main.tsx is missing javascript content-type"
  cat "$HEADERS_FILE"
  tail -n 120 "$LOG_FILE" || true
  exit 1
fi

curl -sS "http://127.0.0.1:${PORT}/preview/${PROJECT_ID}/src/main.tsx" >"$BODY_FILE"

if grep -qi '<!doctype html>' "$BODY_FILE"; then
  echo "[preflight] main.tsx returned HTML fallback instead of JS module"
  sed -n '1,40p' "$BODY_FILE"
  tail -n 120 "$LOG_FILE" || true
  exit 1
fi

echo "[preflight] preview-service checks passed"
