import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace, sanitizeWorkspaceName } from "../src/workspace/createWorkspace.js";
import { tempConfig } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;

beforeEach(async () => {
  ctx = await tempConfig();
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("workspace creation", () => {
  it("sanitizes workspace names", () => {
    expect(sanitizeWorkspaceName("ok-name_1.2")).toBe("ok-name_1.2");
    expect(() => sanitizeWorkspaceName("../bad")).toThrow();
    expect(() => sanitizeWorkspaceName("bad;rm")).toThrow();
  });

  it("creates an empty workspace", async () => {
    const result = await createWorkspace({ name: "empty", autonomy: "workspace", config: ctx.config, initGit: false, createAgentsMd: false });
    await expect(fs.stat(result.workspacePath)).resolves.toBeTruthy();
    expect(result.createdFiles).toEqual([]);
  });

  it("creates AGENTS.md", async () => {
    const result = await createWorkspace({ name: "with-agents", autonomy: "workspace", config: ctx.config, initGit: false, createAgentsMd: true });
    const content = await fs.readFile(path.join(result.workspacePath, "AGENTS.md"), "utf8");
    expect(content).toContain("Agent instructions");
    expect(result.createdFiles).toContain("AGENTS.md");
  });

  it("rejects unsafe names", async () => {
    await expect(createWorkspace({ name: "../nope", autonomy: "workspace", config: ctx.config })).rejects.toMatchObject({ code: "UNSAFE_WORKSPACE_NAME" });
  });
});
