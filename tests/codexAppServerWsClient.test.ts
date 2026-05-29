import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerWsClient,
  continueCodexAppThreadWs,
  forkCodexAppThreadWs,
  getCodexAppThreadStatusWs,
  startCodexAppThreadWs,
  turnStartParams,
} from "../src/codex/codexAppServerWsClient.js";
import { tempConfig } from "./helpers.js";

async function withFakeWsServer(
  handler: (request: any, send: (response: any) => void) => void,
  fn: (url: string, requests: any[]) => Promise<void>,
) {
  const requests: any[] = [];
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      requests.push(request);
      handler(request, (response) => socket.send(JSON.stringify(response)));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  try {
    await fn(`ws://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => wsServer.close(() => httpServer.close(() => resolve())));
  }
}

function respondOk(request: any, send: (response: any) => void) {
  if (!request.id) return;
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "0.1" } });
  if (request.method === "thread/start") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-1", status: { type: "running" } } } });
  if (request.method === "thread/resume") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: request.params.threadId, status: { type: "running" } } } });
  if (request.method === "thread/fork") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-2", status: { type: "running" } } } });
  if (request.method === "thread/read") return send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: request.params.threadId, status: { type: "running" } } } });
  if (request.method === "turn/start") return send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-1", status: "running" } } });
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
}

describe("Codex app-server WebSocket client", () => {
  it("matches JSON-RPC responses and captures notifications", async () => {
    await withFakeWsServer((request, send) => {
      if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      if (request.method === "ping") {
        send({ jsonrpc: "2.0", method: "turn/started", params: { turnId: "turn-1" } });
        send({ jsonrpc: "2.0", id: request.id, result: { pong: true } });
      }
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 500 });
      await client.connect();
      await client.initialize();
      const result = await client.request("ping", { ok: true });
      expect(result).toEqual({ pong: true });
      expect(client.recentEvents().some((event) => (event.message as any).method === "turn/started")).toBe(true);
      client.close();
    });
  });

  it("reports method errors and timeouts", async () => {
    await withFakeWsServer((request, send) => {
      if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      if (request.method === "bad") return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "No such method" } });
    }, async (url) => {
      const client = new CodexAppServerWsClient({ url, timeoutMs: 50 });
      await client.connect();
      await client.initialize();
      await expect(client.request("bad")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      await expect(client.request("never")).rejects.toMatchObject({ code: "CODEX_APP_SERVER_UNAVAILABLE" });
      client.close();
    });
  });

  it("sends thread start, resume, fork, status, and turn prompt shapes", async () => {
    const ctx = await tempConfig();
    try {
      await withFakeWsServer(respondOk, async (url, requests) => {
        ctx.config.codexAppServerUrl = url;
        const started = await startCodexAppThreadWs({ workspacePath: ctx.root, prompt: "start prompt", config: ctx.config });
        const continued = await continueCodexAppThreadWs({ threadId: started.threadId, workspacePath: ctx.root, instruction: "continue prompt", config: ctx.config });
        const forked = await forkCodexAppThreadWs({ threadId: continued.threadId, workspacePath: ctx.root, instruction: "fork prompt", config: ctx.config });
        const status = await getCodexAppThreadStatusWs({ threadId: forked.threadId, config: ctx.config });
        expect(started.threadId).toBe("thread-1");
        expect(forked.threadId).toBe("thread-2");
        expect(status).toMatchObject({ thread: { id: "thread-2" } });
        expect(requests.find((request) => request.method === "thread/start").params).toMatchObject({ cwd: ctx.root, runtimeWorkspaceRoots: [ctx.root] });
        expect(requests.find((request) => request.method === "thread/resume").params).toMatchObject({ threadId: "thread-1", persistExtendedHistory: false });
        expect(requests.find((request) => request.method === "thread/fork").params).toMatchObject({ threadId: "thread-1", cwd: ctx.root });
        expect(requests.find((request) => request.method === "thread/read").params).toMatchObject({ threadId: "thread-2", includeTurns: false });
        const turnStarts = requests.filter((request) => request.method === "turn/start");
        expect(turnStarts.map((request) => request.params.input[0].text)).toEqual(["start prompt", "continue prompt", "fork prompt"]);
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("builds turn/start input as one text item", async () => {
    const ctx = await tempConfig();
    try {
      expect(turnStartParams({ threadId: "thread-1", workspacePath: ctx.root, prompt: "hello", config: ctx.config })).toMatchObject({
        threadId: "thread-1",
        cwd: ctx.root,
        input: [{ type: "text", text: "hello", text_elements: [] }],
      });
    } finally {
      await ctx.cleanup();
    }
  });
});
