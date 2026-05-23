import { describe, expect, it } from "vitest";
import { detectCodexAppServer, startCodexAppThread } from "../src/codex/codexAppServerStub.js";
import { tempConfig } from "./helpers.js";

describe("experimental Codex app-server support", () => {
  it("reports unavailable clearly when app-server URL is not configured", async () => {
    const ctx = await tempConfig();
    try {
      const detection = await detectCodexAppServer(ctx.config);
      expect(detection.available).toBe(false);
      expect(detection.reason).toContain("CODEX_APP_SERVER_URL");
      expect(detection.details).toMatchObject({ recommendedExecutionMode: "ghostty-visible" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("app-thread start fails with ghostty-visible recommendation when unavailable", async () => {
    const ctx = await tempConfig();
    try {
      await expect(startCodexAppThread({ workspacePath: ctx.root, prompt: "do work", config: ctx.config })).rejects.toMatchObject({
        code: "CODEX_APP_SERVER_UNAVAILABLE",
        details: { recommendedExecutionMode: "ghostty-visible" },
      });
    } finally {
      await ctx.cleanup();
    }
  });
});
