import path from "node:path";
import dotenv from "dotenv";
import { Config } from "./types.js";
import { VibeError } from "../util/errors.js";

dotenv.config();

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitPaths(value: string | undefined, fallback: string[]): string[] {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return (parts.length ? parts : fallback).map((part) => path.resolve(part));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const developmentMode = bool(env.VIBE_CODEX_DEV, env.NODE_ENV === "development" || env.NODE_ENV === "test");
  const disableAuth = bool(env.DISABLE_AUTH, false);
  const relayToken = env.RELAY_TOKEN;

  if (!relayToken && !developmentMode && !disableAuth) {
    throw new VibeError("CONFIG_ERROR", "RELAY_TOKEN is required unless VIBE_CODEX_DEV=true or NODE_ENV=test.");
  }
  if (disableAuth && !developmentMode) {
    throw new VibeError("CONFIG_ERROR", "DISABLE_AUTH is only allowed when VIBE_CODEX_DEV=true or NODE_ENV=test.");
  }

  const allowedRoots = splitPaths(env.ALLOWED_ROOTS, [path.resolve(process.cwd())]);
  const defaultParentDir = path.resolve(env.DEFAULT_PARENT_DIR ?? allowedRoots[0] ?? process.cwd());

  return {
    port: int(env.PORT, 8787),
    relayToken: relayToken ?? (developmentMode ? "dev-token" : undefined),
    disableAuth,
    developmentMode,
    allowedRoots,
    defaultParentDir,
    codexBin: env.CODEX_BIN || "codex",
    databasePath: path.resolve(env.DATABASE_PATH ?? "./vibe-codex.sqlite"),
    defaultCodexApproval: env.DEFAULT_CODEX_APPROVAL || "untrusted",
    defaultCodexSandbox: env.DEFAULT_CODEX_SANDBOX || "workspace-write",
    allowNetworkCommands: bool(env.ALLOW_NETWORK_COMMANDS, false),
    maxCommandOutputBytes: int(env.MAX_COMMAND_OUTPUT_BYTES, 200_000),
    commandTimeoutMs: int(env.COMMAND_TIMEOUT_MS, 120_000),
    codexTimeoutMs: int(env.CODEX_TIMEOUT_MS, 900_000),
  };
}
