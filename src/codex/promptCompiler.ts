import { AutonomyLevel } from "../config/types.js";

function section(title: string, items?: string[] | string): string {
  if (!items || (Array.isArray(items) && items.length === 0)) return "";
  if (Array.isArray(items)) return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}\n\n`;
  return `${title}:\n${items}\n\n`;
}

export function compileCodexPrompt(args: {
  workspacePath: string;
  userGoal: string;
  context?: string[];
  constraints?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  verification?: string[];
  autonomy: AutonomyLevel;
}): string {
  const constraints = [
    "Stay inside this workspace.",
    "Do not read secrets.",
    "Do not use sudo.",
    "Do not make unrelated changes.",
    "Avoid destructive/system actions unless explicitly approved.",
    ...(args.constraints ?? []),
  ];
  return `You are Codex working in this local workspace:

${args.workspacePath}

Goal:
${args.userGoal}

Autonomy:
${args.autonomy}

${section("Context", args.context)}${section("Constraints", constraints)}${section("Non-goals", args.nonGoals)}${section("Acceptance criteria", args.acceptanceCriteria)}${section("Verification", args.verification)}Before editing:
1. Inspect the relevant files.
2. Make a brief plan.
3. Implement the smallest complete solution.
4. Run checks if available.
5. Report changed files, commands run, test results, and remaining issues.
`;
}
