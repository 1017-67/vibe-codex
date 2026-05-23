import { Config } from "../config/types.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { runProcessArgv } from "../util/spawn.js";

export async function gitInit(workspacePath: string, config: Config) {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  return runProcessArgv({ file: "git", args: ["init"], cwd, timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxCommandOutputBytes });
}

export async function gitStatus(workspacePath: string, config: Config) {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  return runProcessArgv({ file: "git", args: ["status", "--short"], cwd, timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxCommandOutputBytes });
}

export async function gitDiff(workspacePath: string, config: Config, maxBytes?: number) {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  return runProcessArgv({ file: "git", args: ["diff", "--no-ext-diff"], cwd, timeoutMs: config.commandTimeoutMs, maxOutputBytes: maxBytes ?? config.maxCommandOutputBytes });
}

export async function gitIsRepository(workspacePath: string, config: Config): Promise<boolean> {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  const result = await runProcessArgv({ file: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd, timeoutMs: config.commandTimeoutMs, maxOutputBytes: 20_000 });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}
