import { NextFunction, Request, Response } from "express";
import { Config } from "../config/types.js";
import { AuthMethod } from "./authSessions.js";
import { OAuthStore } from "./oauthStore.js";

function queryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function requestUrlToken(req: Request): string | undefined {
  return queryStringValue(req.params.urlToken) ?? queryStringValue(req.query.vibe_token);
}

function hasValidUrlToken(req: Request, config: Config): boolean {
  if (!config.allowUrlTokenAuth || !config.urlToken) return false;
  if (config.urlTokenExpiresAt && Date.now() > Date.parse(config.urlTokenExpiresAt)) return false;
  return requestUrlToken(req) === config.urlToken;
}

export function getAuthMethod(req: Request): AuthMethod | undefined {
  return (req as Request & { vibeAuthMethod?: AuthMethod }).vibeAuthMethod;
}

export function getOAuthToken(req: Request): string | undefined {
  return (req as Request & { vibeOAuthToken?: string }).vibeOAuthToken;
}

function setAuthMethod(req: Request, authMethod: AuthMethod) {
  (req as Request & { vibeAuthMethod?: AuthMethod }).vibeAuthMethod = authMethod;
}

function bearerValue(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function bearerAuth(config: Config, oauthStore?: OAuthStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.disableAuth) return next();
    const suppliedUrlToken = requestUrlToken(req);
    if (suppliedUrlToken && config.allowUrlTokenAuth) {
      if (hasValidUrlToken(req, config)) {
        setAuthMethod(req, "url-token");
        return next();
      }
      return res.status(403).json({ error: { code: "AUTH_INVALID", message: "URL token is invalid.", details: {} } });
    }
    if (hasValidUrlToken(req, config)) {
      setAuthMethod(req, "url-token");
      return next();
    }
    const header = req.header("authorization");
    if (!header) return res.status(401).json({ error: { code: "AUTH_REQUIRED", message: "Authorization bearer token is required.", details: {} } });
    const token = bearerValue(header);
    if (config.enableExperimentalOAuth && token && oauthStore?.verifyAccessToken(token)) {
      setAuthMethod(req, "oauth");
      (req as Request & { vibeOAuthToken?: string }).vibeOAuthToken = token;
      return next();
    }
    const expected = `Bearer ${config.relayToken}`;
    if (header !== expected) return res.status(403).json({ error: { code: "AUTH_INVALID", message: "Authorization bearer token is invalid.", details: {} } });
    setAuthMethod(req, "bearer");
    return next();
  };
}
