import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexExecArgv, createTerminalVisibleRunArtifacts, startAppSupervisedCodexTask, startTerminalVisibleCodexTask } from "../src/codex/codexExec.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";

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
});
