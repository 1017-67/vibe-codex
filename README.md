# Vibe Codex

Tell ChatGPT what to build. Watch Codex do it.

Vibe Codex is a local MCP server that lets ChatGPT orchestrate Codex CLI inside approved folders on your Mac. The preferred v0.2 supervised path opens normal interactive Codex in Ghostty with the task prompt submitted as the initial prompt argument. Legacy hidden execution is still available through approval-gated `codex exec`, and the Codex desktop app can be opened for visual supervision.

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
RELAY_TOKEN=
ALLOW_URL_TOKEN_AUTH=false
URL_TOKEN=
URL_TOKEN_REQUIRED_PREFIX=vibe_
URL_TOKEN_MIN_LENGTH=32
URL_TOKEN_EXPIRES_AT=
ALLOWED_ROOTS=~/Projects,~/codex-work
DEFAULT_PARENT_DIR=~/codex-work
CODEX_BIN=codex
TERMINAL_APP=ghostty
TERMINAL_FALLBACK_APP=Terminal
PREFER_GHOSTTY=true
DEFAULT_VISIBLE_MODE=codex-app-visible
CODEX_APP_SERVER_MODE=auto
CODEX_APP_SERVER_URL=
CODEX_APP_SERVER_PORT=8765
CODEX_APP_SERVER_HOST=127.0.0.1
CODEX_APP_SERVER_TRANSPORT=ws
CODEX_APP_SERVER_AUTOSTART=true
CODEX_APP_SERVER_LOG_DIR=.vibe-codex/app-server
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

`RELAY_TOKEN` is required unless you explicitly run in development mode. `ALLOWED_ROOTS` defines the only directories Vibe Codex can touch. `DEFAULT_PARENT_DIR` is where new workspaces are created by default. Use your own local paths; `~` is expanded to your home directory.

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

Vibe Codex exposes OAuth metadata, `/authorize`, `/token`, `/revoke`, and `/register`. The flow is local-owner approval with PKCE S256 and opaque in-memory access tokens. URL-token auth remains the simpler development fallback.

OAuth hardening in v0.2:

- `/authorize` only accepts dynamically registered clients.
- `/register`, `/authorize`, `/token`, `/revoke`, and MCP initialize are rate-limited in memory.
- OAuth scopes are limited to `mcp`.
- Empty provided OAuth `state` values are rejected.
- Authorization codes are one-time use and are deleted after successful exchange.
- Access tokens can be revoked at `/revoke`.

Dynamic client registration remains unauthenticated when experimental OAuth is enabled because ChatGPT OAuth compatibility depends on public client registration. Keep OAuth behind localhost or a tunnel URL you control.

## Tools

MCP resources exposed for ChatGPT App context:

- `vibe://status`: current relay status, auth mode, app-server status, recent projects/runs, approvals, setup hints, and warnings.
- `vibe://operator-guide`: concise tool-selection and safety guidance.
- `vibe://feature-matrix`: feature coverage, auth, paste mode, tests, and limits.
- `vibe://setup`: concise local setup and ChatGPT Developer Mode instructions.

Primary MCP tools:

- `relay_health`
- `connector_setup_status`
- `get_connector_url`
- `list_projects`
- `register_project`
- `get_project`
- `resume_project`
- `set_project_default_thread`
- `list_project_runs`
- `list_project_threads`
- `start_project_task`
- `continue_project_task`
- `collect_project_result`
- `create_workspace`
- `list_files`
- `read_file`
- `write_file`
- `run_workspace_command`
- `open_in_codex_app`
- `start_codex_task`
- `continue_codex_task`
- `detect_codex_app_server`
- `start_codex_app_server`
- `stop_codex_app_server`
- `restart_codex_app_server`
- `get_codex_app_server_status`
- `list_codex_threads`
- `start_codex_app_thread`
- `resume_codex_app_thread`
- `continue_codex_app_thread`
- `fork_codex_app_thread`
- `get_codex_app_thread_status`
- `get_run`
- `git_status`
- `git_diff`
- `collect_visible_run_result`
- `list_recent_runs`
- `approve_action`
- `reject_action`
- `list_pending_approvals`

Tool-selection rules:

- Use `start_project_task` / `continue_project_task` for implementation or inspection tasks in registered projects. These tools add a Vibe Codex handoff envelope.
- Use `send_codex_app_thread_message` / `run_codex_app_thread_turn` for raw/plain messages to existing Codex app threads. These tools do not add the handoff envelope.
- Use `codex-app-thread` for true no-paste Codex app/thread execution, `ghostty-visible` as the no-paste terminal fallback, and `codex-app-visible` / `app-supervised` only as manual-paste GUI fallbacks.
- Do not use `write_file` as fallback after Codex failure unless the user explicitly authorizes direct writes.
- Do not create a new workspace for a registered project task unless the user explicitly asks for new workspace creation.

`connector_setup_status` can also check whether `PUBLIC_BASE_URL` is reachable. When OAuth is enabled it probes `/.well-known/oauth-protected-resource`, which catches common tunnel failures such as an offline ngrok endpoint before ChatGPT tries to connect.

## Registered Projects

Vibe Codex keeps a persistent project registry in SQLite so ChatGPT can reuse real workspaces instead of creating a one-off folder for every request.

A project record stores:

- `projectId`
- `name`
- `workspacePath`
- optional `repoRemote`
- `preferredExecutionMode`
- optional `defaultCodexThreadId`
- recent Codex thread IDs
- `createdAt` / `lastUsedAt`
- optional notes

Use `register_project` for an existing repository or workspace. Registration validates that the path is inside `ALLOWED_ROOTS`; it does not create a new workspace. `start_project_task` and `continue_project_task` operate on a registered project and update `lastUsedAt`. `continue_project_task` uses the project's `defaultCodexThreadId` when available, so repeated requests can continue the same Codex app thread without treating each task as a new project.

`create_workspace` remains available, but Vibe Codex will not create a workspace from `start_project_task` unless a future explicit creation tool path is added. For existing repos, register once, then reuse the project by `projectId`, name, or workspace path.

## Codex Execution Modes

`start_codex_task` accepts `executionMode`:

- `codex-app-visible` is the GUI-first manual fallback when `DEFAULT_VISIBLE_MODE=codex-app-visible`. It opens Codex Desktop with `codex app <workspace>`, writes `.vibe-codex/runs/<runId>/prompt.md` plus `metadata.json`, writes a visible root handoff file at `VIBE_CODEX_PROMPT.md`, copies and verifies the prompt on the clipboard, and returns `app_visible_ready` with `promptSubmittedAutomatically:false` and `requiresManualPaste:true`. Paste/send the clipboard prompt in the GUI manually. If Codex Desktop shows `AGENTS.md`, ignore that display and paste the clipboard contents, or open `VIBE_CODEX_PROMPT.md` / the returned `promptPath`. No `codex exec`, Ghostty, shell script, GUI typing, AppleScript, or accessibility automation is used.
- `ghostty-visible` is the stable no-paste terminal fallback. It writes `.vibe-codex/runs/<runId>/prompt.md` and metadata, then opens normal interactive `codex` in Ghostty with the full prompt passed as one argv argument. It returns `promptSubmittedAutomatically:true`, `launchedCodexDirectly:true`, `usesCodexExec:false`, `usesShellScript:false`, and `requiresManualPaste:false`. No `run-codex.sh`, `codex.log`, hidden exec, shell pipe, GUI typing, or `codex exec` is used in this mode.
- `terminal-visible` is the legacy supervised script mode. It writes `run-codex.sh` and `codex.log`, then opens macOS Terminal directly.
- `app-supervised` is a compatibility alias for the older Codex Desktop prompt handoff behavior.
- `codex-app-thread` is experimental no-paste app/thread execution. In `CODEX_APP_SERVER_MODE=auto`, Vibe Codex first detects a healthy configured or local server and then starts one with `codex app-server --listen ws://127.0.0.1:<port>` when `CODEX_APP_SERVER_AUTOSTART=true`. It connects over WebSocket JSON-RPC and uses app-server methods including `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, and `turn/start`. Tool results normalize `runId`, `threadId`, `codexThreadId`, `status`, `workspacePath`, and app-server events while preserving the raw app-server response. Successful app-thread results include `promptSubmittedAutomatically:true` and `requiresManualPaste:false`. If unavailable, tools return a clear error recommending `ghostty-visible`.
- `exec-hidden` runs `codex exec` synchronously and returns captured stdout/stderr. It is not the default and requires `allowHiddenCodex: true` or a one-time approval.

Project tools use the project `preferredExecutionMode` unless the tool call overrides it:

- `codex-app-thread` is the no-paste Codex Desktop path. It uses the MCP-managed app-server when available and sends prompts through app-server thread APIs. It can start, resume, continue, or fork threads and stores the returned Codex thread ID on the project when requested.
- `codex-app-visible` opens Codex Desktop and writes/copies a handoff prompt. This is a manual GUI fallback; the user still sends the prompt in the app.
- `ghostty-visible` opens normal interactive Codex in Ghostty and submits the initial prompt automatically. This is the stable visible fallback when app-server is unavailable.

In `ghostty-visible`, Vibe Codex launches normal interactive Codex and submits the prompt as Codex's initial prompt argument. The terminal remains yours: watch Codex messages, continue chatting normally, approve or reject Codex prompts, and press Ctrl+C whenever you want to interrupt.

When Ghostty supports direct command launch, Vibe Codex runs `codex "<prompt>"` in the workspace through argv passed to Ghostty. If that launch style is unavailable, it opens Ghostty in the workspace and returns a clear message rather than trying shell interpolation. If Ghostty itself is unavailable, Vibe Codex falls back to macOS Terminal only for a safe workspace-open fallback.

In legacy `terminal-visible`, the generated script prints the exact prompt, run ID, workspace, prompt path, log path, execution mode, terminal app, and redacted Codex command before Codex starts. The script waits at `Press Enter to start Codex, or Ctrl+C to cancel.` Ctrl+C cancels before start or interrupts Codex after start; output is written live to `codex.log`.

Legacy visible scripts write `**VIBE_CODEX_RUN_STARTED**`, `__VIBE_CODEX_RUN_EXIT_CODE=<code>`, and `**VIBE_CODEX_RUN_FINISHED**` markers. `collect_visible_run_result` treats finished exit code `0` as `completed_visible` even if the log contains non-fatal warning text. For `codex-app-visible` and interactive `ghostty-visible`, collection does not expect a log; it compares current `git status --short` against the run baseline and reports `completed_visible` when changed files appeared, `unknown_app_visible` for app GUI runs with no changes yet, or `unknown_interactive` for Ghostty runs with no changes yet. Results include `changedFilesSinceRun`, `newChangedFilesSinceRun`, `gitStatus`, `gitDiff`, artifact paths, execution mode, terminal app when relevant, and `doNotFallbackToDirectWrite: true`.

Ghostty configuration:

```env
TERMINAL_APP=ghostty
TERMINAL_FALLBACK_APP=Terminal
PREFER_GHOSTTY=true
DEFAULT_VISIBLE_MODE=codex-app-visible
```

App-server configuration:

```env
CODEX_APP_SERVER_MODE=auto
CODEX_APP_SERVER_URL=
CODEX_APP_SERVER_PORT=8765
CODEX_APP_SERVER_HOST=127.0.0.1
CODEX_APP_SERVER_TRANSPORT=ws
CODEX_APP_SERVER_AUTOSTART=true
CODEX_APP_SERVER_LOG_DIR=.vibe-codex/app-server
CODEX_APP_SERVER_ISOLATE_MCP_SERVERS=true
```

Modes:

- `disabled`: never use app-server.
- `manual`: only use `CODEX_APP_SERVER_URL`.
- `auto`: detect `CODEX_APP_SERVER_URL`, then detect `ws://127.0.0.1:<port>`, then start a local app-server when autostart is enabled.

Lifecycle tools:

- `detect_codex_app_server`: probe without starting.
- `start_codex_app_server`: start or connect to a local app-server.
- `stop_codex_app_server`: stop only a Vibe Codex-managed process.
- `restart_codex_app_server`: restart the managed process.
- `get_codex_app_server_status`: report availability, URL, transport, PID, log dir, and last error.

Vibe Codex does not GUI-automate Codex Desktop. App-thread tools only call local app-server APIs, bind startup to `127.0.0.1` by default, and the relay never exposes raw app-server access externally. If the user asks for no-paste Codex app execution, use `codex-app-thread`; if unavailable, call `start_codex_app_server`; if startup still fails, recommend `codex-app-visible` or `ghostty-visible`.

By default, Vibe Codex starts managed app-server with `-c 'mcp_servers={}'`. This isolates the no-paste app-thread bridge from unrelated Codex Desktop MCP/plugin auth failures while preserving the app-thread API needed for local Codex turns.

The project handoff prompt also tells Codex to keep searches scoped to the workspace root: use `rg --files` or `find .`, not `find ..`, unless the user explicitly asks to inspect parent directories.

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

`run_workspace_command` uses a strict command allowlist. Inline interpreter execution (`node -e`, `python -c`, `bash -c`), shell substitutions, pipes into interpreters, `sudo`, secret reads, and reverse-shell style commands are blocked. Unknown commands are treated as dangerous and are not executed.

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

Existing project workflow:

```text
User asks ChatGPT:
"Use the Vibe Codex project and continue the last Codex thread."

ChatGPT calls:
1. list_projects
2. register_project if the workspace is not registered yet
3. resume_project
4. start_project_task or continue_project_task
5. collect_project_result
```

Raw existing-thread message workflow:

```text
User asks ChatGPT:
"Send 'Hi from ChatGPT Web via Vibe Codex' to the Codex app chat named Implement Vibe Codex v0.1."

ChatGPT calls:
1. list_codex_threads
2. send_codex_app_thread_message with the exact plain message

Do not call start_project_task or continue_project_task for this workflow.
```

## Autonomy Levels

- `manual`: health, listing, safe reads, and prompt compilation only.
- `workspace`: workspace creation, file writes, git init, safe commands, Codex launch/tasks.
- `build-test`: `workspace` plus normal build/test/install commands.
- `full-project`: safe and normal project commands, file writes, and Codex tasks.

Blocked commands never run. Dangerous commands are not executed. Normal commands can be approval-gated with `REQUIRE_APPROVAL_FOR_NORMAL_COMMANDS=true`.

## Known Limitations

- Experimental OAuth tokens/codes are in-memory and reset when the relay restarts.
- Registered projects are persistent in SQLite, but app-server thread availability depends on the local Codex app/app-server runtime.
- `codex-app-visible` opens Codex Desktop and copies the prompt, but the user must paste/send it manually; completion is inferred from workspace changes.
- `ghostty-visible` launches normal interactive Codex in Ghostty with the initial prompt already submitted; completion is inferred from workspace changes.
- `terminal-visible` uses `codex exec` through the legacy visible script.
- `codex-app-thread` is experimental and requires a local Codex app-server URL; when unavailable, project tools return a clear fallback recommendation instead of silently switching to manual paste.
- `continue_project_task` can reuse a saved Codex thread ID with `codex-app-thread`; non-app-thread continuation is still approximated through saved run/workspace context.
- No live streaming yet.
- No graphical approval UI yet; approvals are MCP tool calls.
- Dangerous commands are rejected or approval-required instead of executed.
- The Codex app is opened for supervision only.
- Shell command strings are accepted after strict risk classification; stronger parsing is planned.

## Verification

Run the full local verification bundle:

```bash
npm run verify
```

This runs `npm run build`, `npm test`, then performs an in-process MCP smoke check for initialize, `tools/list`, the Vibe resources, `relay_health`, app-server status, and project registration reuse.

With `PUBLIC_BASE_URL` and OAuth enabled, run a tunneled OAuth smoke that mimics ChatGPT's dynamic client registration and MCP session flow:

```bash
npm run verify:public
```

This checks OAuth metadata, `/register`, `/authorize`, `/token`, MCP initialize, `tools/list`, Vibe resources, `relay_health`, `connector_setup_status`, app-server status, and registration of the current repository without creating a new workspace. Set `VERIFY_PROJECT_PATH=/path/to/repo` to register a different allowed workspace.

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
