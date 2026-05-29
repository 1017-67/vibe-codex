import WebSocket from "ws";
import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexAppServerWsEvent {
  receivedAt: string;
  message: unknown;
}

export interface CodexThreadTurnResult {
  threadId: string;
  turnId?: string;
  threadResponse?: unknown;
  turnResponse?: unknown;
  events: CodexAppServerWsEvent[];
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function toWsUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL must use ws, wss, http, or https.", { url: rawUrl });
  }
  return parsed.toString();
}

function extractThreadId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  if (typeof record.threadId === "string") return record.threadId;
  if (typeof record.thread_id === "string") return record.thread_id;
  const thread = record.thread;
  if (typeof thread === "object" && thread !== null) {
    const threadRecord = thread as Record<string, unknown>;
    if (typeof threadRecord.id === "string") return threadRecord.id;
    if (typeof threadRecord.threadId === "string") return threadRecord.threadId;
    if (typeof threadRecord.thread_id === "string") return threadRecord.thread_id;
  }
  return undefined;
}

function extractTurnId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  if (typeof record.turnId === "string") return record.turnId;
  if (typeof record.turn_id === "string") return record.turn_id;
  const turn = record.turn;
  if (typeof turn === "object" && turn !== null) {
    const turnRecord = turn as Record<string, unknown>;
    if (typeof turnRecord.id === "string") return turnRecord.id;
  }
  return undefined;
}

function turnStartError(error: unknown, args: { threadId: string; threadResponse: unknown; events: CodexAppServerWsEvent[] }): VibeError {
  const details = {
    ...(error instanceof VibeError ? error.details : {}),
    codexThreadId: args.threadId,
    threadId: args.threadId,
    threadResponse: args.threadResponse,
    events: args.events,
    turnStartFailed: true,
  };
  if (error instanceof VibeError) {
    return new VibeError(error.code, error.message, details);
  }
  return new VibeError("CODEX_APP_SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), details);
}

export class CodexAppServerWsClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  private readonly events: CodexAppServerWsEvent[] = [];

  constructor(args: { url: string; timeoutMs?: number }) {
    this.url = toWsUrl(args.url);
    this.timeoutMs = args.timeoutMs ?? 30_000;
  }

  recentEvents(limit = 100): CodexAppServerWsEvent[] {
    return this.events.slice(-limit);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Timed out connecting to Codex app-server WebSocket.", { url: this.url }));
      }, this.timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        ws.on("message", (data) => this.onMessage(data));
        ws.on("close", () => this.rejectAll(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server WebSocket closed.", { url: this.url })));
        ws.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Failed to connect to Codex app-server WebSocket.", { url: this.url, error: error.message }));
      });
    });
  }

  async initialize(): Promise<unknown> {
    const response = await this.request("initialize", {
      clientInfo: { name: "vibe-codex", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
    return response;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server WebSocket is not open.", { url: this.url });
    }
    const id = this.nextId++;
    const payload = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", `Timed out waiting for app-server method ${method}.`, { method, url: this.url, events: this.recentEvents(20) }));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params };
    ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.ws?.close();
    this.rejectAll(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server WebSocket client closed.", { url: this.url }));
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      this.events.push({ receivedAt: new Date().toISOString(), message: { invalidJson: data.toString("utf8") } });
      return;
    }
    this.events.push({ receivedAt: new Date().toISOString(), message });
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    const id = record.id as string | number | undefined;
    if (id == null || !this.pending.has(id)) return;
    const pending = this.pending.get(id)!;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.error) {
      const rpcError = record.error as JsonRpcErrorObject;
      pending.reject(new VibeError("CODEX_APP_SERVER_UNAVAILABLE", `Codex app-server method ${pending.method} failed: ${rpcError.message ?? "unknown error"}`, {
        method: pending.method,
        code: rpcError.code,
        data: rpcError.data,
      }));
      return;
    }
    pending.resolve(record.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export async function withCodexAppServerWsClient<T>(args: { url: string; config: Config; fn: (client: CodexAppServerWsClient) => Promise<T> }): Promise<T> {
  const client = new CodexAppServerWsClient({ url: args.url, timeoutMs: Math.min(args.config.codexTimeoutMs, 120_000) });
  try {
    await client.connect();
    await client.initialize();
    return await args.fn(client);
  } finally {
    client.close();
  }
}

export function threadStartParams(args: { workspacePath: string; config: Config }) {
  return {
    cwd: args.workspacePath,
    runtimeWorkspaceRoots: [args.workspacePath],
    approvalPolicy: args.config.defaultCodexApproval,
    sandbox: args.config.defaultCodexSandbox,
    ephemeral: false,
    sessionStartSource: "startup",
    threadSource: "user",
    serviceName: "vibe-codex",
  };
}

export function turnStartParams(args: { threadId: string; workspacePath: string; prompt: string; config: Config }) {
  return {
    threadId: args.threadId,
    input: [{ type: "text", text: args.prompt, text_elements: [] }],
    cwd: args.workspacePath,
    runtimeWorkspaceRoots: [args.workspacePath],
    approvalPolicy: args.config.defaultCodexApproval,
  };
}

export async function startCodexAppThreadWs(args: { workspacePath: string; prompt: string; config: Config }) {
  if (!args.config.codexAppServerUrl) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  }
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: async (client) => {
      const threadResponse = await client.request("thread/start", threadStartParams(args));
      const threadId = extractThreadId(threadResponse);
      if (!threadId) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "thread/start response did not include a thread id.", { threadResponse, events: client.recentEvents() });
      let turnResponse: unknown;
      try {
        turnResponse = await client.request("turn/start", turnStartParams({ ...args, threadId }));
      } catch (error) {
        throw turnStartError(error, { threadId, threadResponse, events: client.recentEvents() });
      }
      return { threadId, turnId: extractTurnId(turnResponse), threadResponse, turnResponse, events: client.recentEvents() } satisfies CodexThreadTurnResult;
    },
  });
}

export async function resumeCodexAppThreadWs(args: { threadId: string; workspacePath: string; prompt?: string; config: Config }) {
  if (!args.config.codexAppServerUrl) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  }
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: async (client) => {
      const threadResponse = await client.request("thread/resume", {
        threadId: args.threadId,
        cwd: args.workspacePath,
        runtimeWorkspaceRoots: [args.workspacePath],
        approvalPolicy: args.config.defaultCodexApproval,
        sandbox: args.config.defaultCodexSandbox,
        persistExtendedHistory: false,
      });
      const threadId = extractThreadId(threadResponse) ?? args.threadId;
      let turnResponse: unknown;
      if (args.prompt) {
        try {
          turnResponse = await client.request("turn/start", turnStartParams({ threadId, workspacePath: args.workspacePath, prompt: args.prompt, config: args.config }));
        } catch (error) {
          throw turnStartError(error, { threadId, threadResponse, events: client.recentEvents() });
        }
      }
      return { threadId, turnId: extractTurnId(turnResponse), threadResponse, turnResponse, events: client.recentEvents() } satisfies CodexThreadTurnResult;
    },
  });
}

export async function continueCodexAppThreadWs(args: { threadId: string; instruction: string; workspacePath: string; config: Config }) {
  return resumeCodexAppThreadWs({ threadId: args.threadId, workspacePath: args.workspacePath, prompt: args.instruction, config: args.config });
}

export async function forkCodexAppThreadWs(args: { threadId: string; workspacePath: string; instruction?: string; config: Config }) {
  if (!args.config.codexAppServerUrl) {
    throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  }
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: async (client) => {
      const threadResponse = await client.request("thread/fork", {
        threadId: args.threadId,
        cwd: args.workspacePath,
        runtimeWorkspaceRoots: [args.workspacePath],
        approvalPolicy: args.config.defaultCodexApproval,
        sandbox: args.config.defaultCodexSandbox,
        ephemeral: false,
        threadSource: "user",
      });
      const threadId = extractThreadId(threadResponse);
      if (!threadId) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "thread/fork response did not include a thread id.", { threadResponse, events: client.recentEvents() });
      let turnResponse: unknown;
      if (args.instruction) {
        try {
          turnResponse = await client.request("turn/start", turnStartParams({ threadId, workspacePath: args.workspacePath, prompt: args.instruction, config: args.config }));
        } catch (error) {
          throw turnStartError(error, { threadId, threadResponse, events: client.recentEvents() });
        }
      }
      return { threadId, turnId: extractTurnId(turnResponse), threadResponse, turnResponse, events: client.recentEvents() } satisfies CodexThreadTurnResult;
    },
  });
}

export async function listCodexThreadsWs(args: { config: Config; cwd?: string }) {
  if (!args.config.codexAppServerUrl) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: (client) => client.request("thread/list", { cwd: args.cwd ?? null, archived: false, limit: 50 }),
  });
}

export async function getCodexAppThreadStatusWs(args: { threadId: string; config: Config }) {
  if (!args.config.codexAppServerUrl) throw new VibeError("CODEX_APP_SERVER_UNAVAILABLE", "Codex app-server URL is not configured.", {});
  return withCodexAppServerWsClient({
    url: args.config.codexAppServerUrl,
    config: args.config,
    fn: (client) => client.request("thread/read", { threadId: args.threadId, includeTurns: false }),
  });
}
