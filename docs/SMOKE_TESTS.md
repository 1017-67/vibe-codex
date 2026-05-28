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

## Codex Desktop Visible Run

1. Call `create_workspace` with `initGit: true`.
2. Call `start_codex_task` with default `executionMode` (`codex-app-visible` when `DEFAULT_VISIBLE_MODE=codex-app-visible`) and a task that creates one file.
3. Confirm the tool returns `status: "app_visible_ready"`, `executionMode: "codex-app-visible"`, `promptPath`, `rootPromptPath`, `copiedToClipboard`, and `clipboardVerified`.
4. Watch Codex Desktop open with `codex app <workspace>`.
5. Confirm no generated `run-codex.sh`, `codex.log`, hidden exec, Ghostty, GUI typing, AppleScript, accessibility automation, or `codex exec` is used for `codex-app-visible`.
6. Paste/send the copied clipboard prompt manually in the Codex Desktop GUI. If the app shows `AGENTS.md`, ignore it and paste the clipboard contents, or open `VIBE_CODEX_PROMPT.md` / the returned `promptPath`.
7. Let Codex create the requested file.
8. Call `collect_visible_run_result`.
9. Confirm:
   - `status` is `completed_visible` after file changes appear, or `unknown_app_visible` if no completion can be inferred yet.
   - `executionMode` is `codex-app-visible`.
   - `newChangedFilesSinceRun` contains the created file.
   - `gitStatus`, `gitDiff`, and `promptPath` are present.
   - `scriptPath` and `logPath` are absent for `codex-app-visible`.
   - `doNotFallbackToDirectWrite` is `true`.

## Ghostty Visible Fallback

1. Call `start_codex_task` with `executionMode: "ghostty-visible"` and a task that creates one file.
2. Confirm the tool returns `status: "interactive_started"`, `promptPath`, and `promptSubmittedAutomatically: true`.
3. Watch Ghostty open normal interactive `codex` with the prompt already submitted.
4. Confirm no generated `run-codex.sh`, `codex.log`, hidden exec, shell pipe, GUI typing, or `codex exec` is used for `ghostty-visible`.
5. Let Codex create the requested file, then call `collect_visible_run_result`.

## MCP-Managed App-Server

1. Call `detect_codex_app_server`.
2. If `CODEX_APP_SERVER_MODE=disabled` or startup is unavailable, confirm:
   - `available` is `false`.
   - result includes `mode`, `transport`, and a `lastError` when available.
3. With `CODEX_APP_SERVER_MODE=auto`, call `start_codex_app_server`.
4. Confirm startup binds only to `127.0.0.1`, returns `available`, `url`, `listenUrl`, `transport`, `pid`, `startedByVibeCodex`, and `logDir`.
5. Call `get_codex_app_server_status`; confirm it matches the running server.
6. Call `list_codex_threads`, then `start_codex_app_thread` against a safe Git workspace.
7. Confirm app-thread responses include `runId`, `threadId`, `status`, `workspacePath`, and any returned `summary`/events.
8. For existing threads, smoke `continue_codex_app_thread`, `resume_codex_app_thread`, `fork_codex_app_thread`, and `get_codex_app_thread_status`.
9. Call `stop_codex_app_server`; confirm only the Vibe Codex-managed process stops.

## Registered Project Reuse

1. Call `register_project` for an existing Git workspace, for example:

   ```json
   {
     "name": "vibe-codex",
     "workspacePath": "/Users/<you>/vibe-codex",
     "preferredExecutionMode": "codex-app-thread"
   }
   ```

2. Confirm the result includes `createdWorkspace: false`, `reusedExistingWorkspace: true`, `projectId`, and the same `workspacePath`.
3. Call `list_projects` and `get_project`; confirm the registered project is returned with `lastUsedAt`.
4. Call `resume_project`; confirm the same workspace is returned and no new folder is created.
5. Call `start_project_task` with a harmless inspection prompt and `executionMode: "codex-app-thread"`.
6. If `CODEX_APP_SERVER_MODE=auto`, confirm Vibe Codex detects or starts the app-server; no `CODEX_APP_SERVER_URL` should be required.
7. If app-server startup fails, confirm the tool returns `CODEX_APP_SERVER_UNAVAILABLE` with fallback modes including `codex-app-visible` and `ghostty-visible`.
8. If app-server is available, confirm the tool returns `noPaste: true`, a `threadId`, `runId`, `projectId`, app-server status, and a prompt containing `Source: ChatGPT via Vibe Codex`.
9. Call `continue_project_task`; confirm it reuses the project's default thread when one was stored.
10. Call `list_project_runs`, `list_project_threads`, and `collect_project_result`; confirm run metadata links the same `projectId`, `workspacePath`, `runId`, and `threadId`.
11. Confirm no new workspace was created during `start_project_task` or `continue_project_task`.

## Legacy Terminal Visible Run

1. Call `create_workspace` with `initGit: true`.
2. Call `start_codex_task` with `executionMode: "terminal-visible"` and a task that creates one file.
3. Watch the generated Terminal script complete.
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
