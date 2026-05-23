# Vibe Codex

Tell ChatGPT what to build. Watch Codex do it.

Vibe Codex is a local MCP server that lets ChatGPT orchestrate Codex CLI inside approved folders on your Mac. The Codex desktop app can be opened for supervision, but v0.2 automation goes through `codex exec` and visible Terminal handoff, not GUI typing.

## Architecture

```text
User talks to ChatGPT
        |
        v
ChatGPT calls Vibe Codex MCP tools
        |
        v
Vibe Codex validates auth, paths, autonomy, and command risk
        |
        v
Allowed workspace + safe commands + Codex CLI
        |
        v
Codex edits/runs/tests in the workspace
        |
        v
Vibe Codex returns run output, git status, diff, and saved state
```

## Security Warning

This project is designed as a local relay, not a public remote shell. Keep it bound to trusted networks, use a strong `RELAY_TOKEN`, and expose it to ChatGPT only through a secure tunnel you control. Dangerous commands are blocked or approval-gated; raw shell and Codex app-server access are not exposed.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` before exposing the server:

```env
PORT=8787
RELAY_TOKEN=change-me
ALLOW_URL_TOKEN_AUTH=false
URL_TOKEN=
URL_TOKEN_REQUIRED_PREFIX=vibe_
URL_TOKEN_MIN_LENGTH=32
URL_TOKEN_EXPIRES_AT=
ALLOWED_ROOTS=
DEFAULT_PARENT_DIR=/Users/Projects
CODEX_BIN=codex
DATABASE_PATH=./vibe-codex.sqlite
DEFAULT_CODEX_APPROVAL=untrusted
DEFAULT_CODEX_SANDBOX=workspace-write
ALLOW_NETWORK_COMMANDS=false
MAX_COMMAND_OUTPUT_BYTES=200000
COMMAND_TIMEOUT_MS=120000
CODEX_TIMEOUT_MS=900000
REQUIRE_APPROVAL_FOR_CODEX_VISIBLE=false
REQUIRE_APPROVAL_FOR_CODEX_HIDDEN=true
REQUIRE_APPROVAL_FOR_WRITE_FILE=false
REQUIRE_APPROVAL_FOR_NORMAL_COMMANDS=false
ENABLE_EXPERIMENTAL_OAUTH=false
OAUTH_ISSUER_BASE_URL=
OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
OAUTH_AUTH_CODE_TTL_SECONDS=300
OAUTH_ALLOWED_REDIRECT_HOSTS=chat.openai.com,chatgpt.com
OAUTH_REQUIRE_LOCAL_APPROVAL=true
```

`RELAY_TOKEN` is required unless you explicitly run in development mode. `ALLOWED_ROOTS` defines the only directories Vibe Codex can touch. `DEFAULT_PARENT_DIR` is where new workspaces are created by default.

For ChatGPT Developer Mode testing where the app UI only offers OAuth, No auth, or Mixed auth, Vibe Codex supports a dev-only URL token:

```env
ALLOW_URL_TOKEN_AUTH=true
URL_TOKEN=<long-random-token>
URL_TOKEN_REQUIRED_PREFIX=vibe_
URL_TOKEN_MIN_LENGTH=32
```

Generate and print a token with:

```bash
npm run pair
```

Generate and write/update `.env` with URL-token auth enabled:

```bash
npm run pair -- --write-env
```

You can also generate a token manually:

```bash
printf "vibe_%s\n" "$(openssl rand -hex 32)"
```

Use URL-token auth only as a local development workaround, not production auth. Do not share the URL, because the token is part of the URL. If `URL_TOKEN_EXPIRES_AT` is set to an ISO timestamp, token-route auth is rejected after that time. Bearer auth remains available on `/mcp` for curl and local tools.

## Run Locally

```bash
npm run dev
```

The MCP endpoint is:

```text
http://localhost:8787/mcp
```

Authenticated requests must include:

```text
Authorization: Bearer <RELAY_TOKEN>
```

For production-style local runs:

```bash
npm run build
npm start
```

## ChatGPT Connector

For ChatGPT local connector use, expose the local MCP endpoint with a secure tunnel such as Cloudflare Tunnel or ngrok, then configure the connector URL to the tunneled `/mcp` endpoint. Vibe Codex does not hardcode or manage tunnel logic.

For ChatGPT Developer Mode testing with URL token auth:

```text
Authentication: No auth
MCP URL: https://<ngrok-url>/mcp/<URL_TOKEN>
```

The query-string form also works when enabled:

```text
https://<ngrok-url>/mcp?vibe_token=<URL_TOKEN>
```

Bearer auth on `/mcp` remains supported and is preferred whenever the client can send static headers.

Experimental OAuth is also available, disabled by default:

```env
ENABLE_EXPERIMENTAL_OAUTH=true
OAUTH_ISSUER_BASE_URL=https://<ngrok-url>
OAUTH_REQUIRE_LOCAL_APPROVAL=true
```

ChatGPT Developer Mode OAuth settings:

```text
Authentication: OAuth
MCP URL: https://<ngrok-url>/mcp
```

Vibe Codex exposes OAuth metadata, `/authorize`, `/token`, and `/register`. The flow is local-owner approval with PKCE S256 and opaque in-memory access tokens. URL-token auth remains the simpler development fallback.

## Tools

- `relay_health`
- `connector_setup_status`
- `get_connector_url`
- `list_projects`
- `create_workspace`
- `list_files`
- `read_file`
- `write_file`
- `run_workspace_command`
- `open_in_codex_app`
- `start_codex_task`
- `continue_codex_task`
- `get_run`
- `git_status`
- `git_diff`
- `collect_visible_run_result`
- `list_recent_runs`
- `approve_action`
- `reject_action`
- `list_pending_approvals`

## Codex Execution Modes

`start_codex_task` accepts `executionMode`:

- `terminal-visible` is the default. It writes `.vibe-codex/runs/<runId>/prompt.md` and `run-codex.sh`, then opens the script in macOS Terminal so you can watch Codex run. Poll with `collect_visible_run_result`.
- `exec-hidden` runs `codex exec` synchronously and returns captured stdout/stderr. It requires `allowHiddenCodex: true` or a one-time approval.
- `app-supervised` opens `codex app <workspace>`, writes the prompt file, and copies the prompt to the clipboard with `pbcopy` when available. Paste it into the Codex app manually.

Generated visible scripts write `__VIBE_CODEX_RUN_EXIT_CODE=<code>` and `__VIBE_CODEX_RUN_FINISHED__` markers to the log. `collect_visible_run_result` uses those markers and failure strings to report `completed_visible`, `failed_visible`, or the current run status. It also compares current `git status --short` against the run baseline and returns `newChangedFilesSinceRun`.

## Approval Gates

Approval env vars:

```env
REQUIRE_APPROVAL_FOR_CODEX_VISIBLE=false
REQUIRE_APPROVAL_FOR_CODEX_HIDDEN=true
REQUIRE_APPROVAL_FOR_WRITE_FILE=false
REQUIRE_APPROVAL_FOR_NORMAL_COMMANDS=false
```

When an action needs approval, the tool returns:

```json
{
  "approvalRequired": true,
  "approvalId": "...",
  "reason": "...",
  "actionSummary": {}
}
```

Call `approve_action` with that `approvalId`, then retry the original tool call. Approval is one-time and consumed by the next matching action. `reject_action` records a rejection.

Direct `write_file` is flagged as `directWrite`. ChatGPT should not use direct file writes as fallback after a failed Codex task unless the user explicitly authorizes fallback.

## Example Workflow

```text
User asks ChatGPT:
"Create a new repo for my Chrome extension anti-doomscrolling prototype. Open it in Codex and ask Codex to build the MVP."

ChatGPT calls:
1. create_workspace
2. open_in_codex_app
3. start_codex_task
4. collect_visible_run_result
5. git_status
6. git_diff
7. continue_codex_task if needed
```

## Autonomy Levels

- `manual`: health, listing, safe reads, and prompt compilation only.
- `workspace`: workspace creation, file writes, git init, safe commands, Codex launch/tasks.
- `build-test`: `workspace` plus normal build/test/install commands.
- `full-project`: safe and normal project commands, file writes, and Codex tasks.

Blocked commands never run. Dangerous commands are not executed. Normal commands can be approval-gated with `REQUIRE_APPROVAL_FOR_NORMAL_COMMANDS=true`.

## Known Limitations

- Experimental OAuth tokens/codes are in-memory and reset when the relay restarts.
- v0.2 uses `codex exec`, not true Codex desktop thread control.
- Continuation is approximated through saved run context.
- No live streaming yet.
- No graphical approval UI yet; approvals are MCP tool calls.
- Dangerous commands are rejected or approval-required instead of executed.
- The Codex app is opened for supervision only.
- Shell command strings are accepted after strict risk classification; stronger parsing is planned.

## Roadmap

- Codex app-server integration
- Streamed progress events
- True Codex thread continuation
- Approval UI
- Project dashboard
- Richer diff summaries
- Per-project profiles
- Stronger shell parser
- Better app connector UI
