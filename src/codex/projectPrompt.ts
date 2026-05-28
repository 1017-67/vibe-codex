import { AutonomyLevel } from "../config/types.js";
import { ProjectRecord } from "../runs/types.js";

export function compileProjectCodexPrompt(args: {
  project: ProjectRecord;
  runId: string;
  workspacePath: string;
  userGoal: string;
  executionMode: string;
  autonomy: AutonomyLevel;
  codexThreadId?: string;
  context?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  verification?: string[];
}) {
  const lines = [
    "Vibe Codex handoff",
    "",
    `Source: ChatGPT via Vibe Codex`,
    `Project: ${args.project.name}`,
    `projectId: ${args.project.id}`,
    `workspacePath: ${args.workspacePath}`,
    `runId: ${args.runId}`,
    `executionMode: ${args.executionMode}`,
    args.codexThreadId ? `codexThreadId: ${args.codexThreadId}` : undefined,
    "",
    "Goal:",
    args.userGoal,
    "",
    "Constraints:",
    "- Stay inside this workspace.",
    "- Do not read or expose secrets.",
    "- Do not use sudo.",
    "- Do not make unrelated changes.",
    "- Avoid destructive/system actions unless explicitly approved.",
    ...((args.constraints ?? []).map((item) => `- ${item}`)),
    "",
    "Expected report fields:",
    "- summary",
    "- files changed",
    "- commands run",
    "- checks/tests run",
    "- remaining issues",
    "- git status if relevant",
  ].filter((line): line is string => line !== undefined);

  if (args.context?.length) lines.push("", "Context:", ...args.context.map((item) => `- ${item}`));
  if (args.acceptanceCriteria?.length) lines.push("", "Acceptance criteria:", ...args.acceptanceCriteria.map((item) => `- ${item}`));
  if (args.verification?.length) lines.push("", "Verification:", ...args.verification.map((item) => `- ${item}`));
  lines.push(
    "",
    "Before editing:",
    "1. Inspect the relevant files.",
    "2. Make a brief plan.",
    "3. Implement the smallest complete solution.",
    "4. Run checks if available.",
    "5. Report the expected fields above.",
  );
  return lines.join("\n");
}
