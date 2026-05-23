import { AutonomyLevel } from "../config/types.js";

export type RunStatus = "queued" | "running" | "running_visible" | "interactive_ready" | "interactive_started" | "unknown_interactive" | "completed" | "completed_visible" | "failed" | "failed_visible" | "approval_required";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  autonomy: AutonomyLevel;
  prompt: string;
  codexCommand: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  summary?: string;
  metadata?: Record<string, unknown>;
}
