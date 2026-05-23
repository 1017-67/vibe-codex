import { Config } from "../config/types.js";

export function redactToken(value: string, token?: string): string {
  return token ? value.split(token).join("[REDACTED]") : value;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function buildConnectorUrl(args: { baseUrl: string; urlToken?: string; revealToken?: boolean }): string {
  const tokenPart = args.revealToken && args.urlToken ? args.urlToken : "<URL_TOKEN>";
  return `${normalizeBaseUrl(args.baseUrl)}/mcp/${tokenPart}`;
}

export function authWarnings(config: Config): string[] {
  const warnings: string[] = [];
  const publicBaseUrl = config.publicBaseUrl ?? "";
  const publicTunnel = /^https?:\/\//i.test(publicBaseUrl) && !/localhost|127\.0\.0\.1|\[::1\]/i.test(publicBaseUrl);
  if (config.disableAuth) warnings.push("DISABLE_AUTH is enabled.");
  if (config.relayToken === "dev-token") warnings.push("Bearer auth is using the development token.");
  if (config.allowUrlTokenAuth && !config.urlTokenExpiresAt) warnings.push("URL token auth has no expiry.");
  if (publicTunnel && config.disableAuth) warnings.push("A public tunnel is configured while auth is disabled.");
  if (publicTunnel && config.relayToken === "dev-token") warnings.push("A public tunnel is configured while bearer auth uses dev-token.");
  return warnings;
}
