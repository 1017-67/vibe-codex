import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";

export interface CodexAppServerDetection {
  available: boolean;
  url?: string;
  reason?: string;
  details?: unknown;
}

export interface CodexAppThreadResult {
  threadId?: string;
  status?: string;
  summary?: string;
  events?: unknown[];
  response: unknown;
}

function baseUrl(config: Config): string | undefined {
  return config.codexAppServerUrl?.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeCodexAppThreadResponse(response: unknown): CodexAppThreadResult {
  if (!isRecord(response)) return { response };
  const nestedThread = isRecord(response.thread) ? response.thread : undefined;
  const threadId = [response.threadId, response.thread_id, response.id, nestedThread?.threadId, nestedThread?.thread_id, nestedThread?.id]
    .find((value) => typeof value === "string");
  const status = [response.status, response.state, nestedThread?.status, nestedThread?.state]
    .find((value) => typeof value === "string");
  const summary = [response.summary, response.message, nestedThread?.summary]
    .find((value) => typeof value === "string");
  const events = Array.isArray(response.events) ? response.events : Array.isArray(response.items) ? response.items : undefined;
  return {
    threadId: typeof threadId === "string" ? threadId : undefined,
    status: typeof status === "string" ? status : undefined,
    summary: typeof summary === "string" ? summary : undefined,
    events,
    response,
  };
}

async function requestJson(config: Config, path: string, init?: RequestInit): Promise<unknown> {
  const base = baseUrl(config);
  if (!base) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured. Use codex-app-visible or ghostty-visible for supervised runs.", {
      recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"],
    });
  }
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server request failed. Use codex-app-visible or ghostty-visible for supervised runs.", {
      status: response.status,
      recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"],
    });
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function requestFirstJson(config: Config, candidates: Array<{ path: string; init?: RequestInit }>): Promise<unknown> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await requestJson(config, candidate.path, candidate.init);
    } catch (error) {
      lastError = error;
      if (!(error instanceof VibeError) || error.code !== "CODEX_APP_SERVER_UNAVAILABLE") throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server request failed. Use codex-app-visible or ghostty-visible for supervised runs.", {
    recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"],
  });
}

export async function detectCodexAppServer(config: Config): Promise<CodexAppServerDetection> {
  const base = baseUrl(config);
  if (!base) {
    return {
      available: false,
      reason: "CODEX_APP_SERVER_URL is not configured. Use codex-app-visible or ghostty-visible for supervised runs.",
      details: { recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"] },
    };
  }
  try {
    const details = await requestFirstJson(config, [
      { path: "/health" },
      { path: "/status" },
      { path: "/threads" },
    ]);
    return { available: true, url: base, details };
  } catch (error) {
    return {
      available: false,
      url: base,
      reason: error instanceof Error ? error.message : String(error),
      details: { recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"] },
    };
  }
}

export async function listCodexThreads(config: Config) {
  return requestFirstJson(config, [
    { path: "/threads" },
    { path: "/thread/list" },
  ]);
}

export async function startCodexAppThread(args: { workspacePath: string; prompt: string; config: Config }) {
  const body = JSON.stringify({ workspacePath: args.workspacePath, prompt: args.prompt });
  return requestFirstJson(args.config, [
    { path: "/threads", init: { method: "POST", body } },
    { path: "/thread/start", init: { method: "POST", body } },
  ]);
}

export async function resumeCodexAppThread(args: { threadId: string; workspacePath: string; prompt?: string; config: Config }) {
  const body = JSON.stringify({ threadId: args.threadId, workspacePath: args.workspacePath, prompt: args.prompt });
  return requestFirstJson(args.config, [
    { path: `/threads/${encodeURIComponent(args.threadId)}/resume`, init: { method: "POST", body } },
    { path: "/thread/resume", init: { method: "POST", body } },
  ]);
}

export async function continueCodexAppThread(args: { threadId: string; instruction: string; config: Config }) {
  const body = JSON.stringify({ threadId: args.threadId, instruction: args.instruction });
  return requestFirstJson(args.config, [
    { path: `/threads/${encodeURIComponent(args.threadId)}/messages`, init: { method: "POST", body } },
    { path: `/threads/${encodeURIComponent(args.threadId)}/continue`, init: { method: "POST", body } },
    { path: "/thread/continue", init: { method: "POST", body } },
    { path: "/thread/message", init: { method: "POST", body } },
  ]);
}

export async function forkCodexAppThread(args: { threadId: string; workspacePath: string; instruction?: string; config: Config }) {
  const body = JSON.stringify({ threadId: args.threadId, workspacePath: args.workspacePath, instruction: args.instruction });
  return requestFirstJson(args.config, [
    { path: `/threads/${encodeURIComponent(args.threadId)}/fork`, init: { method: "POST", body } },
    { path: "/thread/fork", init: { method: "POST", body } },
  ]);
}

export async function getCodexAppThreadStatus(args: { threadId: string; config: Config }) {
  return requestFirstJson(args.config, [
    { path: `/threads/${encodeURIComponent(args.threadId)}` },
    { path: `/threads/${encodeURIComponent(args.threadId)}/status` },
    { path: `/thread/status?threadId=${encodeURIComponent(args.threadId)}` },
  ]);
}
