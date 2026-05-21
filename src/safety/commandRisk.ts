export type CommandRisk = "safe" | "normal" | "dangerous" | "blocked";

export interface CommandRiskResult {
  risk: CommandRisk;
  reason: string;
}

const secretPatterns = [
  /(^|\s|["'])~\/\.ssh(\/|\s|["']|$)/i,
  /(^|\s|["'])~\/\.codex(\/|\s|["']|$)/i,
  /Library\/Keychains/i,
  /Application Support\/(Google\/Chrome|Firefox|BraveSoftware|Microsoft Edge)/i,
  /(^|\s)(cat|less|more|head|tail|sed|awk)\s+[^|;&]*(id_rsa|id_ed25519|\.pem|\.key|\.p12|\.env|auth\.json|cookies?)/i,
  /(security\s+find-(generic|internet)-password)/i,
];

function normalized(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function classifyCommand(command: string): CommandRiskResult {
  const cmd = normalized(command);
  const lower = cmd.toLowerCase();
  if (!cmd) return { risk: "blocked", reason: "Empty command." };

  if (/^sudo(\s|$)/i.test(cmd)) return { risk: "blocked", reason: "sudo is never allowed." };
  if (secretPatterns.some((pattern) => pattern.test(cmd))) {
    return { risk: "blocked", reason: "Command accesses secrets or sensitive local stores." };
  }
  if (/(curl|wget)\b[^|;&]*\|\s*(sh|bash|zsh|python|python3|ruby|perl)\b/i.test(cmd)) {
    return { risk: "blocked", reason: "Piping network output into an interpreter is blocked." };
  }
  if (/pbpaste\s*\|\s*(curl|wget)\b/i.test(cmd)) {
    return { risk: "blocked", reason: "Exfiltrating clipboard contents is blocked." };
  }
  if (/^rm\s+-[^\s]*r[^\s]*f?[^\s]*(\s+|$)(\/|~|\$HOME)(\s|$)/i.test(cmd) || /^rm\s+-[^\s]*f?[^\s]*r[^\s]*(\s+|$)(\/|~|\$HOME)(\s|$)/i.test(cmd)) {
    return { risk: "blocked", reason: "Destructive remove against system or home path is blocked." };
  }

  const safePatterns = [
    /^git status(\s|$)/,
    /^git diff(\s|$)/,
    /^git log --oneline(\s|$)/,
    /^ls(\s|$)/,
    /^pwd$/,
    /^find \. -maxdepth [1-9][0-9]* -type f(\s|$)/,
    /^node --version$/,
    /^npm --version$/,
    /^python --version$/,
    /^python3 --version$/,
    /^npm test(\s|$)/,
    /^npm run (build|lint|test)(\s|$)/,
    /^pytest(\s|$)/,
    /^vitest(\s|$)/,
  ];
  if (safePatterns.some((pattern) => pattern.test(cmd))) {
    return { risk: "safe", reason: "Command matches the safe allowlist." };
  }

  if (/^git reset --hard(\s|$)/.test(lower) || /^git clean -[^\s]*(f|d)/.test(lower)) {
    return { risk: "dangerous", reason: "Destructive git command requires approval." };
  }
  if (/^(chmod|chown)\s+-R(\s|$)/i.test(cmd)) {
    return { risk: "dangerous", reason: "Recursive permission or ownership changes require approval." };
  }
  if (/^(curl|wget)(\s|$)/i.test(cmd)) {
    return { risk: "dangerous", reason: "Network fetch commands require approval in v0.1." };
  }
  if (/^brew install(\s|$)/i.test(cmd)) {
    return { risk: "dangerous", reason: "System package installation requires approval." };
  }
  if (/^npm install -g(\s|$)/i.test(cmd)) {
    return { risk: "dangerous", reason: "Global npm installation requires approval." };
  }
  if (/^pip(3)? install(?!\s+-r\s+requirements\.txt)(\s|$)/i.test(cmd)) {
    return { risk: "dangerous", reason: "Ad hoc pip installation requires approval." };
  }
  if (/^rm\s+-[^\s]*r/i.test(cmd)) {
    return { risk: "dangerous", reason: "Recursive remove requires approval." };
  }

  const normalPatterns = [
    /^npm install(\s|$)/,
    /^npm create vite@latest(\s|$)/,
    /^npm run dev(\s|$)/,
    /^python scripts\/validate\.py(\s|$)/,
    /^python3 scripts\/validate\.py(\s|$)/,
    /^pip install -r requirements\.txt(\s|$)/,
  ];
  if (normalPatterns.some((pattern) => pattern.test(cmd))) {
    return { risk: "normal", reason: "Command is a normal project setup/build command." };
  }

  if (/\b(npm|pnpm|yarn|pip|python|python3|node|git|make|cmake)\b/.test(lower)) {
    return { risk: "normal", reason: "Command is project-scoped but not on the strict safe allowlist." };
  }

  return { risk: "dangerous", reason: "Command is not recognized by the v0.1 allowlist." };
}
