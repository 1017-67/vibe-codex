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
import { continueCodexAppThread, detectCodexAppServer, forkCodexAppThread, getCodexAppThreadStatus, listCodexThreads, resumeCodexAppThread, startCodexAppThread } from "../codex/codexAppServerStub.js";
import { RunStore } from "../runs/runStore.js";
import { VibeError, toErrorPayload } from "../util/errors.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { classifyCommand } from "../safety/commandRisk.js";
import { authWarnings, buildConnectorUrl } from "../util/connector.js";
import { gitIsRepository } from "../workspace/git.js";

const Autonomy = z.enum(AUTONOMY_LEVELS as [AutonomyLevel, ...AutonomyLevel[]]);
const Template = z.enum(["empty", "node", "python", "vite", "next", "chrome-extension"]);
const ExecutionModeSchema = z.enum(["exec-hidden", "terminal-visible", "ghostty-visible", "app-supervised", "codex-app-thread"]);

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

  function findRunByCodexThreadId(threadId: string) {
    return runStore.listRuns().find((run) => run.metadata?.codexThreadId === threadId);
  }

  async function assertGitWorkspace(workspacePath: string) {
    if (!(await gitIsRepository(workspacePath, config))) {
      throw new VibeError("CONFIG_ERROR", "Workspace is not a Git repository. Run create_workspace with initGit=true or git init first. Vibe Codex will not auto-use --skip-git-repo-check.", { workspacePath });
    }
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
      terminal: {
        preferredApp: config.terminalApp,
        fallbackApp: config.terminalFallbackApp,
        preferGhostty: config.preferGhostty,
      },
      codexAppServer: await detectCodexAppServer(config),
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
      codexThreadId: z.string().optional(),
      continueExistingThread: z.boolean().optional(),
      forkThread: z.boolean().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const executionMode = (args.executionMode ?? (config.preferGhostty ? "ghostty-visible" : "terminal-visible")) as ExecutionMode;
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex tasks.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    if (!args.skipGitRepoCheckAllowed) await assertGitWorkspace(workspacePath);
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, context: args.context, constraints: args.constraints, nonGoals: args.nonGoals, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification, autonomy });

    if (executionMode === "terminal-visible" || executionMode === "ghostty-visible") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "Visible Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
      });
      if (approval) return approval;
      const run = await startTerminalVisibleCodexTask({ workspacePath, prompt, autonomy, config, runStore, executionMode });
      return {
        runId: run.id,
        status: run.status,
        executionMode,
        terminalApp: run.metadata?.terminalApp,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        logPath: run.metadata?.logPath,
        scriptPath: run.metadata?.scriptPath,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: executionMode === "ghostty-visible"
          ? "Codex is staged in Ghostty when available, falling back to macOS Terminal. The terminal shows the exact prompt and waits for Enter before starting. Ctrl+C cancels or stops the run."
          : "Codex is staged in a macOS Terminal window. The terminal shows the exact prompt and waits for Enter before starting. Ctrl+C cancels or stops the run.",
      };
    }

    if (executionMode === "codex-app-thread") {
      const detection = await detectCodexAppServer(config);
      if (!detection.available) {
        throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", detection.reason ?? "Codex app-server is unavailable. Use ghostty-visible for supervised runs.", detection.details as Record<string, unknown> | undefined);
      }
      const approval = maybeApproval("codex-visible", "Codex app-thread execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        codexThreadId: args.codexThreadId,
        continueExistingThread: args.continueExistingThread === true,
        forkThread: args.forkThread === true,
        autonomy,
      });
      if (approval) return approval;
      const response = args.codexThreadId && args.forkThread
        ? await forkCodexAppThread({ threadId: args.codexThreadId, workspacePath, instruction: prompt, config })
        : args.codexThreadId && args.continueExistingThread
          ? await resumeCodexAppThread({ threadId: args.codexThreadId, workspacePath, prompt, config })
          : await startCodexAppThread({ workspacePath, prompt, config });
      const threadId = typeof response === "object" && response && "threadId" in response ? String((response as { threadId: unknown }).threadId) : args.codexThreadId;
      const run = runStore.createRun({
        workspacePath,
        status: "running",
        autonomy,
        prompt,
        command: "codex-app-thread",
        metadata: {
          executionMode,
          codexThreadId: threadId,
          appServerResponse: response,
          previousCodexThreadId: args.codexThreadId,
          forkThread: args.forkThread === true,
          continueExistingThread: args.continueExistingThread === true,
        },
      });
      return {
        runId: run.id,
        status: run.status,
        executionMode,
        workspacePath,
        codexThreadId: threadId,
        appServerResponse: response,
        experimental: true,
        doNotFallbackToDirectWrite: true,
      };
    }

    if (executionMode === "app-supervised") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
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
    if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
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

  server.registerTool("detect_codex_app_server", {
    description: "Detect whether the experimental Codex app-server is configured and reachable. If unavailable, use ghostty-visible.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => detectCodexAppServer(config)));

  server.registerTool("list_codex_threads", {
    description: "List Codex app-server threads when the experimental app-server is available.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => listCodexThreads(config)));

  server.registerTool("start_codex_app_thread", {
    description: "Start an experimental Codex app-server thread for a safe workspace. Falls back by recommendation only; it does not GUI-automate Codex Desktop.",
    inputSchema: z.object({ workspacePath: z.string(), userGoal: z.string(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex app threads.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, autonomy });
    const response = await startCodexAppThread({ workspacePath, prompt, config });
    const threadId = typeof response === "object" && response && "threadId" in response ? String((response as { threadId: unknown }).threadId) : undefined;
    const run = runStore.createRun({ workspacePath, status: "running", autonomy, prompt, command: "codex-app-thread", metadata: { executionMode: "codex-app-thread", codexThreadId: threadId, appServerResponse: response } });
    return { runId: run.id, codexThreadId: threadId, response, experimental: true, doNotFallbackToDirectWrite: true };
  }));

  server.registerTool("resume_codex_app_thread", {
    description: "Resume an experimental Codex app-server thread in a safe workspace.",
    inputSchema: z.object({ threadId: z.string(), workspacePath: z.string(), prompt: z.string().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot resume Codex app threads.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const response = await resumeCodexAppThread({ threadId: args.threadId, workspacePath, prompt: args.prompt, config });
    const run = runStore.createRun({
      workspacePath,
      status: "running",
      autonomy,
      prompt: args.prompt ?? `Resume Codex app thread ${args.threadId}.`,
      command: "codex-app-thread resume",
      metadata: { executionMode: "codex-app-thread", codexThreadId: args.threadId, appServerResponse: response, operation: "resume" },
    });
    return { runId: run.id, threadId: args.threadId, workspacePath, response, experimental: true, doNotFallbackToDirectWrite: true };
  }));

  server.registerTool("continue_codex_app_thread", {
    description: "Send a follow-up instruction to an experimental Codex app-server thread.",
    inputSchema: z.object({ threadId: z.string(), instruction: z.string(), workspacePath: z.string().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot continue Codex app threads.", { autonomy });
    const priorRun = findRunByCodexThreadId(args.threadId);
    const workspacePath = args.workspacePath
      ? await assertSafeWorkspacePath(args.workspacePath, config)
      : priorRun?.workspacePath;
    if (!workspacePath) {
      throw new VibeError("CONFIG_ERROR", "workspacePath is required when no existing Vibe run mapping is known for this Codex thread.", { threadId: args.threadId });
    }
    await assertGitWorkspace(workspacePath);
    const response = await continueCodexAppThread({ threadId: args.threadId, instruction: args.instruction, config });
    const run = runStore.createRun({
      workspacePath,
      status: "running",
      autonomy,
      prompt: args.instruction,
      command: "codex-app-thread continue",
      metadata: { executionMode: "codex-app-thread", codexThreadId: args.threadId, previousRunId: priorRun?.id, appServerResponse: response, operation: "continue" },
    });
    return { runId: run.id, threadId: args.threadId, workspacePath, response, experimental: true, doNotFallbackToDirectWrite: true };
  }));

  server.registerTool("fork_codex_app_thread", {
    description: "Fork an experimental Codex app-server thread into a safe workspace.",
    inputSchema: z.object({ threadId: z.string(), workspacePath: z.string(), instruction: z.string().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot fork Codex app threads.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const response = await forkCodexAppThread({ threadId: args.threadId, workspacePath, instruction: args.instruction, config });
    const nextThreadId = typeof response === "object" && response && "threadId" in response ? String((response as { threadId: unknown }).threadId) : undefined;
    const run = runStore.createRun({
      workspacePath,
      status: "running",
      autonomy,
      prompt: args.instruction ?? `Fork Codex app thread ${args.threadId}.`,
      command: "codex-app-thread fork",
      metadata: { executionMode: "codex-app-thread", codexThreadId: nextThreadId, sourceCodexThreadId: args.threadId, appServerResponse: response, operation: "fork" },
    });
    return { runId: run.id, sourceThreadId: args.threadId, codexThreadId: nextThreadId, workspacePath, response, experimental: true, doNotFallbackToDirectWrite: true };
  }));

  server.registerTool("get_codex_app_thread_status", {
    description: "Get experimental Codex app-server thread status.",
    inputSchema: z.object({ threadId: z.string() }),
  }, async (args) => safeTool(async () => ({ threadId: args.threadId, response: await getCodexAppThreadStatus({ threadId: args.threadId, config }), experimental: true })));

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
