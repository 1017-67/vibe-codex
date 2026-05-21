import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config, AutonomyLevel, AUTONOMY_LEVELS } from "../config/types.js";
import { canRunCodex, canWriteFiles } from "../safety/approvals.js";
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

export function registerTools(server: McpServer, config: Config, runStore: RunStore) {
  server.registerTool("relay_health", {
    description: "Check Vibe Codex relay health and Codex CLI availability.",
    inputSchema: z.object({}).optional(),
  }, async () => safeTool(async () => {
    const codexVersion = await getCodexVersion(config);
    return {
      status: codexVersion ? "ok" : "degraded",
      version: "0.1.0",
      codexAvailable: !!codexVersion,
      codexVersion: codexVersion ?? undefined,
      allowedRoots: config.allowedRoots,
      defaultParentDir: config.defaultParentDir,
      databasePath: config.databasePath,
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
    description: "Write a file inside a workspace when autonomy allows writes.",
    inputSchema: z.object({ workspacePath: z.string(), relativePath: z.string(), content: z.string(), overwrite: z.boolean().optional(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canWriteFiles(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot write files.", { autonomy });
    return writeFile(args.workspacePath, args.relativePath, args.content, args.overwrite ?? false, config);
  }));

  server.registerTool("run_workspace_command", {
    description: "Run a risk-classified command inside a workspace.",
    inputSchema: z.object({ workspacePath: z.string(), command: z.string(), autonomy: Autonomy.optional(), timeoutMs: z.number().int().positive().optional() }),
  }, async (args) => safeTool(async () => runWorkspaceCommand({ workspacePath: args.workspacePath, command: args.command, autonomy: args.autonomy ?? "workspace", timeoutMs: args.timeoutMs, config })));

  server.registerTool("open_in_codex_app", {
    description: "Open a workspace in the Codex desktop app for visual supervision.",
    inputSchema: z.object({ workspacePath: z.string() }),
  }, async (args) => safeTool(async () => {
    const result = await openCodexApp(args.workspacePath, config);
    return { opened: result.exitCode === 0, command: result.command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }));

  server.registerTool("start_codex_task", {
    description: "Compile a precise prompt and start a Codex task in hidden, terminal-visible, or app-supervised mode.",
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
    }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    const executionMode = (args.executionMode ?? "terminal-visible") as ExecutionMode;
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot start Codex tasks.", { autonomy });
    const workspacePath = await assertSafeWorkspacePath(args.workspacePath, config);
    if (!(await checkCodexAvailable(config))) throw new VibeError("CODEX_NOT_AVAILABLE", "Codex CLI is not available.", { codexBin: config.codexBin });
    const prompt = compileCodexPrompt({ workspacePath, userGoal: args.userGoal, context: args.context, constraints: args.constraints, nonGoals: args.nonGoals, acceptanceCriteria: args.acceptanceCriteria, verification: args.verification, autonomy });

    if (executionMode === "terminal-visible") {
      const run = await startTerminalVisibleCodexTask({ workspacePath, prompt, autonomy, config, runStore });
      return {
        runId: run.id,
        status: run.status,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        logPath: run.metadata?.logPath,
        scriptPath: run.metadata?.scriptPath,
        message: "Codex is running visibly in a macOS Terminal window. Use collect_visible_run_result to read the log and diff later.",
      };
    }

    if (executionMode === "app-supervised") {
      const run = await startAppSupervisedCodexTask({ workspacePath, prompt, autonomy, config, runStore, openApp: true, copyClipboard: true });
      return {
        runId: run.id,
        status: run.status,
        workspacePath,
        prompt,
        promptPath: run.metadata?.promptPath,
        appOpened: run.metadata?.appOpened,
        clipboardCopied: run.metadata?.clipboardCopied,
        message: "Codex app has been opened. The prompt was copied to the clipboard if pbcopy was available; paste it into Codex app to run visibly.",
      };
    }

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
    };
  }));

  server.registerTool("collect_visible_run_result", {
    description: "Collect prompt/log/git status/git diff for a terminal-visible or app-supervised Vibe Codex run.",
    inputSchema: z.object({ runId: z.string(), maxBytes: z.number().int().positive().max(1_000_000).optional() }),
  }, async (args) => safeTool(async () => collectVisibleRunResult({ runId: args.runId, config, runStore, maxBytes: args.maxBytes })));

  server.registerTool("continue_codex_task", {
    description: "Approximate continuation by running another codex exec with saved run context.",
    inputSchema: z.object({ runId: z.string(), instruction: z.string(), autonomy: Autonomy.optional() }),
  }, async (args) => safeTool(async () => {
    const autonomy = args.autonomy ?? "workspace";
    if (!canRunCodex(autonomy)) throw new VibeError("APPROVAL_REQUIRED", "Manual autonomy cannot continue Codex tasks.", { autonomy });
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
    };
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
