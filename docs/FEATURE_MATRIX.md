# Feature Matrix

This matrix is the operator-facing checklist for Vibe Codex as a ChatGPT App / MCP connector. It describes what each feature does, how ChatGPT should use it, which auth modes apply, whether it is no-paste or manual-paste, current test coverage, and important limits.

| Feature | MCP tools/resources | Status | Auth | Paste mode | Tests | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| OAuth connector auth | `/.well-known/oauth-*`, `/register`, `/authorize`, `/token`, `/revoke` | Working, experimental | OAuth | N/A | `tests/oauth.test.ts` | Dynamic client registration is unauthenticated for ChatGPT compatibility; keep behind a trusted tunnel. |
| URL-token fallback | `/mcp/:urlToken`, `/mcp?vibe_token=` | Working, dev fallback | No auth in ChatGPT UI plus long URL token | N/A | `tests/configAuth.test.ts`, `tests/mcpHttp.test.ts` | Dev-only; token appears in the URL and must stay private. |
| Relay health | `relay_health`, `vibe://status` | Working | Bearer, OAuth, URL-token | N/A | `tests/mcpHttp.test.ts`, `tests/oauth.test.ts` | Health can be degraded when Codex CLI is unavailable. |
| Connector setup/status | `connector_setup_status`, `get_connector_url`, `vibe://setup`, `vibe://operator-guide` | Working | Bearer, OAuth, URL-token | N/A | `tests/mcpHttp.test.ts` | Tunnel management is external; Vibe Codex reports URLs but does not start ngrok. |
| Project registry | `register_project`, `list_projects`, `get_project`, `resume_project`, `set_project_default_thread` | Working | Bearer, OAuth, URL-token | N/A | `tests/projectRegistry.test.ts`, `tests/mcpHttp.test.ts` | Registration validates existing workspaces; project task tools do not create new workspaces by default. |
| Project task start/continue/collect | `start_project_task`, `continue_project_task`, `collect_project_result`, `list_project_runs`, `list_project_threads` | Working | Bearer, OAuth, URL-token | Depends on execution mode | `tests/mcpHttp.test.ts` | These tools compile a Vibe Codex handoff envelope for implementation/inspection tasks. |
| `ghostty-visible` | `start_codex_task`, project task tools | Working fallback | Bearer, OAuth, URL-token | No-paste terminal | `tests/codexExec.test.ts` | Requires Ghostty for direct terminal launch; completion is inferred from Git changes. |
| `codex-app-thread` | `start_codex_app_thread`, `continue_codex_app_thread`, `run_codex_app_thread_turn`, `send_codex_app_thread_message`, `fork_codex_app_thread`, `get_codex_app_thread_status`, project task tools | Working experimental | Bearer, OAuth, URL-token | True no-paste app/thread | `tests/codexAppServerWsClient.test.ts`, `tests/mcpHttp.test.ts` | Requires a healthy local Codex app-server WebSocket API; app-server is never exposed publicly. |
| `codex-app-visible` / `app-supervised` | `start_codex_task`, `open_in_codex_app` | Working fallback | Bearer, OAuth, URL-token | Manual-paste GUI | `tests/codexExec.test.ts`, `tests/mcpHttp.test.ts` | Opens Codex Desktop and copies/writes the prompt; user must paste/send manually. |
| Raw thread messages | `send_codex_app_thread_message`, `run_codex_app_thread_turn`, `continue_codex_app_thread` | Working | Bearer, OAuth, URL-token | True no-paste app/thread | `tests/mcpHttp.test.ts` | Sends raw text to an existing Codex app thread; does not add a Vibe Codex handoff envelope. |
| Approval gates | `approve_action`, `reject_action`, `list_pending_approvals` | Working | Bearer, OAuth, URL-token | N/A | `tests/approvals.test.ts`, `tests/mcpHttp.test.ts` | Approval is one-time and in-memory. |
| Git status/diff/result collection | `git_status`, `git_diff`, `collect_visible_run_result`, `collect_project_result` | Working | Bearer, OAuth, URL-token | N/A | `tests/workspace.test.ts`, `tests/mcpHttp.test.ts` | Diff output is truncated by configured output limits. |
| App-server lifecycle | `detect_codex_app_server`, `start_codex_app_server`, `stop_codex_app_server`, `restart_codex_app_server`, `get_codex_app_server_status` | Working | Bearer, OAuth, URL-token | N/A | `tests/codexAppServerManager.test.ts`, `tests/mcpHttp.test.ts` | Auto-start binds to `127.0.0.1` by default and can isolate Codex MCP servers. |
| Safe workspace commands | `run_workspace_command` | Working | Bearer, OAuth, URL-token | N/A | `tests/commandRisk.test.ts`, `tests/mcpHttp.test.ts` | Strict allowlist; dangerous commands never execute. |
| Safe files | `list_files`, `read_file`, `write_file` | Working | Bearer, OAuth, URL-token | N/A | `tests/safety.test.ts`, `tests/workspace.test.ts` | `write_file` is direct-write and must not be used as fallback after Codex failure unless the user explicitly authorizes it. |

## Mode Truth

| Execution mode | Prompt submitted automatically | Requires manual paste | Uses `codex exec` | Uses shell script |
| --- | --- | --- | --- | --- |
| `codex-app-thread` | true | false | false | false |
| `ghostty-visible` | true | false | false | false |
| `codex-app-visible` | false | true | false | false |
| `app-supervised` | false | true | false | false |
| `exec-hidden` | true | false | true | false |
| `terminal-visible` legacy | true | false | true | true |

## Tool Selection Rules

- Use `start_project_task` / `continue_project_task` for implementation or inspection tasks in registered projects. These tools add the Vibe Codex handoff envelope.
- Use `send_codex_app_thread_message` or `run_codex_app_thread_turn` for plain raw messages to existing Codex app threads. These tools do not add the handoff envelope.
- Use `codex-app-thread` for true no-paste Codex app/thread execution.
- Use `ghostty-visible` as the no-paste terminal fallback when app-server is unavailable.
- Use `codex-app-visible` / `app-supervised` only as manual-paste GUI fallback.
- Never call `write_file` as a fallback after failed Codex execution unless the user explicitly authorizes direct writes.
- Never create a new workspace for a registered project task unless the user explicitly asks for new workspace creation.
