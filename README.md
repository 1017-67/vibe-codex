# Vibe Codex

Tell ChatGPT what to build. Watch Codex do it.

Vibe Codex is a local MCP server that lets ChatGPT orchestrate Codex CLI inside approved folders on your Mac. The Codex desktop app can be opened for supervision, but v0.1 automation goes through `codex exec`, not GUI typing.

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

This project is designed as a local relay, not a public remote shell. Keep it bound to trusted networks, use a strong `RELAY_TOKEN`, and expose it to ChatGPT only through a secure tunnel you control. Dangerous commands are not executed in v0.1; they return approval-required or blocked results.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` before exposing the server:

```env
PORT=8787
RELAY_TOKEN=change-me
ALLOWED_ROOTS=/Users/liuhc/Projects,/Users/liuhc/Desktop/codex-work,/Users/liuhc/furina-corpus
DEFAULT_PARENT_DIR=/Users/liuhc/Projects
CODEX_BIN=codex
DATABASE_PATH=./vibe-codex.sqlite
DEFAULT_CODEX_APPROVAL=untrusted
DEFAULT_CODEX_SANDBOX=workspace-write
ALLOW_NETWORK_COMMANDS=false
MAX_COMMAND_OUTPUT_BYTES=200000
COMMAND_TIMEOUT_MS=120000
CODEX_TIMEOUT_MS=900000
```

`RELAY_TOKEN` is required unless you explicitly run in development mode. `ALLOWED_ROOTS` defines the only directories Vibe Codex can touch. `DEFAULT_PARENT_DIR` is where new workspaces are created by default.

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

## Tools

- `relay_health`
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

## Codex Execution Modes

`start_codex_task` accepts `executionMode`:

- `terminal-visible` is the default. It writes `.vibe-codex/runs/<runId>/prompt.md` and `run-codex.sh`, then opens the script in macOS Terminal so you can watch Codex run. Poll with `collect_visible_run_result`.
- `exec-hidden` runs `codex exec` synchronously and returns captured stdout/stderr.
- `app-supervised` opens `codex app <workspace>`, writes the prompt file, and copies the prompt to the clipboard with `pbcopy` when available. Paste it into the Codex app manually.

## Example Workflow

```text
User asks ChatGPT:
"Create a new repo for my Chrome extension anti-doomscrolling prototype. Open it in Codex and ask Codex to build the MVP."

ChatGPT calls:
1. create_workspace
2. open_in_codex_app
3. start_codex_task
4. git_status
5. git_diff
6. continue_codex_task if needed
```

## Autonomy Levels

- `manual`: health, listing, safe reads, and prompt compilation only.
- `workspace`: workspace creation, file writes, git init, safe commands, Codex launch/tasks.
- `build-test`: `workspace` plus normal build/test/install commands.
- `full-project`: safe and normal project commands, file writes, and Codex tasks.

Blocked commands never run. Dangerous commands require a future approval system and do not execute in v0.1.

## Known Limitations

- v0.1 uses `codex exec`, not true Codex desktop thread control.
- Continuation is approximated through saved run context.
- No live streaming yet.
- No approval UI yet.
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
