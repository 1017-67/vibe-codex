import fs from "node:fs/promises";
import path from "node:path";
import { Config } from "../config/types.js";
import { assertSafeFilePath, assertSafeWorkspacePath } from "../safety/paths.js";
import { VibeError } from "../util/errors.js";

export interface ListedFile {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export async function listFiles(workspacePath: string, relativeDir = ".", maxDepth = 3, config: Config): Promise<ListedFile[]> {
  const workspace = await assertSafeWorkspacePath(workspacePath, config);
  const start = await assertSafeFilePath(workspace, relativeDir, config);
  const files: ListedFile[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspace, full);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push({ path: rel, type: "dir" });
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push({ path: rel, type: "file", size: stat.size });
      }
    }
  }

  await walk(start, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readFile(workspacePath: string, relativePath: string, config: Config, maxBytes = 200_000) {
  const target = await assertSafeFilePath(workspacePath, relativePath, config);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Path is not a file.", { path: target });
  const handle = await fs.open(target, "r");
  try {
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { path: target, content: buffer.toString("utf8"), truncated: stat.size > maxBytes };
  } finally {
    await handle.close();
  }
}

export async function writeFile(workspacePath: string, relativePath: string, content: string, overwrite: boolean, config: Config) {
  const target = await assertSafeFilePath(workspacePath, relativePath, config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!overwrite) {
    try {
      await fs.stat(target);
      throw new VibeError("CONFIG_ERROR", "File already exists and overwrite=false.", { path: target });
    } catch (error) {
      if (error instanceof VibeError) throw error;
    }
  }
  await fs.writeFile(target, content, "utf8");
  return { path: target, bytesWritten: Buffer.byteLength(content) };
}

export async function appendFile(workspacePath: string, relativePath: string, content: string, config: Config) {
  const target = await assertSafeFilePath(workspacePath, relativePath, config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, content, "utf8");
  return { path: target, bytesWritten: Buffer.byteLength(content) };
}
