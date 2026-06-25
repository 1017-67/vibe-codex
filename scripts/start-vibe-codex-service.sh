#!/usr/bin/env zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export VIBE_CODEX_DEV=true

repo_dir="/Users/liuhc/vibe-codex"
log_dir="$repo_dir/.vibe-codex/launchd"
mkdir -p "$log_dir"

cd "$repo_dir"

now() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

echo "[$(now)] building Vibe Codex" >> "$log_dir/server-bootstrap.log"
/opt/homebrew/bin/npm run build >> "$log_dir/server-bootstrap.log" 2>&1

echo "[$(now)] starting Vibe Codex" >> "$log_dir/server-bootstrap.log"
exec /opt/homebrew/bin/npm start
