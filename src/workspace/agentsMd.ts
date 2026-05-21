import { AutonomyLevel } from "../config/types.js";

export function generateAgentsMd(args: {
  projectName: string;
  autonomy: AutonomyLevel;
  userNotes?: string;
}): string {
  return `# Agent instructions

You are working in this project through Vibe Codex.

Project: ${args.projectName}
Autonomy: ${args.autonomy}

## Core rules

- Stay within this repository unless explicitly instructed.
- Do not make broad unrelated changes.
- Inspect before editing.
- Prefer small, testable steps.
- Run available checks before finishing.
- Report changed files and commands run.
- Do not read or expose secrets.
- Ask before destructive actions.
- Do not use sudo.
- Do not modify files outside this repository.
${args.userNotes ? `\n## User notes\n\n${args.userNotes}\n` : ""}
## Completion report

At the end, report:
- Summary of changes
- Files changed
- Commands run
- Tests/checks performed
- Any remaining issues
`;
}
