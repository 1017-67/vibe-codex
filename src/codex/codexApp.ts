import { Config } from "../config/types.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { runProcessArgv } from "../util/spawn.js";

export async function openCodexApp(workspacePath: string, config: Config) {
  const cwd = await assertSafeWorkspacePath(workspacePath, config);
  return runProcessArgv({
    file: config.codexBin,
    args: ["app", cwd],
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: config.maxCommandOutputBytes,
  });
}
