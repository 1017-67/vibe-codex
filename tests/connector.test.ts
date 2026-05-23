import { describe, expect, it } from "vitest";
import { authWarnings, buildConnectorUrl } from "../src/util/connector.js";
import { tempConfig } from "./helpers.js";

describe("connector helpers", () => {
  it("builds a redacted ChatGPT connector URL", () => {
    expect(buildConnectorUrl({ baseUrl: "https://example.ngrok-free.app/" })).toBe("https://example.ngrok-free.app/mcp/<URL_TOKEN>");
  });

  it("warns on public tunnel with weak development auth", async () => {
    const ctx = await tempConfig();
    try {
      ctx.config.publicBaseUrl = "https://example.ngrok-free.app";
      ctx.config.relayToken = "dev-token";
      const warnings = authWarnings(ctx.config);
      expect(warnings.join("\n")).toContain("public tunnel");
      expect(warnings.join("\n")).toContain("dev-token");
    } finally {
      await ctx.cleanup();
    }
  });
});
