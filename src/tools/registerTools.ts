import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { compileProjectCodexPrompt } from "../codex/projectPrompt.js";
import { collectVisibleRunResult, continueCodexTask, ExecutionMode, startAppSupervisedCodexTask, startCodexAppVisibleTask, startCodexExecTask, startGhosttyInteractiveCodexTask, startTerminalVisibleCodexTask } from "../codex/codexExec.js";
import { configWithManagedAppServerUrl, detectManagedCodexAppServer, ensureCodexAppServer, restartManagedCodexAppServer, startManagedCodexAppServer, stopManagedCodexAppServer } from "../codex/codexAppServerManager.js";
import { continueCodexAppThreadWs, forkCodexAppThreadWs, getCodexAppThreadStatusWs, listCodexThreadsWs, resumeCodexAppThreadWs, startCodexAppThreadWs } from "../codex/codexAppServerWsClient.js";
import { RunStore } from "../runs/runStore.js";
import { VibeError, toErrorPayload } from "../util/errors.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { classifyCommand } from "../safety/commandRisk.js";
import { authWarnings, buildConnectorUrl } from "../util/connector.js";
import { gitIsRepository } from "../workspace/git.js";

const Autonomy = z.enum(AUTONOMY_LEVELS as [AutonomyLevel, ...AutonomyLevel[]]);
const Template = z.enum(["empty", "node", "python", "vite", "next", "chrome-extension"]);
const ExecutionModeSchema = z.enum(["exec-hidden", "terminal-visible", "ghostty-visible", "codex-app-visible", "app-supervised", "codex-app-thread"]);
const ProjectExecutionModeSchema = z.enum(["codex-app-thread", "codex-app-visible", "ghostty-visible"]);

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

  function appThreadOutput(args: {
    runId: string;
    workspacePath: string;
    response: unknown;
    fallbackThreadId?: string;
    sourceThreadId?: string;
  }) {
    const normalized = normalizeAppThreadResponse(args.response);
    const threadId = normalized.threadId ?? args.fallbackThreadId;
    return {
      runId: args.runId,
      threadId,
      codexThreadId: threadId,
      sourceThreadId: args.sourceThreadId,
      status: appThreadRunStatus(normalized.status),
      appServerStatus: normalized.status,
      workspacePath: args.workspacePath,
      summary: normalized.summary,
      appServerEvents: normalized.events,
      appServerResponse: args.response,
      promptSubmittedAutomatically: true,
      usesCodexExec: false,
      usesShellScript: false,
      requiresManualPaste: false,
      experimental: true,
      doNotFallbackToDirectWrite: true,
    };
  }

  function appServerFallbackDetails(details: unknown) {
    const record = typeof details === "object" && details !== null ? details as Record<string, unknown> : {};
    return { recommendedExecutionMode: "ghostty-visible", fallbackExecutionModes: ["ghostty-visible", "codex-app-visible", "app-supervised"], ...record };
  }

  function appThreadRunStatus(status: string | undefined) {
    const normalized = status?.toLowerCase();
    if (normalized === "failed" || normalized === "error" || normalized === "cancelled" || normalized === "canceled") return "failed";
    if (normalized === "completed" || normalized === "complete" || normalized === "done" || normalized === "succeeded" || normalized === "success") return "completed";
    return "running";
  }

  function partialThreadIdFromError(error: unknown): string | undefined {
    if (!(error instanceof VibeError)) return undefined;
    const threadId = error.details.codexThreadId ?? error.details.threadId;
    return typeof threadId === "string" ? threadId : undefined;
  }

  function partialAppThreadMetadata(error: unknown): Record<string, unknown> {
    if (!(error instanceof VibeError)) return {};
    return {
      codexThreadId: partialThreadIdFromError(error),
      appServerResponse: error.details.threadResponse,
      appServerEvents: error.details.events,
      appServerError: { code: error.code, message: error.message, details: error.details },
      turnStartFailed: error.details.turnStartFailed === true,
    };
  }

  function normalizeAppThreadResponse(response: unknown): {
    threadId?: string;
    status?: string;
    summary?: string;
    events?: unknown[];
  } {
    if (typeof response !== "object" || response === null) return {};
    const record = response as Record<string, unknown>;
    const threadResponse = typeof record.threadResponse === "object" && record.threadResponse !== null ? record.threadResponse as Record<string, unknown> : undefined;
    const turnResponse = typeof record.turnResponse === "object" && record.turnResponse !== null ? record.turnResponse as Record<string, unknown> : undefined;
    const thread = typeof threadResponse?.thread === "object" && threadResponse.thread !== null
      ? threadResponse.thread as Record<string, unknown>
      : typeof record.thread === "object" && record.thread !== null
        ? record.thread as Record<string, unknown>
        : undefined;
    const turn = typeof turnResponse?.turn === "object" && turnResponse.turn !== null ? turnResponse.turn as Record<string, unknown> : undefined;
    const status = typeof turn?.status === "string"
      ? turn.status
      : typeof thread?.status === "string"
        ? thread.status
        : typeof (thread?.status as Record<string, unknown> | undefined)?.type === "string"
          ? (thread?.status as Record<string, unknown>).type as string
          : typeof record.status === "string"
            ? record.status
            : undefined;
    return {
      threadId: typeof record.threadId === "string" ? record.threadId : typeof thread?.id === "string" ? thread.id : undefined,
      status,
      summary: typeof record.summary === "string" ? record.summary : undefined,
      events: Array.isArray(record.events) ? record.events : [],
    };
  }

  async function resolveProject(projectRef: string) {
    const byId = runStore.getProject(projectRef);
    if (byId) return byId;
    const byName = runStore.getProjectByName(projectRef);
    if (byName) return byName;
    const safePath = await assertSafeWorkspacePath(projectRef, config).catch(() => undefined);
    if (safePath) {
      const byPath = runStore.getProjectByPath(safePath);
      if (byPath) return byPath;
    }
    throw new VibeError("CONFIG_ERROR", "Registered project not found.", { projectRef });
  }

  function rememberProjectThread(projectId: string, threadId: string | undefined, setDefault = false) {
    if (!threadId) return runStore.touchProject(projectId);
    const project = runStore.getProject(projectId);
    if (!project) throw new VibeError("CONFIG_ERROR", "Project not found.", { projectId });
    const recent = [threadId, ...(project.recentCodexThreadIds ?? []).filter((id) => id !== threadId)].slice(0, 10);
    return runStore.updateProject(projectId, {
      recentCodexThreadIds: recent,
      defaultCodexThreadId: setDefault ? threadId : project.defaultCodexThreadId,
      lastUsedAt: new Date().toISOString(),
    });
  }

  async function gitStatusText(workspacePath: string) {
    return (await gitStatus(workspacePath, config).catch(() => undefined))?.stdout ?? "";
  }

  async function projectFallbackError() {
    const detection = await detectManagedCodexAppServer(config);
    return new VibeError("CODEX_APP_SERVER_UNAVAILABLE", detection.lastError ?? "Codex app-server is unavailable. Use app-supervised/codex-app-visible for manual GUI fallback or ghostty-visible for terminal automatic submission.", {
      ...appServerFallbackDetails({ status: detection }),
      recommendedExecutionMode: "ghostty-visible",
      fallbackExecutionModes: ["ghostty-visible", "codex-app-visible", "app-supervised"],
      noPasteRequires: "A healthy local Codex app-server managed by Vibe Codex or configured with CODEX_APP_SERVER_URL",
    });
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
        version: "0.2.1",
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
      version: "0.2.1",
      codexAvailable: !!codexVersion,
      codexVersion: codexVersion ?? undefined,
      terminal: {
        preferredApp: config.terminalApp,
        fallbackApp: config.terminalFallbackApp,
        preferGhostty: config.preferGhostty,
        defaultVisibleMode: config.defaultVisibleMode,
      },
      codexAppServer: await detectManagedCodexAppServer(config),
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
    const connectorUsesOAuth = config.enableExperimentalOAuth;
    const mcpUrl = baseUrl
      ? connectorUsesOAuth
        ? `${baseUrl.replace(/\/+$/, "")}/mcp`
        : buildConnectorUrl({ baseUrl })
      : connectorUsesOAuth
        ? "https://<ngrok-url>/mcp"
        : "https://<ngrok-url>/mcp/<URL_TOKEN>";
    return {
      status: "ok",
      version: "0.2.1",
      chatGptDeveloperMode: {
        authentication: connectorUsesOAuth ? "OAuth" : "No auth",
        mcpUrl,
        oauthEnabled: config.enableExperimentalOAuth,
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
    const connectorUsesOAuth = config.enableExperimentalOAuth;
    return {
      authentication: connectorUsesOAuth ? "OAuth" : "No auth",
      mcpUrl: connectorUsesOAuth ? `${baseUrl.replace(/\/+$/, "")}/mcp` : buildConnectorUrl({ baseUrl }),
      tokenRedacted: !connectorUsesOAuth,
      oauthEnabled: config.enableExperimentalOAuth,
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

  server.registerTool("register_project", {
    description: "Register an existing workspace as a persistent Vibe Codex project. This does not create a new workspace.",
    inputSchema: z.object({
      name: z.string(),
      workspacePath: z.string(),
      repoRemote: z.string().optional(),
      preferredExecutionMode: ProjectExecutionModeSchema.optional(),
      defaultCodexThreadId: z.string().optional(),
      notes: z.string().optional(),
    }),
  }, async (args) => safeTool(async () => {
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const project = runStore.createProject({
      name: args.name,
      path: workspacePath,
      repoRemote: args.repoRemote,
      preferredExecutionMode: args.preferredExecutionMode ?? "codex-app-thread",
      defaultCodexThreadId: args.defaultCodexThreadId,
      recentCodexThreadIds: args.defaultCodexThreadId ? [args.defaultCodexThreadId] : [],
      notes: args.notes,
    });
    return { project, reusedExistingWorkspace: true, createdWorkspace: false };
  }));

  server.registerTool("get_project", {
    description: "Get a registered Vibe Codex project by projectId, name, or workspace path.",
    inputSchema: z.object({ projectRef: z.string() }),
  }, async (args) => safeTool(async () => ({ project: await resolveProject(args.projectRef) })));

  server.registerTool("resume_project", {
    description: "Resolve a registered project and show its default thread and recent runs without creating a workspace.",
    inputSchema: z.object({ projectRef: z.string(), recentRunLimit: z.number().int().min(1).max(20).optional() }),
  }, async (args) => safeTool(async () => {
    const project = runStore.touchProject((await resolveProject(args.projectRef)).id);
    const runs = runStore.listRuns(project.path).filter((run) => run.metadata?.projectId === project.id).slice(0, args.recentRunLimit ?? 10);
    return { project, runs, defaultCodexThreadId: project.defaultCodexThreadId, recentCodexThreadIds: project.recentCodexThreadIds ?? [] };
  }));

  server.registerTool("set_project_default_thread", {
    description: "Set the default Codex app-server thread for a registered project.",
    inputSchema: z.object({ projectRef: z.string(), codexThreadId: z.string() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    return { project: rememberProjectThread(project.id, args.codexThreadId, true) };
  }));

  server.registerTool("list_project_runs", {
    description: "List persisted Vibe Codex runs for a registered project.",
    inputSchema: z.object({ projectRef: z.string(), limit: z.number().int().min(1).max(50).optional() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    const runs = runStore.listRuns(project.path).filter((run) => run.metadata?.projectId === project.id).slice(0, args.limit ?? 20);
    return { project, runs };
  }));

  server.registerTool("list_project_threads", {
    description: "List remembered Codex thread ids for a registered project.",
    inputSchema: z.object({ projectRef: z.string() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    return { projectId: project.id, defaultCodexThreadId: project.defaultCodexThreadId, recentCodexThreadIds: project.recentCodexThreadIds ?? [] };
  }));

  server.registerTool("start_project_task", {
    description: "Start an implementation or inspection task in an existing registered project. This compiles a Vibe Codex handoff prompt. Do not use it to send a plain message to an existing Codex chat; use list_codex_threads then continue_codex_app_thread instead.",
    inputSchema: z.object({
      projectRef: z.string(),
      userGoal: z.string(),
      executionMode: ProjectExecutionModeSchema.optional(),
      autonomy: Autonomy.optional(),
      codexThreadId: z.string().optional(),
      forkThread: z.boolean().optional(),
      setDefaultThread: z.boolean().optional(),
      context: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start project tasks.", { autonomy });
    const project = await resolveProject(args.projectRef);
    const workspacePath = await assertSafeWorkspacePath(project.path, config);
    await assertGitWorkspace(workspacePath);
    const executionMode = args.executionMode ?? project.preferredExecutionMode ?? "codex-app-thread";
    if (executionMode === "codex-app-thread") {
      const detection = await ensureCodexAppServer(config);
      if (!detection.available) throw await projectFallbackError();
      const appServerConfig = configWithManagedAppServerUrl(config, detection);
      const placeholder = runStore.createRun({
        projectId: project.id,
        workspacePath,
        status: "queued",
        autonomy,
        prompt: args.userGoal,
        command: "codex-app-thread project pending",
        metadata: { projectId: project.id, executionMode, codexThreadId: args.codexThreadId, baselineGitStatus: await gitStatusText(workspacePath) },
      });
      const sourceThreadId = args.codexThreadId ?? project.defaultCodexThreadId;
      const prompt = compileProjectCodexPrompt({ project, runId: placeholder.id, workspacePath, userGoal: args.userGoal, executionMode, autonomy, codexThreadId: sourceThreadId, context: args.context, constraints: args.constraints, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification });
      let response: unknown;
      try {
        response = sourceThreadId && args.forkThread
          ? await forkCodexAppThreadWs({ threadId: sourceThreadId, workspacePath, instruction: prompt, config: appServerConfig })
          : sourceThreadId
            ? await continueCodexAppThreadWs({ threadId: sourceThreadId, workspacePath, instruction: prompt, config: appServerConfig })
            : await startCodexAppThreadWs({ workspacePath, prompt, config: appServerConfig });
      } catch (error) {
        const partialThreadId = partialThreadIdFromError(error);
        runStore.updateRun(placeholder.id, {
          status: "failed",
          prompt,
          codexCommand: "codex-app-thread project",
          metadata: {
            ...placeholder.metadata,
            projectId: project.id,
            executionMode,
            ...partialAppThreadMetadata(error),
          },
        });
        rememberProjectThread(project.id, partialThreadId, args.setDefaultThread ?? true);
        throw error;
      }
      const normalized = normalizeAppThreadResponse(response);
      const threadId = normalized.threadId ?? sourceThreadId;
      const run = runStore.updateRun(placeholder.id, {
        status: appThreadRunStatus(normalized.status),
        prompt,
        codexCommand: "codex-app-thread project",
        metadata: {
          ...placeholder.metadata,
          projectId: project.id,
          executionMode,
          codexThreadId: threadId,
          appServerResponse: response,
          appServerEvents: normalized.events,
          appServerSummary: normalized.summary,
          summary: normalized.summary,
        },
      });
      const updatedProject = rememberProjectThread(project.id, threadId, args.setDefaultThread ?? true);
      return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: threadId, sourceThreadId: args.forkThread ? sourceThreadId : undefined }), project: updatedProject, executionMode, appServer: detection, noPaste: true, createdWorkspace: false };
    }
    if (executionMode === "ghostty-visible") {
      const promptRunId = randomUUID();
      const prompt = compileProjectCodexPrompt({ project, runId: promptRunId, workspacePath, userGoal: args.userGoal, executionMode, autonomy, context: args.context, constraints: args.constraints, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification });
      const run = await startGhosttyInteractiveCodexTask({ workspacePath, prompt, autonomy, config, runStore });
      runStore.updateRun(run.id, { metadata: { ...(run.metadata ?? {}), projectId: project.id, executionMode, baselineGitStatus: await gitStatusText(workspacePath) } });
      runStore.touchProject(project.id);
      return {
        runId: run.id,
        projectId: project.id,
        status: run.status,
        executionMode,
        workspacePath,
        promptPath: run.metadata?.promptPath,
        createdWorkspace: false,
        noPaste: true,
        terminalApp: run.metadata?.terminalApp,
        launchedCodexDirectly: run.metadata?.launchedCodexDirectly === true,
        promptSubmittedAutomatically: run.metadata?.promptSubmittedAutomatically === true,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: false,
      };
    }
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "codex-app-visible/app-supervised is manual paste fallback. Use start_codex_task or select ghostty-visible when app-server is unavailable.", { recommendedExecutionMode: "codex-app-thread", fallbackExecutionModes: ["app-supervised", "codex-app-visible", "ghostty-visible"] });
  }));

  server.registerTool("continue_project_task", {
    description: "Continue an implementation or inspection task for a registered project using the project's default Codex thread. This compiles a Vibe Codex handoff prompt. Do not use it to send a plain message to an existing Codex chat; use continue_codex_app_thread instead.",
    inputSchema: z.object({ projectRef: z.string(), instruction: z.string(), executionMode: ProjectExecutionModeSchema.optional(), autonomy: Autonomy.optional(), codexThreadId: z.string().optional(), setDefaultThread: z.boolean().optional() }),
  }, async (args) => safeTool(async () => {
    const project = await resolveProject(args.projectRef);
    const threadId = args.codexThreadId ?? project.defaultCodexThreadId;
    if (!threadId) throw new VibeError("CONFIG_ERROR", "No codexThreadId provided and project has no default Codex thread.", { projectId: project.id, fallbackExecutionModes: ["start_project_task", "ghostty-visible", "app-supervised"] });
    const autonomy = args.autonomy ?? "workspace";
    const executionMode = args.executionMode ?? "codex-app-thread";
    if (executionMode !== "codex-app-thread") throw new VibeError("CONFIG_ERROR", "continue_project_task uses codex-app-thread for no-paste continuation.", { executionMode });
    const detection = await ensureCodexAppServer(config);
    if (!detection.available) throw await projectFallbackError();
    const appServerConfig = configWithManagedAppServerUrl(config, detection);
    const workspacePath = await assertSafeWorkspacePath(project.path, config);
    await assertGitWorkspace(workspacePath);
    const placeholder = runStore.createRun({ projectId: project.id, workspacePath, status: "queued", autonomy, prompt: args.instruction, command: "codex-app-thread project continue pending", metadata: { projectId: project.id, executionMode, codexThreadId: threadId, baselineGitStatus: await gitStatusText(workspacePath) } });
    const prompt = compileProjectCodexPrompt({ project, runId: placeholder.id, workspacePath, userGoal: args.instruction, executionMode, autonomy, codexThreadId: threadId });
    let response: Awaited<ReturnType<typeof continueCodexAppThreadWs>>;
    try {
      response = await continueCodexAppThreadWs({ threadId, workspacePath, instruction: prompt, config: appServerConfig });
    } catch (error) {
      runStore.updateRun(placeholder.id, {
        status: "failed",
        prompt,
        codexCommand: "codex-app-thread project continue",
        metadata: {
          ...placeholder.metadata,
          projectId: project.id,
          executionMode,
          codexThreadId: threadId,
          ...partialAppThreadMetadata(error),
        },
      });
      rememberProjectThread(project.id, partialThreadIdFromError(error) ?? threadId, args.setDefaultThread ?? true);
      throw error;
    }
    const normalized = normalizeAppThreadResponse(response);
    const nextThreadId = normalized.threadId ?? threadId;
    const run = runStore.updateRun(placeholder.id, { status: appThreadRunStatus(normalized.status), prompt, codexCommand: "codex-app-thread project continue", metadata: { ...placeholder.metadata, projectId: project.id, executionMode, codexThreadId: nextThreadId, parentRunId: runStore.listRuns(project.path).find((candidate) => candidate.metadata?.codexThreadId === threadId)?.id, appServerResponse: response, appServerEvents: normalized.events, appServerSummary: normalized.summary, summary: normalized.summary } });
    const updatedProject = rememberProjectThread(project.id, nextThreadId, args.setDefaultThread ?? true);
    return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: nextThreadId }), project: updatedProject, executionMode, appServer: detection, noPaste: true, createdWorkspace: false };
  }));

  server.registerTool("collect_project_result", {
    description: "Collect git status/diff and changed files for a project run, updating project-linked run metadata.",
    inputSchema: z.object({ runId: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => {
    const run = runStore.getRun(args.runId);
    if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
    const projectId = typeof run.metadata?.projectId === "string" ? run.metadata.projectId : undefined;
    const visibleModes = ["codex-app-visible", "app-supervised", "ghostty-visible", "terminal-visible"];
    if (typeof run.metadata?.executionMode === "string" && visibleModes.includes(run.metadata.executionMode)) {
      const collected = await collectVisibleRunResult({ runId: args.runId, config, runStore, maxBytes: args.maxBytes });
      return { projectId, ...collected };
    }
    const finalStatus = await gitStatusText(run.workspacePath);
    const baseline = typeof run.metadata?.baselineGitStatus === "string" ? run.metadata.baselineGitStatus : "";
    const changedFiles = finalStatus.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.slice(3).trim()).filter((file) => !file.startsWith(".vibe-codex/"));
    const baselineFiles = new Set(baseline.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.slice(3).trim()).filter((file) => !file.startsWith(".vibe-codex/")));
    const newChangedFilesSinceRun = changedFiles.filter((file) => !baselineFiles.has(file));
    const diff = await gitDiff(run.workspacePath, config, args.maxBytes ?? 80_000).catch(() => undefined);
    const updated = runStore.updateRun(run.id, { metadata: { ...(run.metadata ?? {}), finalGitStatus: finalStatus, changedFilesSinceRun: changedFiles, newChangedFilesSinceRun } });
    return { run: updated, projectId, status: updated.status, gitStatus: finalStatus, gitDiffSummary: diff?.stdout ?? "", changedFilesSinceRun: changedFiles, newChangedFilesSinceRun };
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
    const executionMode = (args.executionMode ?? (args.codexThreadId ? "codex-app-thread" : config.defaultVisibleMode)) as ExecutionMode;
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex tasks.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    if (!args.skipGitRepoCheckAllowed) await assertGitWorkspace(workspacePath);
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, context: args.context, constraints: args.constraints, nonGoals: args.nonGoals, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification, autonomy });

    if (executionMode === "ghostty-visible") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "Interactive Codex execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
      });
      if (approval) return approval;
      const run = await startGhosttyInteractiveCodexTask({ workspacePath, prompt, autonomy, config, runStore });
      return {
        runId: run.id,
        status: run.status,
        executionMode,
        terminalApp: run.metadata?.terminalApp,
        workspacePath,
        promptPath: run.metadata?.promptPath,
        copiedToClipboard: run.metadata?.copiedToClipboard === true,
        launchedCodexDirectly: run.metadata?.launchedCodexDirectly === true,
        promptSubmittedAutomatically: run.metadata?.promptSubmittedAutomatically === true,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: false,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: run.metadata?.launchedCodexDirectly === true
          ? "Ghostty opened normal interactive Codex with the prompt submitted as the initial Codex prompt. No script, codex exec, shell pipe, or GUI typing was used."
          : `${String(run.metadata?.terminalApp ?? "Terminal")} opened in the workspace. Type \`codex\` and use the prompt saved at ${String(run.metadata?.promptPath ?? "prompt.md")}. No script, codex exec, shell pipe, or GUI typing was used.`,
      };
    }

    if (executionMode === "terminal-visible") {
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
        message: "Codex is staged in a macOS Terminal window using the legacy visible script. The terminal shows the exact prompt and waits for Enter before starting. Ctrl+C cancels or stops the run.",
      };
    }

    if (executionMode === "codex-app-thread") {
      const detection = await ensureCodexAppServer(config);
      if (!detection.available) {
        throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", detection.lastError ?? "Codex app-server is unavailable. Use codex-app-visible or ghostty-visible for supervised runs.", appServerFallbackDetails({ status: detection }));
      }
      const appServerConfig = configWithManagedAppServerUrl(config, detection);
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
      let response: unknown;
      try {
        response = args.codexThreadId && args.forkThread
          ? await forkCodexAppThreadWs({ threadId: args.codexThreadId, workspacePath, instruction: prompt, config: appServerConfig })
          : args.codexThreadId && args.continueExistingThread
            ? await resumeCodexAppThreadWs({ threadId: args.codexThreadId, workspacePath, prompt, config: appServerConfig })
            : await startCodexAppThreadWs({ workspacePath, prompt, config: appServerConfig });
      } catch (error) {
        const partialThreadId = partialThreadIdFromError(error);
        if (partialThreadId) {
          runStore.createRun({
            workspacePath,
            status: "failed",
            autonomy,
            prompt,
            command: "codex-app-thread",
            metadata: {
              executionMode,
              previousCodexThreadId: args.codexThreadId,
              forkThread: args.forkThread === true,
              continueExistingThread: args.continueExistingThread === true,
              ...partialAppThreadMetadata(error),
            },
          });
        }
        throw error;
      }
      const normalized = normalizeAppThreadResponse(response);
      const threadId = normalized.threadId ?? args.codexThreadId;
      const run = runStore.createRun({
        workspacePath,
        status: appThreadRunStatus(normalized.status),
        autonomy,
        prompt,
        command: "codex-app-thread",
        metadata: {
          executionMode,
          codexThreadId: threadId,
          appServerResponse: response,
          appServerEvents: normalized.events,
          appServerSummary: normalized.summary,
          previousCodexThreadId: args.codexThreadId,
          forkThread: args.forkThread === true,
          continueExistingThread: args.continueExistingThread === true,
        },
      });
      return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: threadId, sourceThreadId: args.forkThread ? args.codexThreadId : undefined }), executionMode, appServer: detection };
    }

    if (executionMode === "codex-app-visible") {
      if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
      const approval = maybeApproval("codex-visible", "Codex Desktop visible execution requires local approval.", {
        tool: "start_codex_task",
        executionMode,
        workspacePath,
        userGoal: args.userGoal,
        autonomy,
      });
      if (approval) return approval;
      const run = await startCodexAppVisibleTask({ workspacePath, prompt, autonomy, config, runStore, openApp: true, copyClipboard: true });
      return {
        runId: run.id,
        status: "app_visible_ready",
        executionMode,
        workspacePath,
        promptPath: run.metadata?.promptPath,
        rootPromptPath: run.metadata?.rootPromptPath,
        metadataPath: run.metadata?.metadataPath,
        copiedToClipboard: run.metadata?.copiedToClipboard === true,
        clipboardVerified: run.metadata?.clipboardVerified === true,
        appOpened: run.metadata?.appOpened,
        promptSubmittedAutomatically: false,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: true,
        requiresVisibleSupervision: true,
        doNotFallbackToDirectWrite: true,
        message: "Codex Desktop opened; prompt copied and verified; paste/send the clipboard prompt in the GUI. If the app shows AGENTS.md, ignore it and paste the clipboard contents, or open VIBE_CODEX_PROMPT.md / the returned promptPath. No codex exec, Ghostty, shell script, GUI typing, AppleScript, or accessibility automation was used.",
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
        metadataPath: run.metadata?.metadataPath,
        appOpened: run.metadata?.appOpened,
        clipboardCopied: run.metadata?.clipboardCopied,
        promptSubmittedAutomatically: false,
        usesCodexExec: false,
        usesShellScript: false,
        requiresManualPaste: true,
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
    description: "Collect prompt/log/git status/git diff for a visible or interactive Vibe Codex run.",
    inputSchema: z.object({ runId: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => collectVisibleRunResult({ runId: args.runId, config, runStore, maxBytes: args.maxBytes })));

  server.registerTool("detect_codex_app_server", {
    description: "Detect whether a local Codex app-server is reachable through Vibe Codex manager. Does not start it.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => detectManagedCodexAppServer(config)));

  server.registerTool("start_codex_app_server", {
    description: "Start or connect to a local 127.0.0.1 Codex app-server for no-paste codex-app-thread execution.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => startManagedCodexAppServer(config)));

  server.registerTool("stop_codex_app_server", {
    description: "Stop the Codex app-server process started by Vibe Codex. Does not stop externally managed servers.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => stopManagedCodexAppServer(config)));

  server.registerTool("restart_codex_app_server", {
    description: "Restart the Vibe Codex-managed local Codex app-server.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => restartManagedCodexAppServer(config)));

  server.registerTool("get_codex_app_server_status", {
    description: "Get current Vibe Codex app-server manager status including URL, transport, PID, and last error.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => detectManagedCodexAppServer(config)));

  server.registerTool("list_codex_threads", {
    description: "List local Codex app-server chats/threads. Use this to find an existing Codex chat by name, preview, or thread id before sending a plain follow-up with continue_codex_app_thread.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => {
    const status = await ensureCodexAppServer(config);
    return listCodexThreadsWs({ config: configWithManagedAppServerUrl(config, status) });
  }));

  server.registerTool("start_codex_app_thread", {
    description: "Start a new local Codex app-server thread for a safe workspace. This compiles a normal Codex task prompt for new work. For an existing named chat, use list_codex_threads then continue_codex_app_thread.",
    inputSchema: z.object({ workspacePath: z.string(), userGoal: z.string().describe("Goal for a new Codex task, not a plain message to an existing chat."), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex app threads.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, autonomy });
    const status = await ensureCodexAppServer(config);
    let response: unknown;
    try {
      response = await startCodexAppThreadWs({ workspacePath, prompt, config: configWithManagedAppServerUrl(config, status) });
    } catch (error) {
      const partialThreadId = partialThreadIdFromError(error);
      if (partialThreadId) {
        runStore.createRun({
          workspacePath,
          status: "failed",
          autonomy,
          prompt,
          command: "codex-app-thread",
          metadata: { executionMode: "codex-app-thread", ...partialAppThreadMetadata(error) },
        });
      }
      throw error;
    }
    const normalized = normalizeAppThreadResponse(response);
    const run = runStore.createRun({ workspacePath, status: appThreadRunStatus(normalized.status), autonomy, prompt, command: "codex-app-thread", metadata: { executionMode: "codex-app-thread", codexThreadId: normalized.threadId, appServerResponse: response, appServerEvents: normalized.events, appServerSummary: normalized.summary } });
    return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: normalized.threadId }), appServer: status };
  }));

  server.registerTool("resume_codex_app_thread", {
    description: "Resume an existing local Codex app-server thread in a safe workspace. If prompt is provided, it is sent as raw Codex input without a Vibe project handoff envelope.",
    inputSchema: z.object({ threadId: z.string(), workspacePath: z.string(), prompt: z.string().describe("Optional raw text to submit to the existing Codex thread.").optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot resume Codex app threads.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const status = await ensureCodexAppServer(config);
    const response = await resumeCodexAppThreadWs({ threadId: args.threadId, workspacePath, prompt: args.prompt, config: configWithManagedAppServerUrl(config, status) });
    const normalized = normalizeAppThreadResponse(response);
    const threadId = normalized.threadId ?? args.threadId;
    const run = runStore.createRun({
      workspacePath,
      status: appThreadRunStatus(normalized.status),
      autonomy,
      prompt: args.prompt ?? `Resume Codex app thread ${args.threadId}.`,
      command: "codex-app-thread resume",
      metadata: { executionMode: "codex-app-thread", codexThreadId: threadId, appServerResponse: response, appServerEvents: normalized.events, appServerSummary: normalized.summary, operation: "resume" },
    });
    return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: threadId }), appServer: status };
  }));

  async function runLocalCodexThreadTurn(args: { threadId: string; instruction: string; workspacePath?: string; autonomy?: AutonomyLevel }) {
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
    const status = await ensureCodexAppServer(config);
    const response = await continueCodexAppThreadWs({ threadId: args.threadId, instruction: args.instruction, workspacePath, config: configWithManagedAppServerUrl(config, status) });
    const normalized = normalizeAppThreadResponse(response);
    const threadId = normalized.threadId ?? args.threadId;
    const run = runStore.createRun({
      workspacePath,
      status: appThreadRunStatus(normalized.status),
      autonomy,
      prompt: args.instruction,
      command: "codex-app-thread continue",
      metadata: { executionMode: "codex-app-thread", codexThreadId: threadId, previousRunId: priorRun?.id, appServerResponse: response, appServerEvents: normalized.events, appServerSummary: normalized.summary, operation: "continue" },
    });
    return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: threadId }), appServer: status };
  }

  server.registerTool("continue_codex_app_thread", {
    description: "Send raw text as a local Codex app-server turn in an existing Codex chat/thread on this Mac. Use this when the user asks to send a plain message to a named Codex app chat. This targets the user's local code agent, not a person or external messaging service, and it does not add a Vibe Codex handoff envelope.",
    inputSchema: z.object({
      threadId: z.string().describe("Existing Codex app-server thread id, usually found with list_codex_threads."),
      instruction: z.string().describe("Raw text to submit to the existing Codex chat/thread. Do not wrap this in a Vibe Codex handoff envelope for simple message delivery."),
      workspacePath: z.string().optional().describe("Safe workspace path for the thread when Vibe Codex has no prior run mapping."),
      autonomy: Autonomy.optional(),
    }),
  }, async (args) => safeTool(async () => {
    return runLocalCodexThreadTurn(args);
  }));

  server.registerTool("run_codex_app_thread_turn", {
    description: "Alias for continue_codex_app_thread. Send one raw no-paste turn to an existing local Codex app chat/thread. Use this for simple message delivery; it does not create a project task and does not add a Vibe Codex handoff envelope.",
    inputSchema: z.object({
      threadId: z.string().describe("Existing Codex app-server thread id, usually found with list_codex_threads."),
      instruction: z.string().optional().describe("Raw text to submit exactly as the Codex app thread turn."),
      task: z.string().optional().describe("Deprecated alias for instruction, kept for older ChatGPT tool handles."),
      workspacePath: z.string().optional().describe("Safe workspace path for the thread when Vibe Codex has no prior run mapping."),
      autonomy: Autonomy.optional(),
    }).refine((value) => !!(value.instruction ?? value.task), { message: "instruction or task is required" }),
  }, async (args) => safeTool(async () => {
    return runLocalCodexThreadTurn({ threadId: args.threadId, instruction: args.instruction ?? args.task!, workspacePath: args.workspacePath, autonomy: args.autonomy });
  }));

  server.registerTool("send_codex_app_thread_message", {
    description: "Send a plain raw message to an existing local Codex app chat/thread by thread id. Use list_codex_threads first when the user names a Codex chat. This is no-paste app-server delivery and does not add a Vibe Codex handoff envelope.",
    inputSchema: z.object({
      threadId: z.string().describe("Existing Codex app-server thread id, usually found with list_codex_threads."),
      message: z.string().describe("Plain message text to submit exactly to the Codex chat/thread."),
      workspacePath: z.string().optional().describe("Safe workspace path for the thread when Vibe Codex has no prior run mapping."),
      autonomy: Autonomy.optional(),
    }),
  }, async (args) => safeTool(async () => {
    return runLocalCodexThreadTurn({ threadId: args.threadId, instruction: args.message, workspacePath: args.workspacePath, autonomy: args.autonomy });
  }));

  server.registerTool("fork_codex_app_thread", {
    description: "Fork an experimental Codex app-server thread into a safe workspace.",
    inputSchema: z.object({ threadId: z.string(), workspacePath: z.string(), instruction: z.string().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot fork Codex app threads.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    await assertGitWorkspace(workspacePath);
    const status = await ensureCodexAppServer(config);
    const response = await forkCodexAppThreadWs({ threadId: args.threadId, workspacePath, instruction: args.instruction, config: configWithManagedAppServerUrl(config, status) });
    const normalized = normalizeAppThreadResponse(response);
    const nextThreadId = normalized.threadId;
    const run = runStore.createRun({
      workspacePath,
      status: appThreadRunStatus(normalized.status),
      autonomy,
      prompt: args.instruction ?? `Fork Codex app thread ${args.threadId}.`,
      command: "codex-app-thread fork",
      metadata: { executionMode: "codex-app-thread", codexThreadId: nextThreadId, sourceCodexThreadId: args.threadId, appServerResponse: response, appServerEvents: normalized.events, appServerSummary: normalized.summary, operation: "fork" },
    });
    return { ...appThreadOutput({ runId: run.id, workspacePath, response, fallbackThreadId: nextThreadId, sourceThreadId: args.threadId }), appServer: status };
  }));

  server.registerTool("get_codex_app_thread_status", {
    description: "Get experimental Codex app-server thread status.",
    inputSchema: z.object({ threadId: z.string() }),
  }, async (args) => safeTool(async () => {
    const status = await ensureCodexAppServer(config);
    const response = await getCodexAppThreadStatusWs({ threadId: args.threadId, config: configWithManagedAppServerUrl(config, status) });
    const normalized = normalizeAppThreadResponse(response);
    return {
      threadId: normalized.threadId ?? args.threadId,
      codexThreadId: normalized.threadId ?? args.threadId,
      status: normalized.status,
      summary: normalized.summary,
      appServerEvents: normalized.events,
      appServerResponse: response,
      appServer: status,
      experimental: true,
    };
  }));

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
