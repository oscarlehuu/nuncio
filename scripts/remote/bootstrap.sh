#!/usr/bin/env bash
# Bootstrap a nuncio server on THIS machine (run from the repo root).
# Idempotent: safe to re-run after every deploy. Installs bun if missing,
# installs deps, ensures the web build exists, and registers nuncio as a
# user-level service (launchd on macOS, systemd --user on Linux).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${NUNCIO_PORT:-3000}"

# ── 1. bun ────────────────────────────────────────────────────────────────
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "[bootstrap] installing bun…"
  curl -fsSL https://bun.sh/install | bash
fi
BUN="$(command -v bun)"
echo "[bootstrap] bun: $BUN ($("$BUN" --version))"

# ── 2. dependencies ───────────────────────────────────────────────────────
# --ignore-scripts skips desktop-only native postinstalls (electron-rebuild /
# node-pty); the server and web packages don't need lifecycle scripts.
echo "[bootstrap] installing dependencies…"
cd "$REPO_DIR"
"$BUN" install --ignore-scripts

# ── 3. web build (skipped when the deploy already shipped dist/) ─────────
if [ ! -f "$REPO_DIR/apps/web/dist/index.html" ]; then
  echo "[bootstrap] building web app…"
  "$BUN" run --cwd apps/web build
else
  echo "[bootstrap] web dist present — skipping build"
fi

# ── 4. service ────────────────────────────────────────────────────────────
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.nuncio.server.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nuncio.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR/apps/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>$BUN_INSTALL/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/nuncio-server.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/nuncio-server.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  echo "[bootstrap] launchd service loaded: com.nuncio.server (logs: ~/Library/Logs/nuncio-server.log)"
elif [ "$OS" = "Linux" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/nuncio.service" <<UNIT_EOF
[Unit]
Description=nuncio server

[Service]
WorkingDirectory=$REPO_DIR/apps/server
ExecStart=$BUN src/main.ts
Environment=PORT=$PORT
Environment=PATH=$BUN_INSTALL/bin:/usr/local/bin:/usr/bin:/bin
Restart=always

[Install]
WantedBy=default.target
UNIT_EOF
  systemctl --user daemon-reload
  systemctl --user enable --now nuncio.service
  echo "[bootstrap] systemd user service enabled: nuncio.service"
  echo "[bootstrap] tip: 'loginctl enable-linger $USER' keeps it running after logout"
else
  echo "[bootstrap] unsupported OS: $OS — start manually: cd apps/server && bun src/main.ts" >&2
  exit 1
fi

# ── 5. health check ───────────────────────────────────────────────────────
echo "[bootstrap] waiting for http://127.0.0.1:$PORT/api/health…"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "[bootstrap] nuncio is up on port $PORT"
    TOKEN_FILE="$REPO_DIR/apps/server/data/auth-token"
    if [ -f "$TOKEN_FILE" ]; then
      echo "[bootstrap] access token (for non-tailnet clients): $(cat "$TOKEN_FILE")"
    fi
    echo "[bootstrap] tailnet devices on the same Tailscale account connect with no token."
    exit 0
  fi
  sleep 1
done
echo "[bootstrap] server did not come up within 30s — check the service log" >&2
exit 1
