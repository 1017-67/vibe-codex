import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";

export interface CodexAppServerDetection {
  available: boolean;
  url?: string;
  reason?: string;
  details?: unknown;
}

function baseUrl(config: Config): string | undefined {
  return config.codexAppServerUrl?.replace(/\/+$/, "");
}

async function requestJson(config: Config, path: string, init?: RequestInit): Promise<unknown> {
  const base = baseUrl(config);
  if (!base) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured. Use ghostty-visible for supervised runs.", {
      recommendedExecutionMode: "ghostty-visible",
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
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server request failed. Use ghostty-visible for supervised runs.", {
      status: response.status,
      recommendedExecutionMode: "ghostty-visible",
    });
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function detectCodexAppServer(config: Config): Promise<CodexAppServerDetection> {
  const base = baseUrl(config);
  if (!base) {
    return {
      available: false,
      reason: "CODEX_APP_SERVER_URL is not configured. Use ghostty-visible for supervised runs.",
      details: { recommendedExecutionMode: "ghostty-visible" },
    };
  }
  try {
    const details = await requestJson(config, "/health");
    return { available: true, url: base, details };
  } catch (error) {
    return {
      available: false,
      url: base,
      reason: error instanceof Error ? error.message : String(error),
      details: { recommendedExecutionMode: "ghostty-visible" },
    };
  }
}

export async function listCodexThreads(config: Config) {
  return requestJson(config, "/threads");
}

export async function startCodexAppThread(args: { workspacePath: string; prompt: string; config: Config }) {
  return requestJson(args.config, "/threads", {
    method: "POST",
    body: JSON.stringify({ workspacePath: args.workspacePath, prompt: args.prompt }),
  });
}

export async function resumeCodexAppThread(args: { threadId: string; workspacePath: string; prompt?: string; config: Config }) {
  return requestJson(args.config, `/threads/${encodeURIComponent(args.threadId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ workspacePath: args.workspacePath, prompt: args.prompt }),
  });
}

export async function continueCodexAppThread(args: { threadId: string; instruction: string; config: Config }) {
  return requestJson(args.config, `/threads/${encodeURIComponent(args.threadId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ instruction: args.instruction }),
  });
}

export async function forkCodexAppThread(args: { threadId: string; workspacePath: string; instruction?: string; config: Config }) {
  return requestJson(args.config, `/threads/${encodeURIComponent(args.threadId)}/fork`, {
    method: "POST",
    body: JSON.stringify({ workspacePath: args.workspacePath, instruction: args.instruction }),
  });
}

export async function getCodexAppThreadStatus(args: { threadId: string; config: Config }) {
  return requestJson(args.config, `/threads/${encodeURIComponent(args.threadId)}`);
}
