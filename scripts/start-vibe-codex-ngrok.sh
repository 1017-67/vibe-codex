#!/usr/bin/env zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

repo_dir="/Users/liuhc/vibe-codex"
log_dir="$repo_dir/.vibe-codex/launchd"
mkdir -p "$log_dir"

cd "$repo_dir"

now() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

public_base_url="$(awk -F= '/^PUBLIC_BASE_URL=/{print $2}' .env | tail -n 1)"
if [[ -z "$public_base_url" ]]; then
  echo "PUBLIC_BASE_URL is not set in $repo_dir/.env" >&2
  exit 1
fi

ngrok_url="${public_base_url#https://}"
ngrok_url="${ngrok_url#http://}"
ngrok_url="${ngrok_url%%/*}"

ready=false
for attempt in {1..60}; do
  if /usr/bin/curl --http1.1 -fsS "http://127.0.0.1:8787/.well-known/oauth-protected-resource" >/dev/null 2>&1; then
    ready=true
    break
  fi
  echo "[$(now)] waiting for Vibe Codex on 127.0.0.1:8787 attempt=$attempt" >> "$log_dir/ngrok-bootstrap.log"
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "[$(now)] Vibe Codex did not become ready; ngrok will retry via launchd" >> "$log_dir/ngrok-bootstrap.log"
  exit 1
fi

echo "[$(now)] starting ngrok for $ngrok_url -> 8787" >> "$log_dir/ngrok-bootstrap.log"
exec /opt/homebrew/bin/ngrok http "--url=$ngrok_url" 8787
