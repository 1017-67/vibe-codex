import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config, AutonomyLevel, AUTONOMY_LEVELS } from "../config/types.js";
import { canRunCodex, canWriteFiles } from "../safety/approvals.js";
import { ApprovalStore, ActionRisk, approvalRequired, requiresApproval } from "../approvals/actionPolicy.js";
import { AuthSessionStore } from "../server/authSessions.js";
import { checkCodexAvailable, getCodexVersion } from "../codex/codexCli.js";
import { createWorkspace as createWorkspaceImpl, WorkspaceTemplate } from "../workspace/createWorkspace.js";
import { listFiles, readFile, writeFile } from "../workspace/files.js";
import { runWorkspaceCommand } from "../workspace/commands.js";
import { gitDiff, gitStatus } from "../workspace/git.js";
import { openCodexApp } from "../codex/codexApp.js";
import { compileCodexPrompt } from "../codex/promptCompiler.js";
import { collectVisibleRunResult, continueCodexTask, ExecutionMode, startAppSupervisedCodexTask, startCodexExecTask, startTerminalVisibleCodexTask } from "../codex/codexExec.js";
import { RunStore } from "../runs/runStore.js";
import { VibeError, toErrorPayload } from "../util/errors.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { classifyCommand } from "../safety/commandRisk.js";
import { authWarnings, buildConnectorUrl } from "../util/connector.js";
import { gitIsRepository } from "../workspace/git.js";

const Autonomy = z.enum(AUTONOMY_LEVELS as [AutonomyLevel, ...AutonomyLevel[]]);
const Template = z.enum(["empty", "node", "python", "vite", "next", "chrome-extension"]);
const ExecutionModeSchema = z.enum(["exec-hidden", "terminal-visible", "app-supervised"]);

function toolResult(output: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    structuredContent: output as Record<string, unknown>,
    isError,
  };
}

async function safeTool(fn: () => Promise<unknown>) {
  try {
    return toolResult(await fn());
  } catch (error) {
    return toolResult(toErrorPayload(error), true);
  }
}

async function discoverProjects(config: Config) {
  const projects = [];
  for (const root of config.allowedRoots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        try {
          await fs.stat(path.join(candidate, ".git"));
          projects.push({ id: `discovered:${candidate}`, name: entry.name, path: candidate });
        } catch {
          // Not a git project.
        }
      }
    } catch {
      // Skip unreadable allowed roots.
    }
  }
  return projects;
}

export function registerTools(server: McpServer, config: Config, runStore: RunStore, stores: { approvals: ApprovalStore; authSessions: AuthSessionStore }) {
  const approvalStore = stores.approvals;

  function maybeApproval(actionRisk: ActionRisk, reason: string, actionSummary: Record<string, unknown>) {
    if (!requiresApproval(config, actionRisk)) return null;
    if (approvalStore.consumeApproved(actionRisk, actionSummary)) return null;
    return approvalRequired(approvalStore.create({ reason, actionRisk, actionSummary }));
  }

  server.registerResource("vibe_status", "vibe://status", {
    title: "Vibe Codex Status",
    description: "Minimal JSON status resource for ChatGPT connector diagnostics.",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify({
        version: "0.2.0",
        allowedRoots: config.allowedRoots,
        defaultParentDir: config.defaultParentDir,
        urlTokenAuthEnabled: config.allowUrlTokenAuth,
        recentRuns: runStore.listRuns().slice(0, 5),
        pendingApprovals: approvalStore.list("pending"),
        authSessions: stores.authSessions.list(),
        warnings: authWarnings(config),
      }, null, 2),
    }],
  }));

  server.registerTool("relay_health", {
    description: "Check Vibe Codex relay health, Codex CLI availability, allowed roots, auth mode, and safety warnings.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => {
    const codexVersion = await getCodexVersion(config);
    return {
      status: codexVersion ? "ok" : "degraded",
      version: "0.2.0",
      codexAvailable: !!codexVersion,
      codexVersion: codexVersion ?? undefined,
      allowedRoots: config.allowedRoots,
      defaultParentDir: config.defaultParentDir,
      databasePath: config.databasePath,
      auth: {
        bearerEnabled: !config.disableAuth,
        urlTokenEnabled: config.allowUrlTokenAuth,
        urlTokenExpiresAt: config.urlTokenExpiresAt,
      },
      warnings: authWarnings(config),
    };
  }));

  server.registerTool("connector_setup_status", {
    description: "Show ChatGPT connector setup status, redacted connector URL template, recent runs, pending approvals, auth sessions, and safety warnings.",
    inputSchema: z.object({ baseUrl: z.string().url().optional(), recentRunLimit: z.number().int().min(1).max(20).optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const baseUrl = args?.baseUrl ?? config.publicBaseUrl;
    const recentRuns = runStore.listRuns().slice(0, args?.recentRunLimit ?? 5);
    const pendingApprovals = approvalStore.list("pending");
    return {
      status: "ok",
      version: "0.2.0",
      chatGptDeveloperMode: {
        authentication: "No auth",
        mcpUrl: baseUrl ? buildConnectorUrl({ baseUrl }) : "https://<ngrok-url>/mcp/<URL_TOKEN>",
        urlTokenAuthEnabled: config.allowUrlTokenAuth,
      },
      tunnel: {
        configured: !!baseUrl,
        publicBaseUrl: baseUrl,
      },
      codex: {
        available: await checkCodexAvailable(config),
        version: await getCodexVersion(config),
      },
      recentRuns,
      pendingApprovals,
      authSessions: stores.authSessions.list(),
      allowedRoots: config.allowedRoots,
      defaultParentDir: config.defaultParentDir,
      warnings: authWarnings(config),
      noFallbackPolicy: "Never use write_file to satisfy a failed Codex task unless the user explicitly authorizes fallback.",
    };
  }));

  server.registerTool("get_connector_url", {
    description: "Build a redacted ChatGPT Developer Mode MCP URL for a public tunnel base URL.",
    inputSchema: z.object({ baseUrl: z.string().url().optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const baseUrl = args?.baseUrl ?? config.publicBaseUrl;
    if (!baseUrl) throw new VibeError("CONFIG_ERROR", "Provide baseUrl or set PUBLIC_BASE_URL.", {});
    return {
      authentication: "No auth",
      mcpUrl: buildConnectorUrl({ baseUrl }),
      tokenRedacted: true,
      urlTokenAuthEnabled: config.allowUrlTokenAuth,
      warnings: authWarnings(config),
    };
  }));

  server.registerTool("list_projects", {
    description: "List known Vibe Codex projects, optionally discovering git repos under allowed roots.",
    inputSchema: z.object({ includeDiscovered: z.boolean().optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const stored = runStore.listProjects();
    const discovered = args?.includeDiscovered ? await discoverProjects(config) : [];
    return { projects: [...stored, ...discovered] };
  }));

  server.registerTool("create_workspace", {
    description: "Create a new workspace under an allowed root with an optional starter template.",
    inputSchema: z.object({
      name: z.string(),
      parentDir: z.string().optional(),
      template: Template.optional(),
      initGit: z.boolean().optional(),
      createAgentsMd: z.boolean().optional(),
      autonomy: Autonomy.optional(),
      userNotes: z.string().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const result = await createWorkspaceImpl({
      name: args.name,
      parentDir: args.parentDir,
      template: args.template as WorkspaceTemplate | undefined,
      initGit: args.initGit ?? true,
      createAgentsMd: args.createAgentsMd ?? true,
      autonomy,
      userNotes: args.userNotes,
      config,
    });
    const project = runStore.createProject({ name: args.name, path: result.workspacePath });
    return { ...result, projectId: project.id };
  }));

  server.registerTool("list_files", {
    description: "List safe files inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), relativeDir: z.string().optional(), maxDepth: z.number().int().min(0).max(10).optional() }),
  }, async (args) => safeTool(async () => ({ files: await listFiles(args.workspacePath, args.relativeDir, args.maxDepth ?? 3, config) })));

  server.registerTool("read_file", {
    description: "Read a safe non-secret file inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), relativePath: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => readFile(args.workspacePath, args.relativePath, config, args.maxBytes ?? 200_000)));

  server.registerTool("write_file", {
    description: "Write a file inside a workspace when autonomy allows writes. Do not use direct write_file as fallback for a failed Codex task unless the user explicitly authorizes fallback.",
    inputSchema: z.object({ workspacePath: z.string(), relativePath: z.string(), content: z.string(), overwrite: z.boolean().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canWriteFiles(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot write files.", { autonomy });
    const approval = maybeApproval("write", "Direct file writes require local approval.", {
      tool: "write_file",
      workspacePath: args.workspacePath,
      relativePath: args.relativePath,
      overwrite: args.overwrite ?? false,
      autonomy,
    });
    if (approval) return approval;
    const result = await writeFile(args.workspacePath, args.relativePath, args.content, args.overwrite ?? false, config);
    return { ...result, directWrite: true, doNotUseAsCodexFallbackWithoutUserApproval: true };
  }));

  server.registerTool("run_workspace_command", {
    description: "Run a risk-classified command inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), command: z.string(), autonomy: Autonomy.optional(), timeoutMs: z.number().int().positive().optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const classified = classifyCommand(args.command);
    if (classified.risk === "normal") {
      const approval = maybeApproval("execute", "Normal workspace commands require local approval.", {
        tool: "run_workspace_command",
        workspacePath: args.workspacePath,
        command: args.command,
        autonomy,
      });
      if (approval) return approval;
    }
    return runWorkspaceCommand({ workspacePath: args.workspacePath, command: args.command, autonomy, timeoutMs: args.timeoutMs, config });
  }));

  server.registerTool("open_in_codex_app", {
    description: "Open a workspace in the Codex desktop app for visual supervision.",
    inputSchema: z.object({ workspacePath: z.string() }),
  }, async (args) => safeTool(async () => {
    const result = await openCodexApp(args.workspacePath, config);
    return { opened: result.exitCode === 0, command: result.command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }));

  server.registerTool("start_codex_task", {
    description: "Compile a precise prompt and start a Codex task. Hidden Codex requires explicit approval; direct write_file must not be used as fallback after a failed Codex task unless the user explicitly authorizes fallback.",
    inputSchema: z.object({
      workspacePath: z.string(),
      userGoal: z.string(),
      context: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      nonGoals: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
      autonomy: Autonomy.optional(),
      openApp: z.boolean().optional(),
      executionMode: ExecutionModeSchema.optional(),
      allowHiddenCodex: z.boolean().optional(),
      skipGitRepoCheckAllowed: z.boolean().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const executionMode = (args.executionMode ?? "terminal-visible") as ExecutionMode;
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex tasks.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    if (!args.skipGitRepoCheckAllowed && !(await gitIsRepository(workspacePath, config))) {
      throw new VibeError("CONFIG_ERROR", "Workspace is not a Git repository. Run create_workspace with initGit=true or git init first. Vibe Codex will not auto-use --skip-git-repo-check.", { workspacePath });
    }
    if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, context: args.context, constraints: args.constraints, nonGoals: args.nonGoals, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification, autonomy });

    if (executionMode === "terminal-visible") {
      const approval = maybeApproval("codex-visible", "Visible Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
      });
      if (approval) return approval;
      const run = await startTerminalVisibleCodexTask({ workspacePath, prompt, autonomy, config, runStore });
      return {
        runId: run.id,
        status: run.status,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        logPath: run.metadata?.logPath,
        scriptPath: run.metadata?.scriptPath,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: "Codex is running visibly in a macOS Terminal window. Use collect_visible_run_result to read the log and diff later.",
      };
    }

    if (executionMode === "app-supervised") {
      const approval = maybeApproval("codex-visible", "App-supervised Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
      });
      if (approval) return approval;
      const run = await startAppSupervisedCodexTask({ workspacePath, prompt, autonomy, config, runStore, openApp: true, copyClipboard: true });
      return {
        runId: run.id,
        status: run.status,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        appOpened: run.metadata?.appOpened,
        clipboardCopied: run.metadata?.clipboardCopied,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: "Codex app has been opened. The prompt was copied to the clipboard if pbcopy was available; paste it into Codex app to run visibly.",
      };
    }

    const hiddenApprovalSummary = {
      tool: "start_codex_task",
      executionMode,
      workspacePath,
      userGoal: args.userGoal,
      autonomy,
      allowHiddenCodex: args.allowHiddenCodex === true,
      skipGitRepoCheckAllowed: args.skipGitRepoCheckAllowed === true,
    };
    let hiddenApprovedByOneTimeApproval = false;
    if (!args.allowHiddenCodex) {
      if (approvalStore.consumeApproved("codex-hidden", hiddenApprovalSummary)) {
        hiddenApprovedByOneTimeApproval = true;
      } else {
      const approval = approvalRequired(approvalStore.create({
        reason: "Hidden Codex execution requires explicit allowHiddenCodex=true or one-time local approval.",
        actionRisk: "codex-hidden",
        actionSummary: hiddenApprovalSummary,
      }));
      return { ...approval, doNotFallbackToDirectWrite: true };
      }
    }
    const approval = hiddenApprovedByOneTimeApproval ? null : maybeApproval("codex-hidden", "Hidden Codex execution requires local approval.", hiddenApprovalSummary);
    if (approval) return { ...approval, doNotFallbackToDirectWrite: true };
    if (args.openApp) await openCodexApp(workspacePath, config);
    const run = await startCodexExecTask({ workspacePath, prompt, autonomy, config, runStore });
    const status = await gitStatus(workspacePath, config).catch(() => undefined);
    const diff = await gitDiff(workspacePath, config, 80_000).catch(() => undefined);
    return {
      runId: run.id,
      status: run.status,
      workspacePath,
      prompt,
      codexStdout: run.stdout,
      codexStderr: run.stderr,
      exitCode: run.exitCode,
      gitStatus: status?.stdout,
      gitDiffSummary: diff?.stdout,
      doNotFallbackToDirectWrite: true,
    };
  }));

  server.registerTool("collect_visible_run_result", {
    description: "Collect prompt/log/git status/git diff for a terminal-visible or app-supervised Vibe Codex run.",
    inputSchema: z.object({ runId: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => collectVisibleRunResult({ runId: args.runId, config, runStore, maxBytes: args.maxBytes })));

  server.registerTool("list_recent_runs", {
    description: "List recent Vibe Codex runs with status, workspace, execution mode, and key artifact paths.",
    inputSchema: z.object({ workspacePath: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }).optional(),
  }, async (args) => safeTool(async () => {
    const runs = runStore.listRuns(args?.workspacePath).slice(0, args?.limit ?? 10);
    return { runs };
  }));

  server.registerTool("continue_codex_task", {
    description: "Approximate continuation by running another hidden codex exec with saved run context. Hidden Codex requires explicit approval; do not use direct write_file as fallback unless the user explicitly authorizes fallback.",
    inputSchema: z.object({ runId: z.string(), instruction: z.string(), autonomy: Autonomy.optional(), allowHiddenCodex: z.boolean().optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot continue Codex tasks.", { autonomy });
    const prior = runStore.getRun(args.runId);
    const summary = { tool: "continue_codex_task", runId: args.runId, workspacePath: prior?.workspacePath, autonomy, allowHiddenCodex: args.allowHiddenCodex === true };
    let hiddenApprovedByOneTimeApproval = false;
    if (!args.allowHiddenCodex) {
      if (approvalStore.consumeApproved("codex-hidden", summary)) {
        hiddenApprovedByOneTimeApproval = true;
      } else {
      return { ...approvalRequired(approvalStore.create({ reason: "Hidden Codex continuation requires explicit allowHiddenCodex=true or one-time local approval.", actionRisk: "codex-hidden", actionSummary: summary })), doNotFallbackToDirectWrite: true };
      }
    }
    const approval = hiddenApprovedByOneTimeApproval ? null : maybeApproval("codex-hidden", "Hidden Codex continuation requires local approval.", summary);
    if (approval) return { ...approval, doNotFallbackToDirectWrite: true };
    const run = await continueCodexTask({ runId: args.runId, instruction: args.instruction, autonomy, config, runStore });
    const status = await gitStatus(run.workspacePath, config).catch(() => undefined);
    const diff = await gitDiff(run.workspacePath, config, 80_000).catch(() => undefined);
    return {
      runId: run.id,
      previousRunId: run.metadata?.previousRunId,
      status: run.status,
      codexStdout: run.stdout,
      codexStderr: run.stderr,
      exitCode: run.exitCode,
      gitStatus: status?.stdout,
      gitDiffSummary: diff?.stdout,
      doNotFallbackToDirectWrite: true,
    };
  }));

  server.registerTool("approve_action", {
    description: "Approve a pending Vibe Codex local action gate. Approval is one-time and consumed by the next matching tool call.",
    inputSchema: z.object({ approvalId: z.string() }),
  }, async (args) => safeTool(async () => {
    const approval = approvalStore.approve(args.approvalId);
    if (!approval) throw new VibeError("CONFIG_ERROR", "Approval not found.", { approvalId: args.approvalId });
    return { approval };
  }));

  server.registerTool("list_pending_approvals", {
    description: "List pending Vibe Codex local approval gates.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => ({ approvals: approvalStore.list("pending") })));

  server.registerTool("reject_action", {
    description: "Reject a pending Vibe Codex local action gate.",
    inputSchema: z.object({ approvalId: z.string(), reason: z.string().optional() }),
  }, async (args) => safeTool(async () => {
    const approval = approvalStore.reject(args.approvalId, args.reason);
    if (!approval) throw new VibeError("CONFIG_ERROR", "Approval not found.", { approvalId: args.approvalId });
    return { approval };
  }));

  server.registerTool("get_run", {
    description: "Get a stored Codex run record.",
    inputSchema: z.object({ runId: z.string() }),
  }, async (args) => safeTool(async () => {
    const run = runStore.getRun(args.runId);
    if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
    return { run };
  }));

  server.registerTool("git_status", {
    description: "Get git status for a workspace.",
    inputSchema: z.object({ workspacePath: z.string() }),
  }, async (args) => safeTool(async () => ({ status: (await gitStatus(args.workspacePath, config)).stdout })));

  server.registerTool("git_diff", {
    description: "Get git diff for a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => {
    const result = await gitDiff(args.workspacePath, config, args.maxBytes ?? 200_000);
    return { diff: result.stdout, truncated: result.stdout.includes("[output truncated]") };
  }));
}
