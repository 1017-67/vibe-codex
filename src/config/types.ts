export type AutonomyLevel = "manual" | "workspace" | "build-test" | "full-project";

export interface Config {
  port: number;
  relayToken?: string;
  disableAuth: boolean;
  developmentMode: boolean;
  allowedRoots: string[];
  defaultParentDir: string;
  codexBin: string;
  databasePath: string;
  defaultCodexApproval: string;
  defaultCodexSandbox: string;
  allowNetworkCommands: boolean;
  maxCommandOutputBytes: number;
  commandTimeoutMs: number;
  codexTimeoutMs: number;
}

export const AUTONOMY_LEVELS: AutonomyLevel[] = ["manual", "workspace", "build-test", "full-project"];
