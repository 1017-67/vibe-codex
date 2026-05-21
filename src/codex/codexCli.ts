import { Config } from "../config/types.js";
import { runProcessArgv } from "../util/spawn.js";

export async function getCodexVersion(config: Config): Promise<string | null> {
  const result = await runProcessArgv({ file: config.codexBin, args: ["--version"], timeoutMs: 10_000, maxOutputBytes: 20_000 });
  if (result.exitCode !== 0) return null;
  return (result.stdout || result.stderr).trim() || null;
}

export async function checkCodexAvailable(config: Config): Promise<boolean> {
  return (await getCodexVersion(config)) != null;
}
