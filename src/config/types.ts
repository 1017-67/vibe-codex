export type AutonomyLevel = "manual" | "workspace" | "build-test" | "full-project";

export interface Config {
  port: number;
  relayToken?: string;
  allowUrlTokenAuth: boolean;
  urlToken?: string;
  urlTokenRequiredPrefix: string;
  urlTokenMinLength: number;
  urlTokenExpiresAt?: string;
  disableAuth: boolean;
  developmentMode: boolean;
  allowedRoots: string[];
  defaultParentDir: string;
  publicBaseUrl?: string;
  codexBin: string;
  databasePath: string;
  defaultCodexApproval: string;
  defaultCodexSandbox: string;
  allowNetworkCommands: boolean;
  maxCommandOutputBytes: number;
  commandTimeoutMs: number;
  codexTimeoutMs: number;
  requireApprovalForCodexVisible: boolean;
  requireApprovalForCodexHidden: boolean;
  requireApprovalForWriteFile: boolean;
  requireApprovalForNormalCommands: boolean;
  enableExperimentalOAuth: boolean;
  oauthIssuerBaseUrl?: string;
  oauthAccessTokenTtlSeconds: number;
  oauthAuthCodeTtlSeconds: number;
  oauthAllowedRedirectHosts: string[];
  oauthRequireLocalApproval: boolean;
}

export const AUTONOMY_LEVELS: AutonomyLevel[] = ["manual", "workspace", "build-test", "full-project"];
