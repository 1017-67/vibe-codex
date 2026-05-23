import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Config } from "../config/types.js";
import { constantTimeEqual } from "../util/crypto.js";

export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: string;
}

export interface OAuthAuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

export interface OAuthAccessTokenRecord {
  token: string;
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: string;
  createdAt: string;
}

export class OAuthStore {
  private clients = new Map<string, OAuthClientRecord>();
  private codes = new Map<string, OAuthAuthCodeRecord>();
  private tokens = new Map<string, OAuthAccessTokenRecord>();

  registerClient(args: { clientId?: string; redirectUris?: string[]; clientName?: string }): OAuthClientRecord {
    const clientId = args.clientId || `vibe_client_${randomUUID()}`;
    const record: OAuthClientRecord = {
      clientId,
      redirectUris: args.redirectUris ?? [],
      clientName: args.clientName,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(clientId, record);
    return record;
  }

  validateClient(clientId: string): boolean {
    return typeof clientId === "string" && this.clients.has(clientId);
  }

  getClient(clientId: string): OAuthClientRecord | undefined {
    return this.clients.get(clientId);
  }

  createCode(args: { clientId: string; redirectUri: string; codeChallenge: string; scope?: string; resource?: string; config: Config }): OAuthAuthCodeRecord {
    this.cleanupExpired();
    const now = Date.now();
    const record: OAuthAuthCodeRecord = {
      code: randomBytes(32).toString("base64url"),
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      scope: args.scope || "mcp",
      resource: args.resource,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + args.config.oauthAuthCodeTtlSeconds * 1000).toISOString(),
    };
    this.codes.set(record.code, record);
    return record;
  }

  consumeCode(args: { code: string; clientId: string; redirectUri: string; codeVerifier: string }): { ok: true; code: OAuthAuthCodeRecord } | { ok: false; error: string } {
    this.cleanupExpired();
    const record = this.codes.get(args.code);
    if (!record) return { ok: false, error: "invalid_grant" };
    if (record.usedAt) return { ok: false, error: "invalid_grant" };
    if (Date.now() > Date.parse(record.expiresAt)) return { ok: false, error: "invalid_grant" };
    if (!constantTimeEqual(record.clientId, args.clientId) || record.redirectUri !== args.redirectUri) return { ok: false, error: "invalid_grant" };
    if (!constantTimeEqual(pkceS256(args.codeVerifier), record.codeChallenge)) return { ok: false, error: "invalid_grant" };
    record.usedAt = new Date().toISOString();
    this.codes.delete(record.code);
    return { ok: true, code: record };
  }

  createAccessToken(args: { clientId: string; scope: string; resource?: string; config: Config }): OAuthAccessTokenRecord {
    this.cleanupExpired();
    const now = Date.now();
    const record: OAuthAccessTokenRecord = {
      token: `vibe_oauth_${randomBytes(32).toString("base64url")}`,
      clientId: args.clientId,
      scope: args.scope,
      resource: args.resource,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + args.config.oauthAccessTokenTtlSeconds * 1000).toISOString(),
    };
    this.tokens.set(record.token, record);
    return record;
  }

  verifyAccessToken(token: string): OAuthAccessTokenRecord | null {
    this.cleanupExpired();
    for (const record of this.tokens.values()) {
      if (constantTimeEqual(record.token, token)) return record;
    }
    return null;
  }

  revokeAccessToken(token: string): boolean {
    for (const record of this.tokens.values()) {
      if (constantTimeEqual(record.token, token)) {
        this.tokens.delete(record.token);
        return true;
      }
    }
    return false;
  }

  cleanupExpired(now = Date.now()) {
    for (const [code, record] of this.codes) {
      if (record.usedAt || now > Date.parse(record.expiresAt)) this.codes.delete(code);
    }
    for (const [token, record] of this.tokens) {
      if (now > Date.parse(record.expiresAt)) this.tokens.delete(token);
    }
  }
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validateRedirectUri(config: Config, redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri);
    return ["https:", "http:"].includes(parsed.protocol) && config.oauthAllowedRedirectHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function validateOAuthScope(scope: string | undefined): boolean {
  const values = (scope || "mcp").split(/\s+/).filter(Boolean);
  return values.length > 0 && values.every((value) => value === "mcp");
}
