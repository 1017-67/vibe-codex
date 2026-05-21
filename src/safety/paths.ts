import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";

const home = os.homedir();

const sensitiveHomeDirs = [
  ".ssh",
  ".codex",
  path.join("Library", "Keychains"),
  path.join("Library", "Application Support", "Google", "Chrome"),
  path.join("Library", "Application Support", "BraveSoftware"),
  path.join("Library", "Application Support", "Firefox"),
  path.join("Library", "Application Support", "Microsoft Edge"),
  path.join("Library", "Cookies"),
];

const sensitiveFilePatterns = [
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|[/\\])\.env($|[.])/i,
  /id_rsa$/i,
  /id_ed25519$/i,
  /cookies?(\.sqlite|\.db)?$/i,
  /login data$/i,
  /keychain/i,
];

async function realpathIfExists(inputPath: string): Promise<string | null> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return null;
  }
}

async function resolveExistingAware(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const existing = await realpathIfExists(resolved);
  if (existing) return existing;
  const parent = path.dirname(resolved);
  const realParent = await realpathIfExists(parent);
  return realParent ? path.join(realParent, path.basename(resolved)) : resolved;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSensitivePath(resolvedPath: string): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const rel of sensitiveHomeDirs) {
    const target = path.join(home, rel);
    if (isInside(normalized, target)) return true;
  }
  return sensitiveFilePatterns.some((pattern) => pattern.test(normalized));
}

export async function isPathInsideAllowedRoots(resolvedPath: string, config: Config): Promise<boolean> {
  const candidate = await resolveExistingAware(resolvedPath);
  const roots = await Promise.all(config.allowedRoots.map((root) => resolveExistingAware(root)));
  return roots.some((root) => isInside(candidate, root));
}

export async function resolveInsideAllowedRoots(inputPath: string, config: Config): Promise<string> {
  const resolved = await resolveExistingAware(inputPath.replace(/^~(?=$|[/\\])/, home));
  if (isSensitivePath(resolved)) {
    throw new VibeError("SENSITIVE_PATH_BLOCKED", "Sensitive path access is blocked.", { path: resolved });
  }
  if (!(await isPathInsideAllowedRoots(resolved, config))) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Path is outside allowed roots.", {
      path: resolved,
      allowedRoots: config.allowedRoots,
    });
  }
  return resolved;
}

export async function assertSafeWorkspacePath(inputPath: string, config: Config): Promise<string> {
  return resolveInsideAllowedRoots(inputPath, config);
}

export async function assertSafeFilePath(workspacePath: string, relativePath: string, config: Config): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "File path must be relative to the workspace.", { relativePath });
  }
  const workspace = await assertSafeWorkspacePath(workspacePath, config);
  const rawTarget = path.resolve(workspace, relativePath);
  const target = await resolveExistingAware(rawTarget);
  if (!isInside(target, workspace)) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "File path escapes the workspace.", { path: target, workspace });
  }
  if (isSensitivePath(target)) {
    throw new VibeError("SENSITIVE_PATH_BLOCKED", "Sensitive file access is blocked.", { path: target });
  }
  if (!(await isPathInsideAllowedRoots(target, config))) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "File path is outside allowed roots.", { path: target });
  }
  return target;
}
