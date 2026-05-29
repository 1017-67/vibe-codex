import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileProjectCodexPrompt } from "../src/codex/projectPrompt.js";
import { initRunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";

describe("project registry", () => {
  it("registers, updates, lists, and looks up persistent projects", async () => {
    const ctx = await tempConfig();
    try {
      const store = initRunStore(ctx.config.databasePath);
      const workspace = path.join(ctx.root, "registered");
      await fs.mkdir(workspace);
      const project = store.createProject({
        name: "Registered Project",
        path: workspace,
        repoRemote: "git@example.test:repo.git",
        preferredExecutionMode: "codex-app-thread",
        defaultCodexThreadId: "thread-1",
        recentCodexThreadIds: ["thread-1"],
        notes: "Project notes",
      });
      expect(project).toMatchObject({
        name: "Registered Project",
        path: workspace,
        repoRemote: "git@example.test:repo.git",
        preferredExecutionMode: "codex-app-thread",
        defaultCodexThreadId: "thread-1",
        recentCodexThreadIds: ["thread-1"],
        notes: "Project notes",
      });
      expect(store.getProject(project.id)?.id).toBe(project.id);
      expect(store.getProjectByPath(workspace)?.id).toBe(project.id);
      expect(store.getProjectByName("registered project")?.id).toBe(project.id);
      expect(store.listProjects().map((item) => item.id)).toContain(project.id);
      const updated = store.updateProject(project.id, { defaultCodexThreadId: "thread-2", recentCodexThreadIds: ["thread-2", "thread-1"] });
      expect(updated.defaultCodexThreadId).toBe("thread-2");
      expect(updated.recentCodexThreadIds).toEqual(["thread-2", "thread-1"]);
      store.db.close();
    } finally {
      await ctx.cleanup();
    }
  });

  it("project prompt envelope includes source, project, run, workspace, and thread fields", async () => {
    const project = {
      id: "project-1",
      name: "Vibe Codex",
      path: "/tmp/vibe-codex",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const prompt = compileProjectCodexPrompt({
      project,
      runId: "run-1",
      workspacePath: project.path,
      userGoal: "Do the work",
      executionMode: "codex-app-thread",
      autonomy: "workspace",
      codexThreadId: "thread-1",
    });
    expect(prompt).toContain("Source: ChatGPT via Vibe Codex");
    expect(prompt).toContain("Project: Vibe Codex");
    expect(prompt).toContain("projectId: project-1");
    expect(prompt).toContain("workspacePath: /tmp/vibe-codex");
    expect(prompt).toContain("runId: run-1");
    expect(prompt).toContain("executionMode: codex-app-thread");
    expect(prompt).toContain("codexThreadId: thread-1");
    expect(prompt).toContain("Expected report fields:");
    expect(prompt).toContain("use `rg --files` or `find .`, not `find ..`");
  });
});
