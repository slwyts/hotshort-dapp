#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-hotshort-dapp}"
OUT_DIR="${OUT_DIR:-$ROOT/.deploy}"
STAGE="$OUT_DIR/$APP_NAME"
ARCHIVE="$OUT_DIR/$APP_NAME-standalone.tar.gz"

cd "$ROOT"

rm -rf "$STAGE"
mkdir -p "$STAGE"

if [[ -f "$ROOT/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.production"
  set +a
fi

pnpm build

if [[ ! -d "$ROOT/.next/standalone" ]]; then
  echo "error: .next/standalone was not generated. Check next.config.ts output=standalone." >&2
  exit 1
fi

cp -a "$ROOT/.next/standalone/." "$STAGE/"

mkdir -p "$STAGE/.next"
cp -a "$ROOT/.next/static" "$STAGE/.next/static"

if [[ -d "$ROOT/public" ]]; then
  cp -a "$ROOT/public" "$STAGE/public"
fi

if [[ -f "$ROOT/.env.production" ]]; then
  cp "$ROOT/.env.production" "$STAGE/.env.production"
fi

cat > "$STAGE/README.deploy.txt" <<'EOF'
Run:
  NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 node server.js

Required runtime files:
  server.js
  .next/
  public/
  .env.production
EOF

tar -czf "$ARCHIVE" -C "$OUT_DIR" "$APP_NAME"

echo "Standalone bundle:"
echo "  $STAGE"
echo "Archive:"
echo "  $ARCHIVE"
du -sh "$STAGE" "$ARCHIVE"
