import { AddressInfo } from "node:net";
import { createServer as createNodeHttpServer } from "node:http";
import { describe, expect, it } from "vitest";
import { detectCodexAppServer, normalizeCodexAppThreadResponse, startCodexAppThread } from "../src/codex/codexAppServer.js";
import { tempConfig } from "./helpers.js";

describe("experimental Codex app-server support", () => {
  it("reports unavailable clearly when app-server URL is not configured", async () => {
    const ctx = await tempConfig();
    try {
      const detection = await detectCodexAppServer(ctx.config);
      expect(detection.available).toBe(false);
      expect(detection.reason).toContain("CODEX_APP_SERVER_URL");
      expect(detection.details).toMatchObject({ recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"] });
    } finally {
      await ctx.cleanup();
    }
  });

  it("app-thread start fails with ghostty-visible recommendation when unavailable", async () => {
    const ctx = await tempConfig();
    try {
      await expect(startCodexAppThread({ workspacePath: ctx.root, prompt: "do work", config: ctx.config })).rejects.toMatchObject({
        code: "CODEX_APP_SERVER_UNAVAILABLE",
        details: { recommendedExecutionMode: "codex-app-visible", fallbackExecutionModes: ["codex-app-visible", "ghostty-visible"] },
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("normalizes thread responses and falls back to alternate start endpoint", async () => {
    const ctx = await tempConfig();
    const requests: Array<{ method?: string; url?: string; body?: any }> = [];
    const appServer = createNodeHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === "POST" && req.url === "/thread/start") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ thread: { id: "thread-alt", state: "queued", summary: "alternate" }, events: [{ type: "queued" }] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    try {
      const address = appServer.address() as AddressInfo;
      ctx.config.codexAppServerUrl = `http://127.0.0.1:${address.port}`;
      const response = await startCodexAppThread({ workspacePath: ctx.root, prompt: "alternate endpoint", config: ctx.config });
      const normalized = normalizeCodexAppThreadResponse(response);
      expect(normalized).toMatchObject({ threadId: "thread-alt", status: "queued", summary: "alternate", events: [{ type: "queued" }] });
      expect(requests.map((request) => request.url)).toEqual(["/threads", "/thread/start"]);
      expect(requests[1].body).toMatchObject({ workspacePath: ctx.root, prompt: "alternate endpoint" });
    } finally {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
      await ctx.cleanup();
    }
  });
});
