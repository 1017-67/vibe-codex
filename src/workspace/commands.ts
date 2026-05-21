import { AutonomyLevel, Config } from "../config/types.js";
import { canExecuteRisk } from "../safety/approvals.js";
import { classifyCommand } from "../safety/commandRisk.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { VibeError } from "../util/errors.js";
import { runShellCommand } from "../util/spawn.js";

export async function runWorkspaceCommand(args: {
  workspacePath: string;
  command: string;
  autonomy: AutonomyLevel;
  timeoutMs?: number;
  config: Config;
}) {
  const cwd = await assertSafeWorkspacePath(args.workspacePath, args.config);
  const risk = classifyCommand(args.command);
  if (risk.risk === "blocked") {
    throw new VibeError("COMMAND_BLOCKED", risk.reason, { command: args.command });
  }
  if (risk.risk === "dangerous") {
    return { command: args.command, risk: risk.risk, executed: false, approvalRequired: true, reason: risk.reason };
  }
  if (!canExecuteRisk(args.autonomy, risk.risk)) {
    return { command: args.command, risk: risk.risk, executed: false, approvalRequired: args.autonomy !== "manual", reason: `Autonomy ${args.autonomy} cannot execute ${risk.risk} commands.` };
  }
  const result = await runShellCommand({
    command: args.command,
    cwd,
    timeoutMs: args.timeoutMs ?? args.config.commandTimeoutMs,
    maxOutputBytes: args.config.maxCommandOutputBytes,
  });
  return { command: args.command, risk: risk.risk, executed: true, approvalRequired: false, reason: risk.reason, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
}
