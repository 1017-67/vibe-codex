# Smoke Tests

These checks verify the local MCP relay, ChatGPT connector route, visible Codex run path, and security gates.

Security hardening checks:

- OAuth `/authorize` rejects unknown `client_id` values.
- OAuth `/register` is only available when `ENABLE_EXPERIMENTAL_OAUTH=true` and is rate-limited.
- MCP initialize floods eventually return `429`.
- `run_workspace_command` blocks `sudo`, secret reads, inline interpreters such as `node -e` / `python -c`, shell substitutions, and pipes into interpreters.
- Visible terminal scripts quote generated paths/messages, show the exact prompt before start, and write `**VIBE_CODEX_RUN_FINISHED**`.
- `detect_codex_app_server` returns a clear unavailable result unless `CODEX_APP_SERVER_URL` is configured and reachable.

## Local Build

```bash
npm install
npm run build
npm test
```

## Local MCP

Start the relay:

```bash
npm run dev
```

Initialize with bearer auth:

```bash
curl -sS -D /tmp/vibe-headers.txt \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  http://127.0.0.1:8787/mcp
```

Use the returned `mcp-session-id` header for `notifications/initialized`, `tools/list`, and `tools/call`.

## ChatGPT Connector

Generate a URL token:

```bash
npm run pair -- --write-env
```

Expose the relay with ngrok or another tunnel, then configure ChatGPT Developer Mode:

```text
Authentication: No auth
MCP URL: https://<ngrok-url>/mcp/<URL_TOKEN>
```

Call `relay_health`, then `connector_setup_status`.

## Visible Codex Run

1. Call `create_workspace` with `initGit: true`.
2. Call `start_codex_task` with default `executionMode` (`ghostty-visible` when `PREFER_GHOSTTY=true`) and a task that creates one file.
3. Watch Ghostty open. If Ghostty is unavailable, Vibe Codex falls back to macOS Terminal.
4. Confirm the window shows run ID, workspace, prompt path, log path, execution mode, redacted Codex command, and the full prompt.
5. Press Enter to start, or press Ctrl+C to cancel.
6. Let Codex complete.
7. Call `collect_visible_run_result`.
8. Confirm:
   - `status` is `completed_visible`.
   - `executionMode` is `ghostty-visible` or `terminal-visible`.
   - `terminalApp` is present.
   - `newChangedFilesSinceRun` contains the created file.
   - `gitStatus`, `gitDiff`, `promptPath`, `scriptPath`, and `logPath` are present.
   - `doNotFallbackToDirectWrite` is `true`.

## App-Thread Detection

1. Call `detect_codex_app_server`.
2. If `CODEX_APP_SERVER_URL` is unset, confirm:
   - `available` is `false`.
   - result recommends `ghostty-visible`.
3. If a Codex app-server is configured, call `list_codex_threads`, then `start_codex_app_thread` against a safe workspace.

## Legacy Terminal Visible Run

1. Call `create_workspace` with `initGit: true`.
2. Call `start_codex_task` with `executionMode: "terminal-visible"` and a task that creates one file.
3. Watch the Terminal window complete.
4. Call `collect_visible_run_result`.
5. Confirm:
   - `status` is `completed_visible`.
   - `newChangedFilesSinceRun` contains the created file.
   - `gitStatus` and `gitDiffSummary` are present.

## Security Negative Tests

- `run_workspace_command` with `sudo ls` returns blocked.
- `run_workspace_command` with `node -e "console.log(1)"` returns blocked.
- `run_workspace_command` with `git reset --hard` does not execute.
- `read_file` for `.env`, `.pem`, `.key`, `~/.ssh`, or `~/.codex` fails.
- `start_codex_task` with `executionMode: "exec-hidden"` requires `allowHiddenCodex: true` or approval.
- `start_codex_task` fails on a non-Git workspace unless `skipGitRepoCheckAllowed: true` is explicitly provided.
