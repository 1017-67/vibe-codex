import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  command: string;
  cwd?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

function appendLimited(current: string, chunk: Buffer, maxBytes: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return next.slice(0, maxBytes) + "\n[output truncated]\n";
}

export function runProcessArgv(args: {
  file: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}): Promise<ProcessResult> {
  const startedAt = new Date();
  const maxOutputBytes = args.maxOutputBytes ?? 200_000;
  const command = [args.file, ...(args.args ?? [])].join(" ");
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(args.file, args.args ?? [], {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = args.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2_000).unref();
        }, args.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      stderr = appendLimited(stderr, Buffer.from(error.message), maxOutputBytes);
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const finishedAt = new Date();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        command,
        cwd: args.cwd,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    });
  });
}

export function runProcess(args: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}): Promise<ProcessResult> {
  return runProcessArgv({
    file: args.command,
    args: [],
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    maxOutputBytes: args.maxOutputBytes,
    env: args.env,
  });
}

export function runShellCommand(args: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}): Promise<ProcessResult> {
  return runProcessArgv({
    file: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    args: process.platform === "win32" ? ["/d", "/s", "/c", args.command] : ["-c", args.command],
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    maxOutputBytes: args.maxOutputBytes,
    env: args.env,
  }).then((result) => ({ ...result, command: args.command }));
}
