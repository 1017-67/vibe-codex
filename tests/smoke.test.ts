import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";
import { createMcpServer } from "../src/server/mcpServer.js";
import { initRunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";

describe("smoke", () => {
  it("loads config in development mode", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.port).toBe(8787);
    expect(config.disableAuth).toBe(false);
  });

  it("registers tools without crashing", async () => {
    const ctx = await tempConfig();
    try {
      const store = initRunStore(ctx.config.databasePath);
      const server = createMcpServer(ctx.config, store);
      expect(server).toBeTruthy();
      store.db.close();
    } finally {
      await ctx.cleanup();
    }
  });
});
