import fs from "node:fs/promises";
import path from "node:path";
import { Config, AutonomyLevel } from "../config/types.js";
import { gitDiff, gitStatus } from "../workspace/git.js";
import { RunStore } from "../runs/runStore.js";
import { RunRecord } from "../runs/types.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { runProcessArgv } from "../util/spawn.js";
import { compileCodexPrompt } from "./promptCompiler.js";
import { logger } from "../util/logger.js";
import { VibeError } from "../util/errors.js";

export type ExecutionMode = "exec-hidden" | "terminal-visible" | "ghostty-visible" | "app-supervised" | "codex-app-thread";

export interface CodexExecCapabilities {
  supportsSandbox: boolean;
  supportsExecAskForApproval: boolean;
  supportsGlobalAskForApproval: boolean;
}

const SANDBOX_VALUES = ["read-only", "workspace-write", "danger-full-access"] as const;
const APPROVAL_VALUES = ["untrusted", "on-failure", "on-request", "never"] as const;

function normalizeSandbox(value: string | undefined): string {
  if (value && (SANDBOX_VALUES as readonly string[]).includes(value)) return value;
  if (value) logger.warn("unsupported_codex_sandbox_fallback", { configured: value, fallback: "workspace-write" });
  return "workspace-write";
}

function normalizeApproval(value: string | undefined): string {
  if (value && (APPROVAL_VALUES as readonly string[]).includes(value)) return value;
  if (value) logger.warn("unsupported_codex_approval_fallback", { configured: value, fallback: "untrusted" });
  return "untrusted";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function inspectCodexExecCapabilities(config: Config): Promise<CodexExecCapabilities> {
  const [execHelp, globalHelp] = await Promise.all([
    runProcessArgv({ file: config.codexBin, args: ["exec", "--help"], timeoutMs: 10_000, maxOutputBytes: 50_000 }),
    runProcessArgv({ file: config.codexBin, args: ["--help"], timeoutMs: 10_000, maxOutputBytes: 50_000 }),
  ]);
  const execText = `${execHelp.stdout}\n${execHelp.stderr}`;
  const globalText = `${globalHelp.stdout}\n${globalHelp.stderr}`;
  return {
    supportsSandbox: execText.includes("--sandbox") || globalText.includes("--sandbox"),
    supportsExecAskForApproval: execText.includes("--ask-for-approval"),
    supportsGlobalAskForApproval: globalText.includes("--ask-for-approval"),
  };
}

export function buildCodexExecArgv(args: {
  prompt: string;
  sandbox?: string;
  approval?: string;
  capabilities: CodexExecCapabilities;
}): string[] {
  const sandbox = normalizeSandbox(args.sandbox);
  const approval = normalizeApproval(args.approval);
  const argv: string[] = [];
  if (args.capabilities.supportsGlobalAskForApproval && !args.capabilities.supportsExecAskForApproval) {
    argv.push("--ask-for-approval", approval);
  }
  argv.push("exec");
  if (args.capabilities.supportsSandbox) argv.push("--sandbox", sandbox);
  if (args.capabilities.supportsExecAskForApproval) argv.push("--ask-for-approval", approval);
  if (!args.capabilities.supportsGlobalAskForApproval && !args.capabilities.supportsExecAskForApproval) {
    logger.warn("codex_approval_flag_unsupported", { fallback: "omitting ask-for-approval flag" });
  }
  argv.push(args.prompt);
  return argv;
}

function codexArgs(prompt: string, config: Config, capabilities: CodexExecCapabilities): string[] {
  const args = buildCodexExecArgv({
    prompt,
    sandbox: config.defaultCodexSandbox,
    approval: config.defaultCodexApproval,
    capabilities,
  });
  if (args.includes("--approval")) {
    throw new VibeError("CODEX_EXEC_FAILED", "Internal error: deprecated --approval flag must not be used.");
  }
  return args;
}

function codexScriptCommand(config: Config, capabilities: CodexExecCapabilities, promptPath: string): string {
  const sandbox = normalizeSandbox(config.defaultCodexSandbox);
  const approval = normalizeApproval(config.defaultCodexApproval);
  const parts: string[] = [shellQuote(config.codexBin)];
  if (capabilities.supportsGlobalAskForApproval && !capabilities.supportsExecAskForApproval) {
    parts.push("--ask-for-approval", shellQuote(approval));
  }
  parts.push("exec");
  if (capabilities.supportsSandbox) parts.push("--sandbox", shellQuote(sandbox));
  if (capabilities.supportsExecAskForApproval) parts.push("--ask-for-approval", shellQuote(approval));
  parts.push(`"$(cat ${shellQuote(promptPath)})"`);
  return parts.join(" ");
}

function redactedCodexScriptCommand(config: Config, capabilities: CodexExecCapabilities): string {
  const sandbox = normalizeSandbox(config.defaultCodexSandbox);
  const approval = normalizeApproval(config.defaultCodexApproval);
  const parts: string[] = [config.codexBin];
  if (capabilities.supportsGlobalAskForApproval && !capabilities.supportsExecAskForApproval) {
    parts.push("--ask-for-approval", approval);
  }
  parts.push("exec");
  if (capabilities.supportsSandbox) parts.push("--sandbox", sandbox);
  if (capabilities.supportsExecAskForApproval) parts.push("--ask-for-approval", approval);
  parts.push("<prompt from prompt.md>");
  return parts.join(" ");
}

async function ensureRunDir(workspacePath: string, runId: string) {
  const runDir = path.join(workspacePath, ".vibe-codex", "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

async function writePrompt(runDir: string, prompt: string) {
  const promptPath = path.join(runDir, "prompt.md");
  await fs.writeFile(promptPath, prompt, "utf8");
  return promptPath;
}

export async function createTerminalVisibleRunArtifacts(args: {
  workspacePath: string;
  runId: string;
  prompt: string;
  config: Config;
  capabilities: CodexExecCapabilities;
  executionMode?: "terminal-visible" | "ghostty-visible";
  terminalApp?: string;
  baselineStatus?: string;
}) {
  const runDir = await ensureRunDir(args.workspacePath, args.runId);
  const promptPath = await writePrompt(runDir, args.prompt);
  const logPath = path.join(runDir, "codex.log");
  const scriptPath = path.join(runDir, "run-codex.sh");
  const baselineStatusPath = path.join(runDir, "baseline-status.txt");
  const finalStatusPath = path.join(runDir, "final-status.txt");
  const metadataPath = path.join(runDir, "metadata.json");
  await fs.writeFile(baselineStatusPath, args.baselineStatus ?? "", "utf8");
  await fs.writeFile(metadataPath, JSON.stringify({
    runId: args.runId,
    workspacePath: args.workspacePath,
    promptPath,
    logPath,
    scriptPath,
    baselineStatusPath,
    finalStatusPath,
    executionMode: args.executionMode ?? "terminal-visible",
    terminalApp: args.terminalApp ?? "Terminal",
    createdAt: new Date().toISOString(),
  }, null, 2), "utf8");
  const codexCommand = codexScriptCommand(args.config, args.capabilities, promptPath);
  const redactedCodexCommand = redactedCodexScriptCommand(args.config, args.capabilities);
  const promptRelativePath = path.relative(args.workspacePath, promptPath);
  const script = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(args.workspacePath)}
printf '%s\\n' ${shellQuote(`Vibe Codex visible run: ${args.runId}`)}
printf '%s\\n' ${shellQuote(`Workspace: ${args.workspacePath}`)}
printf '%s\\n' ${shellQuote(`Prompt: ${promptRelativePath}`)}
printf '%s\\n' ${shellQuote(`Prompt path: ${promptPath}`)}
printf '%s\\n' ${shellQuote(`Log path: ${logPath}`)}
printf '%s\\n' ${shellQuote(`Execution mode: ${args.executionMode ?? "terminal-visible"}`)}
printf '%s\\n' ${shellQuote(`Terminal app: ${args.terminalApp ?? "Terminal"}`)}
printf '%s\\n' ${shellQuote(`Codex command: ${redactedCodexCommand}`)}
printf '%s\\n' ''
printf '%s\\n' 'Prompt follows:'
printf '%s\\n' '----------------------------------------'
cat ${shellQuote(promptPath)}
printf '%s\\n' ''
printf '%s\\n' '----------------------------------------'
printf '%s\\n' 'Press Enter to start Codex, or Ctrl+C to cancel.'
printf '%s\\n' 'Ctrl+C stops the run. Codex output is written live to the log path above.'
read
set +e
printf '%s\\n' '**VIBE_CODEX_RUN_STARTED**' | tee ${shellQuote(logPath)}
${codexCommand} 2>&1 | tee -a ${shellQuote(logPath)}
VIBE_CODEX_EXIT_CODE=\${PIPESTATUS[0]}
set -e
printf '%s\\n' "__VIBE_CODEX_RUN_EXIT_CODE=\${VIBE_CODEX_EXIT_CODE}" | tee -a ${shellQuote(logPath)}
printf '%s\\n' '**VIBE_CODEX_RUN_FINISHED**' | tee -a ${shellQuote(logPath)}
printf '%s\\n' '__VIBE_CODEX_RUN_FINISHED__' | tee -a ${shellQuote(logPath)}
printf '%s\\n' 'Codex finished.'
printf '%s\\n' 'Press Enter to close.'
read || true
`;
  await fs.writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700 });
  await fs.chmod(scriptPath, 0o700);
  return { runDir, promptPath, logPath, scriptPath, baselineStatusPath, finalStatusPath, metadataPath, script };
}

export async function launchVisibleTerminal(args: {
  scriptPath: string;
  cwd: string;
  config: Config;
  preferredApp: string;
  fallbackApp?: string;
  launch?: boolean;
  opener?: (appName: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string }>;
}) {
  if (args.launch === false) {
    return { terminalApp: args.preferredApp, result: undefined, fallbackUsed: false };
  }
  const opener = args.opener ?? ((appName: string) => runProcessArgv({ file: "open", args: ["-a", appName, args.scriptPath], cwd: args.cwd, timeoutMs: 30_000, maxOutputBytes: args.config.maxCommandOutputBytes }));
  const first = await opener(args.preferredApp);
  if (first.exitCode === 0 || !args.fallbackApp || args.fallbackApp === args.preferredApp) {
    return { terminalApp: args.preferredApp, result: first, fallbackUsed: false };
  }
  const fallback = await opener(args.fallbackApp);
  return { terminalApp: args.fallbackApp, result: fallback, fallbackUsed: true };
}

async function createPromptOnlyRunArtifacts(workspacePath: string, runId: string, prompt: string) {
  const runDir = await ensureRunDir(workspacePath, runId);
  const promptPath = await writePrompt(runDir, prompt);
  return { runDir, promptPath };
}

async function buildUntrackedDiff(workspacePath: string, files: string[], maxBytes: number): Promise<string> {
  let output = "";
  for (const file of files) {
    if (output.length >= maxBytes) break;
    const fullPath = path.join(workspacePath, file);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      const content = await fs.readFile(fullPath, "utf8");
      output += [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file}`,
        ...content.split("\n").filter((line, index, lines) => line !== "" || index < lines.length - 1).map((line) => `+${line}`),
        "",
      ].join("\n");
    } catch {
      // Ignore files that disappear between status and collection.
    }
  }
  return output.slice(0, maxBytes);
}

export async function startTerminalVisibleCodexTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
  launch?: boolean;
  executionMode?: "terminal-visible" | "ghostty-visible";
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const capabilities = await inspectCodexExecCapabilities(args.config);
  const baselineStatus = (await gitStatus(cwd, args.config).catch(() => undefined))?.stdout ?? "";
  const executionMode = args.executionMode ?? "terminal-visible";
  const preferredApp = executionMode === "ghostty-visible" ? args.config.terminalApp : args.config.terminalFallbackApp;
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: "running_visible",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: "pending visible terminal launch",
    metadata: { executionMode, terminalApp: preferredApp },
  });
  const artifacts = await createTerminalVisibleRunArtifacts({ workspacePath: cwd, runId: placeholder.id, prompt: args.prompt, config: args.config, capabilities, baselineStatus, executionMode, terminalApp: preferredApp });
  const launch = await launchVisibleTerminal({
    scriptPath: artifacts.scriptPath,
    cwd,
    config: args.config,
    preferredApp,
    fallbackApp: executionMode === "ghostty-visible" ? args.config.terminalFallbackApp : undefined,
    launch: args.launch,
  });
  return args.runStore.updateRun(placeholder.id, {
    codexCommand: launch.result?.command ?? artifacts.scriptPath,
    stdout: launch.result?.stdout ?? "",
    stderr: launch.result?.stderr ?? "",
    exitCode: launch.result?.exitCode ?? null,
    metadata: {
      executionMode,
      terminalApp: launch.terminalApp,
      terminalFallbackApp: args.config.terminalFallbackApp,
      terminalFallbackUsed: launch.fallbackUsed,
      runDir: artifacts.runDir,
      promptPath: artifacts.promptPath,
      logPath: artifacts.logPath,
      scriptPath: artifacts.scriptPath,
      baselineStatusPath: artifacts.baselineStatusPath,
      finalStatusPath: artifacts.finalStatusPath,
      metadataPath: artifacts.metadataPath,
      launchExitCode: launch.result?.exitCode,
    },
  });
}

export async function startAppSupervisedCodexTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
  openApp?: boolean;
  copyClipboard?: boolean;
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: "running_visible",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: "app-supervised prompt handoff",
    metadata: { executionMode: "app-supervised" },
  });
  const artifacts = await createPromptOnlyRunArtifacts(cwd, placeholder.id, args.prompt);
  const appResult = args.openApp === false
    ? undefined
    : await runProcessArgv({ file: args.config.codexBin, args: ["app", cwd], cwd, timeoutMs: 30_000, maxOutputBytes: args.config.maxCommandOutputBytes });
  const copyResult = args.copyClipboard === false
    ? undefined
    : await runProcessArgv({ file: "/bin/sh", args: ["-c", `command -v pbcopy >/dev/null 2>&1 && cat ${shellQuote(artifacts.promptPath)} | pbcopy`], cwd, timeoutMs: 10_000, maxOutputBytes: args.config.maxCommandOutputBytes }).catch(() => undefined);
  return args.runStore.updateRun(placeholder.id, {
    stdout: [appResult?.stdout, copyResult?.stdout].filter(Boolean).join("\n"),
    stderr: [appResult?.stderr, copyResult?.stderr].filter(Boolean).join("\n"),
    exitCode: appResult?.exitCode ?? null,
    metadata: {
      executionMode: "app-supervised",
      runDir: artifacts.runDir,
      promptPath: artifacts.promptPath,
      appOpened: appResult ? appResult.exitCode === 0 : false,
      clipboardCopied: copyResult ? copyResult.exitCode === 0 : false,
    },
  });
}

export async function collectVisibleRunResult(args: {
  runId: string;
  config: Config;
  runStore: RunStore;
  maxBytes?: number;
}) {
  const run = args.runStore.getRun(args.runId);
  if (!run) throw new VibeError("CONFIG_ERROR", "Run not found.", { runId: args.runId });
  const logPath = typeof run.metadata?.logPath === "string" ? run.metadata.logPath : undefined;
  const baselineStatusPath = typeof run.metadata?.baselineStatusPath === "string" ? run.metadata.baselineStatusPath : undefined;
  const finalStatusPath = typeof run.metadata?.finalStatusPath === "string" ? run.metadata.finalStatusPath : undefined;
  const metadataPath = typeof run.metadata?.metadataPath === "string" ? run.metadata.metadataPath : undefined;
  let log = "";
  let truncated = false;
  if (logPath) {
    try {
      const stat = await fs.stat(logPath);
      const maxBytes = args.maxBytes ?? args.config.maxCommandOutputBytes;
      const handle = await fs.open(logPath, "r");
      try {
        const length = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
        log = buffer.toString("utf8");
        truncated = stat.size > maxBytes;
      } finally {
        await handle.close();
      }
    } catch {
      log = "";
    }
  }
  const status = await gitStatus(run.workspacePath, args.config).catch(() => undefined);
  const maxDiffBytes = args.maxBytes ?? 80_000;
  const diff = await gitDiff(run.workspacePath, args.config, maxDiffBytes).catch(() => undefined);
  const statusText = status?.stdout ?? "";
  if (finalStatusPath) await fs.writeFile(finalStatusPath, statusText, "utf8").catch(() => undefined);
  const baselineStatus = baselineStatusPath ? await fs.readFile(baselineStatusPath, "utf8").catch(() => "") : "";
  const changedFiles = statusText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => !file.startsWith(".vibe-codex/"));
  const baselineFiles = new Set(baselineStatus
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((file) => !file.startsWith(".vibe-codex/")));
  const newChangedFilesSinceRun = changedFiles.filter((file) => !baselineFiles.has(file));
  const untrackedNewFiles = statusText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter((file) => newChangedFilesSinceRun.includes(file));
  const untrackedDiff = await buildUntrackedDiff(run.workspacePath, untrackedNewFiles, maxDiffBytes);
  const gitDiffSummary = [diff?.stdout ?? "", untrackedDiff].filter(Boolean).join("\n");
  const completedMarkers = ["**VIBE_CODEX_RUN_FINISHED**", "__VIBE_CODEX_RUN_FINISHED__", "Summary of changes:", "tokens used", "Codex finished."];
  const failureMarkers = ["Not inside a trusted directory", "error:", "fatal:"];
  const exitCodeMatch = log.match(/__VIBE_CODEX_RUN_EXIT_CODE=(-?\d+)/);
  const visibleExitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1], 10) : undefined;
  const finishedMarker = log.includes("**VIBE_CODEX_RUN_FINISHED**") || log.includes("__VIBE_CODEX_RUN_FINISHED__");
  const completedVisible = visibleExitCode === undefined
    ? completedMarkers.some((marker) => log.includes(marker))
    : finishedMarker && visibleExitCode === 0;
  const failedVisible = !completedVisible && (
    (finishedMarker && typeof visibleExitCode === "number" && visibleExitCode !== 0)
    || failureMarkers.some((marker) => log.toLowerCase().includes(marker.toLowerCase()))
  );
  const collectedStatus = completedVisible ? "completed_visible" : failedVisible ? "failed_visible" : run.status;
  if (collectedStatus !== run.status && (collectedStatus === "completed_visible" || collectedStatus === "failed_visible")) {
    args.runStore.updateRun(run.id, { status: collectedStatus });
  }
  if (metadataPath) {
    await fs.writeFile(metadataPath, JSON.stringify({
      runId: run.id,
      workspacePath: run.workspacePath,
      status: collectedStatus,
      visibleExitCode,
      promptPath: run.metadata?.promptPath,
      logPath,
      baselineStatusPath,
      finalStatusPath,
      changedFiles,
      newChangedFilesSinceRun,
      gitDiffSummary,
      collectedAt: new Date().toISOString(),
    }, null, 2), "utf8").catch(() => undefined);
  }
  return {
    runId: run.id,
    status: collectedStatus,
    executionMode: run.metadata?.executionMode,
    terminalApp: run.metadata?.terminalApp,
    exitCode: visibleExitCode,
    log,
    truncated,
    logPath,
    promptPath: run.metadata?.promptPath,
    scriptPath: run.metadata?.scriptPath,
    finalStatusPath,
    metadataPath,
    baselineStatus,
    gitStatus: statusText,
    gitDiff: gitDiffSummary,
    gitDiffSummary,
    changedFiles,
    newChangedFilesSinceRun,
    changedFilesSinceRun: newChangedFilesSinceRun,
    summary: collectedStatus === "completed_visible" ? "Visible Codex run completed." : collectedStatus === "failed_visible" ? "Visible Codex run appears to have failed." : "Visible Codex run is still pending or running.",
    doNotFallbackToDirectWrite: true,
  };
}

export async function startCodexExecTask(args: {
  workspacePath: string;
  prompt: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
}): Promise<RunRecord> {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const capabilities = await inspectCodexExecCapabilities(args.config);
  const argv = codexArgs(args.prompt, args.config, capabilities);
  const placeholder = args.runStore.createRun({
    workspacePath: cwd,
    status: "running",
    autonomy: args.autonomy,
    prompt: args.prompt,
    command: [args.config.codexBin, ...argv].join(" "),
  });
  const result = await runProcessArgv({
    file: args.config.codexBin,
    args: argv,
    cwd,
    timeoutMs: args.config.codexTimeoutMs,
    maxOutputBytes: args.config.maxCommandOutputBytes,
  });
  return args.runStore.updateRun(placeholder.id, {
    status: result.exitCode === 0 ? "completed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    metadata: { timedOut: result.timedOut, signal: result.signal, durationMs: result.durationMs },
  });
}

function tail(text: string, bytes = 20_000): string {
  return text.length <= bytes ? text : text.slice(text.length - bytes);
}

export async function continueCodexTask(args: {
  runId: string;
  instruction: string;
  autonomy: AutonomyLevel;
  config: Config;
  runStore: RunStore;
}): Promise<RunRecord> {
  const prior = args.runStore.getRun(args.runId);
  if (!prior) throw new Error(`Run not found: ${args.runId}`);
  const status = await gitStatus(prior.workspacePath, args.config).catch((error) => ({ stdout: "", stderr: String(error) }));
  const diff = await gitDiff(prior.workspacePath, args.config, 40_000).catch((error) => ({ stdout: "", stderr: String(error) }));
  const prompt = compileCodexPrompt({
    workspacePath: prior.workspacePath,
    userGoal: `Continue prior Vibe Codex run ${prior.id}.\n\nOriginal prompt:\n${prior.prompt}\n\nPrevious stdout tail:\n${tail(prior.stdout)}\n\nPrevious stderr tail:\n${tail(prior.stderr)}\n\nCurrent git status:\n${"stdout" in status ? status.stdout : ""}\n\nCurrent git diff:\n${"stdout" in diff ? tail(diff.stdout, 40_000) : ""}\n\nNew instruction:\n${args.instruction}`,
    autonomy: args.autonomy,
  });
  const run = await startCodexExecTask({ workspacePath: prior.workspacePath, prompt, autonomy: args.autonomy, config: args.config, runStore: args.runStore });
  return args.runStore.updateRun(run.id, { metadata: { ...(run.metadata ?? {}), previousRunId: prior.id } });
}
