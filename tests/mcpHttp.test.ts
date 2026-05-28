import { AddressInfo } from "node:net";
import { createServer as createNodeHttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcpServer.js";
import { createHttpApp } from "../src/server/http.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";
import { AuthSessionStore } from "../src/server/authSessions.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let store: RunStore;
let baseUrl: string;
let httpServer: ReturnType<ReturnType<typeof createHttpApp>["listen"]>;

function parseMcpResponse(text: string): any {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

async function postMcp(body: unknown, sessionId?: string, options?: { path?: string; bearer?: boolean }) {
  const useBearer = options?.bearer ?? true;
  return fetch(`${baseUrl}${options?.path ?? "/mcp"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(useBearer ? { authorization: `Bearer ${ctx.config.relayToken}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function initialize() {
  const response = await postMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vibe-codex-test", version: "0.0.0" },
    },
  });
  const text = await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  return { response, text, sessionId, payload: parseMcpResponse(text) };
}

beforeEach(async () => {
  ctx = await tempConfig();
  ctx.config.developmentMode = true;
  ctx.config.disableAuth = false;
  ctx.config.relayToken = "test-token";
  store = initRunStore(ctx.config.databasePath);
  const stores = { approvals: new ApprovalStore(), authSessions: new AuthSessionStore() };
  const app = createHttpApp(ctx.config, () => createMcpServer(ctx.config, store, stores), stores.authSessions);
  httpServer = app.listen(0);
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  store.db.close();
  await ctx.cleanup();
});

describe("MCP Streamable HTTP sessions", () => {
  it("bearer auth still works on /mcp", async () => {
    const init = await initialize();
    expect(init.response.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });

  it("initialize returns and establishes a session", async () => {
    const init = await initialize();
    expect(init.response.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.payload.result.serverInfo.name).toBe("vibe-codex");
  });

  it("tools/list works after initialize and initialized notification", async () => {
    const init = await initialize();
    expect(init.sessionId).toBeTruthy();

    const initialized = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!);
    expect([200, 202]).toContain(initialized.status);
    await initialized.text();

    const response = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("relay_health");
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("detect_codex_app_server");
    expect(payload.result.tools.map((tool: any) => tool.name)).toContain("start_codex_app_thread");
  });

  it("tools/list without a valid session returns 400 instead of 500", async () => {
    const response = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "missing-session");
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.message).toBe("Invalid or missing MCP session id");
  });

  it("rate limits repeated MCP initialize requests", async () => {
    let response: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      response = await postMcp({
        jsonrpc: "2.0",
        id: 1000 + i,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "rate-limit", version: "0.0.0" },
        },
      });
      await response.text();
    }
    expect(response?.status).toBe(429);
  });

  it("relay_health can be called through MCP", async () => {
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

    const response = await postMcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "relay_health", arguments: {} },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.version).toBe("0.2.0");
    expect(["ok", "degraded"]).toContain(payload.result.structuredContent.status);
  });

  it("/mcp/:urlToken works when enabled and token matches", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_secret_url_token_that_is_long_enough";
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "url-token-test", version: "0.0.0" },
      },
    }, undefined, { path: "/mcp/vibe_secret_url_token_that_is_long_enough", bearer: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("/mcp query token works when enabled and token matches", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_query_secret_that_is_long_enough";
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "query-token-test", version: "0.0.0" },
      },
    }, undefined, { path: "/mcp?vibe_token=vibe_query_secret_that_is_long_enough", bearer: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("/mcp/:urlToken rejects a wrong token without printing it", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_right_token_that_is_long_enough";
    const response = await postMcp({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }, undefined, { path: "/mcp/wrong-token", bearer: false });
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(text).not.toContain("wrong-token");
    expect(text).not.toContain("right-token");
  });

  it("/mcp/:urlToken rejects when URL token auth is disabled", async () => {
    ctx.config.allowUrlTokenAuth = false;
    ctx.config.urlToken = "vibe_disabled_token_that_is_long_enough";
    const response = await postMcp({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} }, undefined, { path: "/mcp/disabled-token", bearer: false });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain("disabled-token");
  });

  it("/mcp/:urlToken rejects expired URL tokens", async () => {
    ctx.config.allowUrlTokenAuth = true;
    ctx.config.urlToken = "vibe_expired_token_that_is_long_enough";
    ctx.config.urlTokenExpiresAt = "2000-01-01T00:00:00.000Z";
    const response = await postMcp({ jsonrpc: "2.0", id: 14, method: "tools/list", params: {} }, undefined, { path: "/mcp/vibe_expired_token_that_is_long_enough", bearer: false });
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(text).not.toContain("vibe_expired_token_that_is_long_enough");
  });

  it("hidden Codex requires allowHiddenCodex or approval", async () => {
    const workspace = `${ctx.root}/hidden-codex`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "start_codex_task",
        arguments: {
          workspacePath: workspace,
          userGoal: "Say hello",
          executionMode: "exec-hidden",
        },
      },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.approvalRequired).toBe(true);
    expect(payload.result.structuredContent.approvalId).toBeTruthy();
    expect(payload.result.structuredContent.doNotFallbackToDirectWrite).toBe(true);
  });

  it("start_codex_task defaults to codex-app-visible and approval-gates before launch when required", async () => {
    ctx.config.requireApprovalForCodexVisible = true;
    const workspace = `${ctx.root}/ghostty-default`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "start_codex_task",
        arguments: {
          workspacePath: workspace,
          userGoal: "Prepare an interactive Codex task",
        },
      },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.approvalRequired).toBe(true);
    expect(payload.result.structuredContent.actionSummary.executionMode).toBe("codex-app-visible");
  });

  it("start_codex_task codex-app-visible returns app_visible_ready without codex exec or Ghostty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const binDir = path.join(ctx.root, "bin");
    const codexLog = path.join(ctx.root, "codex-args.log");
    const clipboardLog = path.join(ctx.root, "clipboard.txt");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "codex"), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then printf 'codex-cli test\\n'; exit 0; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(codexLog)}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, "pbcopy"), `#!/usr/bin/env bash\ncat > ${JSON.stringify(clipboardLog)}\n`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, "pbpaste"), `#!/usr/bin/env bash\ncat ${JSON.stringify(clipboardLog)}\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      ctx.config.codexBin = path.join(binDir, "codex");
      const workspace = `${ctx.root}/codex-app-visible`;
      await fs.mkdir(workspace);
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
      const resolvedWorkspace = await fs.realpath(workspace);
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
      const response = await postMcp({
        jsonrpc: "2.0",
        id: 171,
        method: "tools/call",
        params: {
          name: "start_codex_task",
          arguments: {
            workspacePath: workspace,
            userGoal: "Create one GUI-visible file",
            executionMode: "codex-app-visible",
          },
        },
      }, init.sessionId!);
      const payload = parseMcpResponse(await response.text());
      expect(response.status).toBe(200);
      const result = payload.result.structuredContent;
      expect(result.status).toBe("app_visible_ready");
      expect(result.executionMode).toBe("codex-app-visible");
      expect(result.workspacePath).toBe(resolvedWorkspace);
      expect(result.promptPath).toContain(".vibe-codex/runs/");
      expect(result.rootPromptPath).toContain("VIBE_CODEX_PROMPT.md");
      expect(result.metadataPath).toContain(".vibe-codex/runs/");
      expect(result.copiedToClipboard).toBe(true);
      expect(result.clipboardVerified).toBe(true);
      expect(result.message).toContain("Codex Desktop opened");
      expect(result.message).toContain("AGENTS.md");
      expect(result.message).toContain("VIBE_CODEX_PROMPT.md");
      expect(result.message).toContain("No codex exec");
      expect(result.message).toContain("shell script");
      expect(await fs.readFile(codexLog, "utf8")).toBe(`app\n${resolvedWorkspace}\n`);
      expect(await fs.readFile(clipboardLog, "utf8")).toContain("Create one GUI-visible file");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("detect_codex_app_server reports unavailable through MCP", async () => {
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "detect_codex_app_server", arguments: {} },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(response.status).toBe(200);
    expect(payload.result.structuredContent.available).toBe(false);
    expect(payload.result.structuredContent.details.recommendedExecutionMode).toBe("codex-app-visible");
    expect(payload.result.structuredContent.details.fallbackExecutionModes).toEqual(["codex-app-visible", "ghostty-visible"]);
  });

  it("app-thread tools create run mappings for start, continue, resume, and fork", async () => {
    const requests: Array<{ method?: string; url?: string; body?: any }> = [];
    const appServer = createNodeHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      const send = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/health") return send({ status: "ok" });
      if (req.method === "GET" && req.url === "/threads") return send({ threads: [{ threadId: "thread-1" }] });
      if (req.method === "POST" && req.url === "/threads") return send({ threadId: "thread-1", status: "running", summary: "started", events: [{ type: "thread.started" }] });
      if (req.method === "POST" && req.url === "/threads/thread-1/messages") return send({ threadId: "thread-1", status: "running", summary: "continued", events: [{ type: "thread.message" }] });
      if (req.method === "POST" && req.url === "/threads/thread-1/resume") return send({ threadId: "thread-1", status: "running", summary: "resumed", events: [{ type: "thread.resumed" }] });
      if (req.method === "POST" && req.url === "/threads/thread-1/fork") return send({ threadId: "thread-2", status: "running", summary: "forked", events: [{ type: "thread.forked" }] });
      if (req.method === "GET" && req.url === "/threads/thread-1") return send({ threadId: "thread-1", status: "running", summary: "status" });
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    try {
      const address = appServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `http://127.0.0.1:${address.port}`;
      const workspace = `${ctx.root}/app-thread`;
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
      const resolvedWorkspace = await import("node:fs/promises").then((fs) => fs.realpath(workspace));
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

      const startResponse = await postMcp({
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: { name: "start_codex_app_thread", arguments: { workspacePath: workspace, userGoal: "Start thread" } },
      }, init.sessionId!);
      const start = parseMcpResponse(await startResponse.text()).result.structuredContent;
      expect(start.runId).toBeTruthy();
      expect(start.threadId).toBe("thread-1");
      expect(start.codexThreadId).toBe("thread-1");
      expect(start.status).toBe("running");
      expect(start.summary).toBe("started");
      expect(start.appServerEvents).toEqual([{ type: "thread.started" }]);
      expect(requests.find((request) => request.method === "POST" && request.url === "/threads")?.body).toMatchObject({ workspacePath: resolvedWorkspace });
      expect(requests.find((request) => request.method === "POST" && request.url === "/threads")?.body.prompt).toContain("Start thread");

      const continueResponse = await postMcp({
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: { name: "continue_codex_app_thread", arguments: { threadId: "thread-1", instruction: "Continue thread" } },
      }, init.sessionId!);
      const continued = parseMcpResponse(await continueResponse.text()).result.structuredContent;
      expect(continued.runId).toBeTruthy();
      expect(continued.threadId).toBe("thread-1");
      expect(continued.status).toBe("running");
      expect(continued.summary).toBe("continued");
      expect(continued.workspacePath).toBe(resolvedWorkspace);
      expect(requests.find((request) => request.method === "POST" && request.url === "/threads/thread-1/messages")?.body).toMatchObject({ threadId: "thread-1", instruction: "Continue thread" });

      const resumeResponse = await postMcp({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "resume_codex_app_thread", arguments: { threadId: "thread-1", workspacePath: workspace, prompt: "Resume thread" } },
      }, init.sessionId!);
      const resumed = parseMcpResponse(await resumeResponse.text()).result.structuredContent;
      expect(resumed.runId).toBeTruthy();
      expect(resumed.threadId).toBe("thread-1");
      expect(resumed.status).toBe("running");
      expect(resumed.summary).toBe("resumed");
      expect(requests.find((request) => request.method === "POST" && request.url === "/threads/thread-1/resume")?.body).toMatchObject({ threadId: "thread-1", workspacePath: resolvedWorkspace, prompt: "Resume thread" });

      const forkResponse = await postMcp({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "fork_codex_app_thread", arguments: { threadId: "thread-1", workspacePath: workspace, instruction: "Fork thread" } },
      }, init.sessionId!);
      const forked = parseMcpResponse(await forkResponse.text()).result.structuredContent;
      expect(forked.runId).toBeTruthy();
      expect(forked.threadId).toBe("thread-2");
      expect(forked.codexThreadId).toBe("thread-2");
      expect(forked.sourceThreadId).toBe("thread-1");
      expect(forked.summary).toBe("forked");
      expect(requests.find((request) => request.method === "POST" && request.url === "/threads/thread-1/fork")?.body).toMatchObject({ threadId: "thread-1", workspacePath: resolvedWorkspace, instruction: "Fork thread" });

      ctx.config.codexBin = "definitely-not-installed-codex";
      const startViaGenericResponse = await postMcp({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "start_codex_task",
          arguments: {
            workspacePath: workspace,
            userGoal: "Start through generic task tool",
            executionMode: "codex-app-thread",
          },
        },
      }, init.sessionId!);
      const genericStart = parseMcpResponse(await startViaGenericResponse.text()).result.structuredContent;
      expect(genericStart.runId).toBeTruthy();
      expect(genericStart.threadId).toBe("thread-1");
      expect(genericStart.codexThreadId).toBe("thread-1");
      expect(genericStart.status).toBe("running");
      expect(genericStart.executionMode).toBe("codex-app-thread");

      const statusResponse = await postMcp({
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: { name: "get_codex_app_thread_status", arguments: { threadId: "thread-1" } },
      }, init.sessionId!);
      const status = parseMcpResponse(await statusResponse.text()).result.structuredContent;
      expect(status.threadId).toBe("thread-1");
      expect(status.status).toBe("running");
      expect(status.summary).toBe("status");
    } finally {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
  });

  it("project tools reuse registered workspaces and send no-paste app-thread prompts", async () => {
    const requests: Array<{ method?: string; url?: string; body?: any }> = [];
    const appServer = createNodeHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      const send = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && req.url === "/health") return send({ status: "ok" });
      if (req.method === "POST" && req.url === "/threads") return send({ threadId: "project-thread-1", status: "running", summary: "started" });
      if (req.method === "POST" && req.url === "/threads/project-thread-1/messages") return send({ threadId: "project-thread-1", status: "running", summary: "continued" });
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    try {
      const address = appServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `http://127.0.0.1:${address.port}`;
      const workspace = `${ctx.root}/registered-project`;
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
      await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
      const resolvedWorkspace = await import("node:fs/promises").then((fs) => fs.realpath(workspace));
      const init = await initialize();
      await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();

      const registerResponse = await postMcp({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "register_project", arguments: { name: "Registered Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
      }, init.sessionId!);
      const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;
      expect(registered.createdWorkspace).toBe(false);
      expect(registered.project.path).toBe(resolvedWorkspace);

      const startResponse = await postMcp({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "start_project_task", arguments: { projectRef: "Registered Project", userGoal: "Project start goal" } },
      }, init.sessionId!);
      const started = parseMcpResponse(await startResponse.text()).result.structuredContent;
      expect(started.project.id).toBe(registered.project.id);
      expect(started.createdWorkspace).toBe(false);
      expect(started.noPaste).toBe(true);
      expect(started.threadId).toBe("project-thread-1");
      const startBody = requests.find((request) => request.method === "POST" && request.url === "/threads")?.body;
      expect(startBody.workspacePath).toBe(resolvedWorkspace);
      expect(startBody.prompt).toContain("Source: ChatGPT via Vibe Codex");
      expect(startBody.prompt).toContain(`projectId: ${registered.project.id}`);
      expect(startBody.prompt).toContain("Project start goal");

      const continueResponse = await postMcp({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "continue_project_task", arguments: { projectRef: registered.project.id, instruction: "Continue project" } },
      }, init.sessionId!);
      const continued = parseMcpResponse(await continueResponse.text()).result.structuredContent;
      expect(continued.threadId).toBe("project-thread-1");
      const continueBody = requests.find((request) => request.method === "POST" && request.url === "/threads/project-thread-1/messages")?.body;
      expect(continueBody.instruction).toContain("Continue project");
      expect(continueBody.instruction).toContain("codexThreadId: project-thread-1");

      const runsResponse = await postMcp({
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: { name: "list_project_runs", arguments: { projectRef: registered.project.id } },
      }, init.sessionId!);
      const runs = parseMcpResponse(await runsResponse.text()).result.structuredContent.runs;
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.every((run: any) => run.metadata.projectId === registered.project.id)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
  });

  it("start_project_task returns a clear fallback when app-server is unavailable", async () => {
    const workspace = `${ctx.root}/registered-no-server`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    await import("../src/util/spawn.js").then(({ runProcessArgv }) => runProcessArgv({ file: "git", args: ["init"], cwd: workspace }));
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const registerResponse = await postMcp({
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: { name: "register_project", arguments: { name: "No Server Project", workspacePath: workspace, preferredExecutionMode: "codex-app-thread" } },
    }, init.sessionId!);
    const registered = parseMcpResponse(await registerResponse.text()).result.structuredContent;
    const startResponse = await postMcp({
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: { name: "start_project_task", arguments: { projectRef: registered.project.id, userGoal: "No server goal" } },
    }, init.sessionId!);
    const payload = parseMcpResponse(await startResponse.text());
    expect(payload.result.isError).toBe(true);
    expect(payload.result.structuredContent.error.code).toBe("CODEX_APP_SERVER_UNAVAILABLE");
    expect(payload.result.structuredContent.error.details.fallbackExecutionModes).toEqual(["app-supervised", "codex-app-visible", "ghostty-visible"]);
  });

  it("start_codex_task fails clearly when workspace is not Git", async () => {
    const workspace = `${ctx.root}/not-git`;
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    const init = await initialize();
    await (await postMcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sessionId!)).text();
    const response = await postMcp({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "start_codex_task",
        arguments: {
          workspacePath: workspace,
          userGoal: "Say hello",
          executionMode: "terminal-visible",
        },
      },
    }, init.sessionId!);
    const payload = parseMcpResponse(await response.text());
    expect(payload.result.isError).toBe(true);
    expect(payload.result.structuredContent.error.message).toContain("not a Git repository");
    expect(payload.result.structuredContent.error.message).toContain("will not auto-use --skip-git-repo-check");
  });
});
