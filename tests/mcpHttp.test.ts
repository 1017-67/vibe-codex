import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcpServer.js";
import { createHttpApp } from "../src/server/http.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";

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
  const app = createHttpApp(ctx.config, () => createMcpServer(ctx.config, store));
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
  });

  it("tools/list without a valid session returns 400 instead of 500", async () => {
    const response = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "missing-session");
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error.message).toBe("Invalid or missing MCP session id");
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
});
