import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexExecArgv, collectVisibleRunResult, createTerminalVisibleRunArtifacts, launchVisibleTerminal, startAppSupervisedCodexTask, startTerminalVisibleCodexTask } from "../src/codex/codexExec.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";
import { runProcessArgv } from "../src/util/spawn.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let store: RunStore;
let workspace: string;

beforeEach(async () => {
  ctx = await tempConfig();
  store = initRunStore(ctx.config.databasePath);
  workspace = path.join(ctx.root, "workspace");
  await fs.mkdir(workspace);
});

afterEach(async () => {
  store.db.close();
  await ctx.cleanup();
});

describe("Codex exec integration", () => {
  it("builds args without deprecated --approval", () => {
    const argv = buildCodexExecArgv({
      prompt: "do work",
      sandbox: "workspace-write",
      approval: "untrusted",
      capabilities: {
        supportsSandbox: true,
        supportsExecAskForApproval: false,
        supportsGlobalAskForApproval: true,
      },
    });
    expect(argv).toEqual(["--ask-for-approval", "untrusted", "exec", "--sandbox", "workspace-write", "do work"]);
    expect(argv).not.toContain("--approval");
  });

  it("omits ask-for-approval when unsupported", () => {
    const argv = buildCodexExecArgv({
      prompt: "do work",
      sandbox: "workspace-write",
      approval: "untrusted",
      capabilities: {
        supportsSandbox: true,
        supportsExecAskForApproval: false,
        supportsGlobalAskForApproval: false,
      },
    });
    expect(argv).toEqual(["exec", "--sandbox", "workspace-write", "do work"]);
  });

  it("writes prompt file and safe terminal script for visible runs", async () => {
    const artifacts = await createTerminalVisibleRunArtifacts({
      workspacePath: workspace,
      runId: "run-1",
      prompt: "Build a small thing",
      config: ctx.config,
      capabilities: {
        supportsSandbox: true,
        supportsExecAskForApproval: false,
        supportsGlobalAskForApproval: true,
      },
    });
    await expect(fs.readFile(artifacts.promptPath, "utf8")).resolves.toBe("Build a small thing");
    const script = await fs.readFile(artifacts.scriptPath, "utf8");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("--ask-for-approval");
    expect(script).toContain("--sandbox");
    expect(script).toContain("tee");
    expect(script).toContain("Prompt follows:");
    expect(script).toContain("Press Enter to start Codex, or Ctrl+C to cancel.");
    expect(script).toContain("**VIBE_CODEX_RUN_STARTED**");
    expect(script).toContain("**VIBE_CODEX_RUN_FINISHED**");
    expect(script).toContain("__VIBE_CODEX_RUN_EXIT_CODE=");
    expect(script).toContain("__VIBE_CODEX_RUN_FINISHED__");
    expect(script).toContain("read || true");
    expect(script).toContain("printf '%s\\n'");
    expect(script).not.toContain("echo \"Prompt:");
    expect(script).not.toContain("--approval");
  });

  it("terminal-visible can create a run without launching Terminal in tests", async () => {
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
    });
    expect(run.status).toBe("running_visible");
    expect(typeof run.metadata?.promptPath).toBe("string");
    await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Visible prompt");
  });

  it("ghostty-visible creates supervised run artifacts and terminal metadata", async () => {
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Ghostty visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
      executionMode: "ghostty-visible",
    });
    expect(run.status).toBe("running_visible");
    expect(run.metadata?.executionMode).toBe("ghostty-visible");
    expect(run.metadata?.terminalApp).toBe("ghostty");
    const script = await fs.readFile(run.metadata!.scriptPath as string, "utf8");
    expect(script).toContain("Execution mode: ghostty-visible");
    expect(script).toContain("Terminal app: ghostty");
    expect(script).toContain("cat ");
    await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Ghostty visible prompt");
  });

  it("falls back to Terminal when preferred Ghostty launch fails", async () => {
    const attempts: string[] = [];
    const launched = await launchVisibleTerminal({
      scriptPath: "/tmp/run-codex.sh",
      cwd: workspace,
      config: ctx.config,
      preferredApp: "ghostty",
      fallbackApp: "Terminal",
      opener: async (appName) => {
        attempts.push(appName);
        return {
          exitCode: appName === "ghostty" ? 1 : 0,
          stdout: "",
          stderr: appName === "ghostty" ? "not found" : "",
          command: `open -a ${appName}`,
        };
      },
    });
    expect(attempts).toEqual(["ghostty", "Terminal"]);
    expect(launched.terminalApp).toBe("Terminal");
    expect(launched.fallbackUsed).toBe(true);
    expect(launched.result?.exitCode).toBe(0);
  });

  it("app-supervised writes prompt and does not run hidden Codex", async () => {
    const run = await startAppSupervisedCodexTask({
      workspacePath: workspace,
      prompt: "Paste this into the app",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      openApp: false,
      copyClipboard: false,
    });
    expect(run.status).toBe("running_visible");
    expect(run.codexCommand).toBe("app-supervised prompt handoff");
    await expect(fs.readFile(run.metadata!.promptPath as string, "utf8")).resolves.toBe("Paste this into the app");
    expect(run.metadata?.appOpened).toBe(false);
  });

  it("collects visible completion status and changed files since baseline", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    await fs.writeFile(path.join(workspace, "preexisting.txt"), "before", "utf8");
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
    });
    await fs.writeFile(run.metadata!.logPath as string, "warning: non-fatal\nerror: non-fatal warning text\n__VIBE_CODEX_RUN_EXIT_CODE=0\n**VIBE_CODEX_RUN_FINISHED**\n", "utf8");
    await fs.writeFile(path.join(workspace, "new-file.txt"), "after", "utf8");
    const collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("completed_visible");
    expect(collected.doNotFallbackToDirectWrite).toBe(true);
    expect(collected.gitDiff).toBe(collected.gitDiffSummary);
    expect(collected.scriptPath).toBe(run.metadata!.scriptPath);
    expect(collected.changedFiles).toContain("preexisting.txt");
    expect(collected.changedFiles).toContain("new-file.txt");
    expect(collected.newChangedFilesSinceRun).not.toContain("preexisting.txt");
    expect(collected.newChangedFilesSinceRun).toContain("new-file.txt");
    expect(collected.changedFilesSinceRun).toEqual(collected.newChangedFilesSinceRun);
  });

  it("treats finished visible runs with nonzero exit markers as failed", async () => {
    await runProcessArgv({ file: "git", args: ["init"], cwd: workspace });
    const run = await startTerminalVisibleCodexTask({
      workspacePath: workspace,
      prompt: "Visible prompt",
      autonomy: "workspace",
      config: ctx.config,
      runStore: store,
      launch: false,
    });
    await fs.writeFile(run.metadata!.logPath as string, "__VIBE_CODEX_RUN_EXIT_CODE=1\n**VIBE_CODEX_RUN_FINISHED**\nCodex finished.\n", "utf8");
    const collected = await collectVisibleRunResult({ runId: run.id, config: ctx.config, runStore: store });
    expect(collected.status).toBe("failed_visible");
    expect(collected.exitCode).toBe(1);
  });
});
