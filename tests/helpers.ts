import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config/types.js";

export async function tempConfig(): Promise<{ config: Config; root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-codex-test-"));
  const config: Config = {
    port: 8787,
    relayToken: "test",
    disableAuth: true,
    developmentMode: true,
    allowedRoots: [root],
    defaultParentDir: root,
    codexBin: "codex",
    databasePath: path.join(root, "test.sqlite"),
    defaultCodexApproval: "on-request",
    defaultCodexSandbox: "workspace-write",
    allowNetworkCommands: false,
    maxCommandOutputBytes: 200_000,
    commandTimeoutMs: 120_000,
    codexTimeoutMs: 900_000,
  };
  return { config, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
