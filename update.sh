#!/usr/bin/env bash
#
# Deploy the latest committed code to the live server.
#
#   Usage:  ./update.sh
#
# This does NOT push to GitHub — run `git push` yourself first. This script
# takes whatever is on GitHub's `main` branch and makes the server run it:
# it pulls the latest code, installs dependencies, and restarts the service.
#
# It is safe to run repeatedly. The first run converts /opt/imposter into a
# git checkout; every run after that is just a fast-forward + restart.

set -euo pipefail

# --- config -----------------------------------------------------------------
SSH_HOST="mysite"                                   # alias in ~/.ssh/config -> root@45.124.54.199
REPO="https://github.com/jfry03/QFin-Games.git"
APPDIR="/opt/imposter"
SERVICE="imposter"
BRANCH="main"
# ----------------------------------------------------------------------------

echo "==> Deploying '$BRANCH' to $SSH_HOST:$APPDIR"

# Everything below runs ON THE SERVER. The heredoc is quoted so it is sent
# verbatim; config values are passed in as arguments ($1..$4).
ssh "$SSH_HOST" 'bash -s' -- "$REPO" "$APPDIR" "$SERVICE" "$BRANCH" <<'REMOTE'
set -euo pipefail
REPO="$1"; APPDIR="$2"; SERVICE="$3"; BRANCH="$4"

cd "$APPDIR"

# /opt/imposter is owned by the 'imposter' user but this runs as root; without
# this git refuses with "dubious ownership". Idempotent.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APPDIR" \
  || git config --global --add safe.directory "$APPDIR"

# First run: turn the existing directory into a git checkout of the repo.
if [ ! -d .git ]; then
  echo "   first run: initializing git tracking in $APPDIR"
  git init -q
fi

# Ensure the 'origin' remote exists and points at the right URL (add or update).
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO"
else
  git remote add origin "$REPO"
fi

# Fetch + hard-reset to the branch.
# Hard reset means the server always mirrors GitHub exactly (any manual edits
# made directly on the server are discarded — commit changes via GitHub instead).
echo "   fetching latest..."
git fetch -q origin "$BRANCH"
git reset -q --hard "origin/$BRANCH"
echo "   now at: $(git log -1 --pretty='%h  %s')"

# Install production dependencies (no-op if already present).
echo "   installing dependencies..."
npm install --omit=dev --no-audit --no-fund --silent

# Restart and confirm it came back up.
echo "   restarting $SERVICE..."
systemctl restart "$SERVICE"
sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  echo "   OK: $SERVICE is active"
else
  echo "   ERROR: $SERVICE failed to start. Recent logs:" >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2
  exit 1
fi
REMOTE

echo "==> Done. Live at https://45-124-54-199.sslip.io"
