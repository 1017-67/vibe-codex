import { AutonomyLevel } from "../config/types.js";
import { CommandRisk } from "./commandRisk.js";

export function canExecuteRisk(autonomy: AutonomyLevel, risk: CommandRisk): boolean {
  if (risk === "blocked" || risk === "dangerous") return false;
  if (autonomy === "manual") return false;
  if (autonomy === "workspace") return risk === "safe";
  return risk === "safe" || risk === "normal";
}

export function canWriteFiles(autonomy: AutonomyLevel): boolean {
  return autonomy !== "manual";
}

export function canRunCodex(autonomy: AutonomyLevel): boolean {
  return autonomy !== "manual";
}
