#!/usr/bin/env bash
# Deploy the CURRENT WORKING TREE of nuncio to another machine over SSH
# (typically a tailnet peer), then run the bootstrap there.
#
#   scripts/remote/deploy.sh oscar@oscars-macbook-pro.tailf08532.ts.net [dest-dir]
#
# Rsync is additive for the app tree but never touches the target's
# data/ directory (its own sessions DB, settings key, auth token).
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host [dest-dir]}"
DEST="${2:-nuncio}"
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[deploy] $SRC_DIR → $TARGET:$DEST"
rsync -az --stats \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '**/node_modules' \
  --exclude 'data/' \
  --exclude '**/data/' \
  --exclude '.claude' \
  --exclude '.bridgememory' \
  --exclude '*.log' \
  "$SRC_DIR/" "$TARGET:$DEST/"

echo "[deploy] running bootstrap on $TARGET…"
ssh "$TARGET" "cd '$DEST' && bash scripts/remote/bootstrap.sh"
