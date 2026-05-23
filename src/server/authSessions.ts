import { AutonomyLevel, Config } from "../config/types.js";

export type AuthMethod = "bearer" | "url-token" | "oauth";

export interface AuthSessionRecord {
  mcpSessionId: string;
  authMethod: AuthMethod;
  createdAt: string;
  lastSeenAt: string;
  remoteHost?: string;
  userAgent?: string;
  oauthTokenExpiresAt?: string;
  oauthClientId?: string;
  allowedRoots: string[];
  defaultAutonomy: AutonomyLevel;
}

export class AuthSessionStore {
  private sessions = new Map<string, AuthSessionRecord>();

  create(args: {
    mcpSessionId: string;
    authMethod: AuthMethod;
    remoteHost?: string;
    userAgent?: string;
    oauthTokenExpiresAt?: string;
    oauthClientId?: string;
    config: Config;
  }): AuthSessionRecord {
    const now = new Date().toISOString();
    const record: AuthSessionRecord = {
      mcpSessionId: args.mcpSessionId,
      authMethod: args.authMethod,
      createdAt: now,
      lastSeenAt: now,
      remoteHost: args.remoteHost,
      userAgent: args.userAgent,
      oauthTokenExpiresAt: args.oauthTokenExpiresAt,
      oauthClientId: args.oauthClientId,
      allowedRoots: args.config.allowedRoots,
      defaultAutonomy: "workspace",
    };
    this.sessions.set(args.mcpSessionId, record);
    return record;
  }

  touch(mcpSessionId: string): AuthSessionRecord | undefined {
    const record = this.sessions.get(mcpSessionId);
    if (record) record.lastSeenAt = new Date().toISOString();
    return record;
  }

  delete(mcpSessionId: string) {
    this.sessions.delete(mcpSessionId);
  }

  get(mcpSessionId: string): AuthSessionRecord | undefined {
    return this.sessions.get(mcpSessionId);
  }

  list(): AuthSessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}
