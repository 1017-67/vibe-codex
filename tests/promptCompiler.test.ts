import { describe, expect, it } from "vitest";
import { compileCodexPrompt } from "../src/codex/promptCompiler.js";

describe("prompt compiler", () => {
  it("includes the main prompt sections and safety rules", () => {
    const prompt = compileCodexPrompt({
      workspacePath: "/tmp/work",
      userGoal: "Build the thing",
      constraints: ["Use TypeScript"],
      acceptanceCriteria: ["Tests pass"],
      autonomy: "workspace",
    });
    expect(prompt).toContain("/tmp/work");
    expect(prompt).toContain("Build the thing");
    expect(prompt).toContain("Use TypeScript");
    expect(prompt).toContain("Tests pass");
    expect(prompt).toContain("Do not read secrets");
    expect(prompt).toContain("Do not use sudo");
  });
});
