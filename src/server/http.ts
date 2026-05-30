import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Config } from "../config/types.js";
import { bearerAuth, getAuthMethod, getOAuthToken } from "./auth.js";
import { logger } from "../util/logger.js";
import { AuthSessionStore } from "./authSessions.js";
import { OAuthStore, validateOAuthScope, validateRedirectUri } from "./oauthStore.js";
import { RateLimiter, sendRateLimited } from "./rateLimit.js";

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

const MCP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

function requestBaseUrl(req: express.Request, config: Config): string {
  if (config.oauthIssuerBaseUrl) return config.oauthIssuerBaseUrl.replace(/\/+$/, "");
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function requestSecrets(req: express.Request): string[] {
  const secrets: string[] = [];
  const auth = req.header("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) secrets.push(bearer);
  const tokenParam = typeof req.params.urlToken === "string" ? req.params.urlToken : undefined;
  const queryToken = typeof req.query.vibe_token === "string" ? req.query.vibe_token : undefined;
  if (tokenParam) secrets.push(tokenParam);
  if (queryToken) secrets.push(queryToken);
  return secrets;
}

function redactSecrets(config: Config, value: string | undefined, extraSecrets: string[] = []): string | undefined {
  if (!value) return value;
  let redacted = value;
  for (const secret of [config.urlToken, config.relayToken, ...extraSecrets]) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function developmentErrorDetails(config: Config, error: unknown, extraSecrets: string[] = []) {
  if (!config.developmentMode) return {};
  if (error instanceof Error) return { message: redactSecrets(config, error.message, extraSecrets), stack: redactSecrets(config, error.stack, extraSecrets) };
  return { message: redactSecrets(config, String(error), extraSecrets) };
}

function oauthDisabled(res: express.Response) {
  return res.status(404).json({ error: "experimental_oauth_disabled" });
}

function redirectWithError(redirectUri: string, error: string, state?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]!);
}

function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).hostname || "Unknown";
  } catch {
    return "Unknown";
  }
}

function displayOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function readableDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} ${seconds / 86_400 === 1 ? "day" : "days"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} ${seconds / 3_600 === 1 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds / 60 === 1 ? "minute" : "minutes"}`;
  return `${seconds} seconds`;
}

function hiddenInputs(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value ?? "")}">`)
    .join("\n      ");
}

function authorizePageCsp(config: Config): string {
  const redirectHosts = config.oauthAllowedRedirectHosts
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .map((host) => `https://${host}`);
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action 'self' ${redirectHosts.join(" ")}`.trim(),
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function renderAuthorizePage(args: {
  config: Config;
  issuer: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  scope: string;
  resource?: string;
}) {
  const hidden = hiddenInputs({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code_challenge: args.codeChallenge,
    code_challenge_method: args.codeChallengeMethod,
    state: args.state,
    scope: args.scope,
    resource: args.resource,
  });
  const issuer = redactSecrets(args.config, displayOrigin(args.issuer)) ?? displayOrigin(args.issuer);
  const resource = args.resource ? (redactSecrets(args.config, args.resource) ?? args.resource) : "Not specified";
  const scopes = args.scope.trim() || "mcp";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize · Vibe Codex</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f5f5f7;
    --card-bg: #ffffff;
    --text: #1d1d1f;
    --text-secondary: #6e6e73;
    --border: #d2d2d7;
    --panel-bg: #f9f9fb;
    --accent: #0071e3;
    --accent-hover: #0062cc;
    --danger: #86868b;
    --danger-hover: #d63031;
    --code-bg: #f0f0f3;
    --shadow: 0 2px 12px rgba(0,0,0,0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1c1e;
      --card-bg: #2c2c2e;
      --text: #f5f5f7;
      --text-secondary: #98989d;
      --border: #48484a;
      --panel-bg: #38383a;
      --accent: #0a84ff;
      --accent-hover: #409cff;
      --danger: #98989d;
      --danger-hover: #ff453a;
      --code-bg: #3a3a3c;
      --shadow: 0 2px 12px rgba(0,0,0,0.32);
    }
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    line-height: 1.5;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    max-width: 480px;
    width: 100%;
    padding: 32px;
  }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .header .subtitle { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
  .main-title { font-size: 17px; font-weight: 600; text-align: center; margin-bottom: 6px; }
  .main-desc { font-size: 13px; color: var(--text-secondary); text-align: center; margin-bottom: 20px; }
  .panel {
    background: var(--panel-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .panel-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 5px 0;
    font-size: 13px;
    gap: 12px;
  }
  .detail-label { color: var(--text-secondary); flex-shrink: 0; }
  .detail-value { text-align: right; word-break: break-all; }
  .detail-value code {
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
    font-family: "SF Mono", SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  }
  .safety-list { list-style: none; font-size: 13px; }
  .safety-list li { padding: 3px 0; padding-left: 18px; position: relative; }
  .safety-list li::before { position: absolute; left: 0; }
  .safety-list.allows li::before { content: "·"; color: var(--accent); font-weight: 700; }
  .safety-list.blocks li::before { content: "×"; color: var(--danger); font-size: 10px; top: 5px; }
  .safety-divider { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 10px 0 4px; }
  .warning { font-size: 13px; margin-bottom: 10px; }
  .buttons { display: flex; gap: 10px; margin-top: 20px; }
  .button-form { flex: 1; display: flex; }
  .btn {
    flex: 1;
    padding: 10px 0;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .btn-approve { background: var(--accent); color: #fff; }
  .btn-approve:hover { background: var(--accent-hover); }
  .btn-reject { background: transparent; color: var(--danger); border: 1px solid var(--border); }
  .btn-reject:hover { background: var(--danger-hover); color: #fff; border-color: var(--danger-hover); }
  .footer { text-align: center; font-size: 11px; color: var(--text-secondary); margin-top: 20px; line-height: 1.4; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>Vibe Codex</h1>
    <div class="subtitle">Local ChatGPT ↔ Codex pairing</div>
  </div>
  <div class="main-title">ChatGPT wants to connect</div>
  <p class="main-desc">Approve this only if you are currently setting up the Vibe Codex ChatGPT connector.</p>
  <div class="panel">
    <div class="panel-title">Connection details</div>
    <div class="detail-row"><span class="detail-label">Client ID</span><span class="detail-value"><code>${escapeHtml(args.clientId)}</code></span></div>
    <div class="detail-row"><span class="detail-label">Redirect host</span><span class="detail-value"><code>${escapeHtml(redirectHost(args.redirectUri))}</code></span></div>
    <div class="detail-row"><span class="detail-label">Scopes</span><span class="detail-value"><code>${escapeHtml(scopes)}</code></span></div>
    <div class="detail-row"><span class="detail-label">Resource</span><span class="detail-value"><code>${escapeHtml(resource)}</code></span></div>
    <div class="detail-row"><span class="detail-label">Token lifetime</span><span class="detail-value">${escapeHtml(readableDuration(args.config.oauthAccessTokenTtlSeconds))}</span></div>
    <div class="detail-row"><span class="detail-label">Issuer</span><span class="detail-value"><code>${escapeHtml(issuer)}</code></span></div>
  </div>
  <div class="panel">
    <div class="panel-title">Permissions</div>
    <p class="warning">Approving allows ChatGPT to call Vibe Codex tools on this Mac.</p>
    <div class="safety-divider">ChatGPT may request:</div>
    <ul class="safety-list allows">
      <li>File creation inside allowed workspaces</li>
      <li>Workspace inspection</li>
      <li>Visible Codex terminal runs</li>
      <li>Logs, git status, and diff collection</li>
      <li>Approvals for sensitive actions</li>
    </ul>
    <div class="safety-divider">Remains blocked:</div>
    <ul class="safety-list blocks">
      <li>Dangerous commands remain blocked by safety policy</li>
      <li>Hidden Codex execution is not the default</li>
    </ul>
  </div>
  <div class="buttons">
    <form method="POST" action="/authorize" class="button-form">
      ${hidden}
      <input type="hidden" name="action" value="reject">
      <button name="decision" value="reject" type="submit" class="btn btn-reject">Reject</button>
    </form>
    <form method="POST" action="/authorize" class="button-form">
      ${hidden}
      <input type="hidden" name="action" value="approve">
      <button name="decision" value="approve" type="submit" class="btn btn-approve">Approve connection</button>
    </form>
  </div>
  <div class="footer">
    Vibe Codex runs locally on this Mac.<br />
    Keep your tunnel and token private. If you did not start this connection, reject it.
  </div>
</div>
</body>
</html>`;
}

function rateLimitKey(req: express.Request, name: string): string {
  return `${name}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function checkRateLimit(req: express.Request, res: express.Response, limiter: RateLimiter, name: string): boolean {
  const result = limiter.check(rateLimitKey(req, name));
  if (result.allowed) return true;
  sendRateLimited(res, result);
  return false;
}

function hasInvalidProvidedState(value: unknown): boolean {
  return Object.prototype.hasOwnProperty.call({ value }, "value") && typeof value === "string" && value.trim() === "";
}

function isClientRedirectAllowed(oauthStore: OAuthStore, clientId: string, redirectUri: string): boolean {
  const client = oauthStore.getClient(clientId);
  if (!client) return false;
  return client.redirectUris.length === 0 || client.redirectUris.includes(redirectUri);
}

async function cleanupMcpSessions(sessions: Map<string, McpSession>, authSessions: AuthSessionStore, now = Date.now()) {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastSeenAt <= MCP_SESSION_TTL_MS) continue;
    sessions.delete(sessionId);
    authSessions.delete(sessionId);
    await session.server.close().catch((error) => {
      logger.warn("stale_mcp_session_close_failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
    });
    logger.info("stale_mcp_session_cleaned", { sessionId });
  }
}

export function createHttpApp(config: Config, createServer: () => McpServer, authSessions = new AuthSessionStore(), oauthStore?: OAuthStore) {
  oauthStore ??= new OAuthStore(config.databasePath);
  const app = express();
  const sessions = new Map<string, McpSession>();
  const mcpInitializeLimiter = new RateLimiter(60, 60_000);
  const authorizeLimiter = new RateLimiter(120, 60_000);
  const tokenLimiter = new RateLimiter(120, 60_000);
  const registerLimiter = new RateLimiter(20, 60_000);
  const cleanupInterval = setInterval(() => oauthStore.cleanupExpired(), 60_000);
  cleanupInterval.unref();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "0.2.1" });
  });

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    const baseUrl = requestBaseUrl(req, config);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    const baseUrl = requestBaseUrl(req, config);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      revocation_endpoint: `${baseUrl}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  app.post("/register", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, registerLimiter, "oauth_register")) return;
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((uri: unknown) => typeof uri === "string") : [];
    if (redirectUris.some((uri: string) => !validateRedirectUri(config, uri))) {
      return res.status(400).json({ error: "invalid_redirect_uri" });
    }
    const client = oauthStore.registerClient({ redirectUris, clientName: typeof req.body?.client_name === "string" ? req.body.client_name : undefined });
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
    });
  });

  app.get("/authorize", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, authorizeLimiter, "oauth_authorize")) return;
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "");
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const scope = typeof req.query.scope === "string" ? req.query.scope : "mcp";
    const resource = typeof req.query.resource === "string" ? req.query.resource : undefined;
    if (req.query.response_type !== "code" || !oauthStore.validateClient(clientId)) return res.status(400).send("invalid_request");
    if (!validateRedirectUri(config, redirectUri)) return res.status(400).send("invalid_redirect_uri");
    if (!isClientRedirectAllowed(oauthStore, clientId, redirectUri)) return res.status(400).send("invalid_redirect_uri");
    if (hasInvalidProvidedState(req.query.state)) return res.redirect(redirectWithError(redirectUri, "invalid_request", state));
    if (!validateOAuthScope(scope)) return res.redirect(redirectWithError(redirectUri, "invalid_scope", state));
    if (!codeChallenge || codeChallengeMethod !== "S256") return res.redirect(redirectWithError(redirectUri, "invalid_request", state));
    if (!config.oauthRequireLocalApproval || req.query.approve === "1") {
      const code = oauthStore.createCode({ clientId, redirectUri, codeChallenge, scope, resource, config });
      const url = new URL(redirectUri);
      url.searchParams.set("code", code.code);
      if (state) url.searchParams.set("state", state);
      return res.redirect(url.toString());
    }
    res
      .setHeader("Content-Security-Policy", authorizePageCsp(config))
      .type("html")
      .send(renderAuthorizePage({
        config,
        issuer: requestBaseUrl(req, config),
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        state,
        scope,
        resource,
      }));
  });

  app.post("/authorize", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, authorizeLimiter, "oauth_authorize")) return;
    const clientId = String(req.body.client_id ?? "");
    const redirectUri = String(req.body.redirect_uri ?? "");
    const codeChallenge = String(req.body.code_challenge ?? "");
    const codeChallengeMethod = String(req.body.code_challenge_method ?? "");
    const responseType = String(req.body.response_type ?? "");
    const state = typeof req.body.state === "string" ? req.body.state : undefined;
    const scope = typeof req.body.scope === "string" ? req.body.scope : "mcp";
    const resource = typeof req.body.resource === "string" ? req.body.resource : undefined;
    if (!oauthStore.validateClient(clientId) || !validateRedirectUri(config, redirectUri) || !isClientRedirectAllowed(oauthStore, clientId, redirectUri)) return res.status(400).send("invalid_request");
    if (hasInvalidProvidedState(req.body.state) || !validateOAuthScope(scope)) return res.redirect(redirectWithError(redirectUri, "invalid_request", state));
    if (req.body.decision !== "approve") return res.redirect(redirectWithError(redirectUri, "access_denied", state));
    if (responseType !== "code" || !codeChallenge || codeChallengeMethod !== "S256") return res.redirect(redirectWithError(redirectUri, "invalid_request", state));
    const code = oauthStore.createCode({ clientId, redirectUri, codeChallenge, scope, resource, config });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code.code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.post("/token", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, tokenLimiter, "oauth_token")) return;
    if (req.body.grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });
    const consumed = oauthStore.consumeCode({
      code: String(req.body.code ?? ""),
      clientId: String(req.body.client_id ?? ""),
      redirectUri: String(req.body.redirect_uri ?? ""),
      codeVerifier: String(req.body.code_verifier ?? ""),
    });
    if (!consumed.ok) return res.status(400).json({ error: consumed.error });
    const token = oauthStore.createAccessToken({ clientId: consumed.code.clientId, scope: consumed.code.scope, resource: consumed.code.resource ?? req.body.resource, config });
    res.json({
      access_token: token.token,
      token_type: "Bearer",
      expires_in: config.oauthAccessTokenTtlSeconds,
      scope: token.scope,
    });
  });

  app.post("/revoke", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    if (!checkRateLimit(req, res, tokenLimiter, "oauth_revoke")) return;
    const token = typeof req.body.token === "string" ? req.body.token : "";
    if (token) oauthStore.revokeAccessToken(token);
    res.status(200).json({});
  });

  app.all(["/mcp", "/mcp/:urlToken"], bearerAuth(config, oauthStore), async (req, res) => {
    const extraSecrets = requestSecrets(req);
    try {
      await cleanupMcpSessions(sessions, authSessions);
      const rawSessionId = req.header("mcp-session-id");
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && !sessionId && req.method === "POST" && isInitializeBody(req.body)) {
        if (!checkRateLimit(req, res, mcpInitializeLimiter, "mcp_initialize")) return;
        const server = createServer();
        const authMethod = getAuthMethod(req) ?? "bearer";
        const oauthTokenRecord = authMethod === "oauth" ? oauthStore.verifyAccessToken(getOAuthToken(req) ?? "") : null;
        const remoteHost = req.ip;
        const userAgent = req.header("user-agent") ?? undefined;
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server, transport, lastSeenAt: Date.now() });
            authSessions.create({ mcpSessionId: newSessionId, authMethod, remoteHost, userAgent, oauthTokenExpiresAt: oauthTokenRecord?.expiresAt, oauthClientId: oauthTokenRecord?.clientId, config });
            logger.info("mcp_session_initialized", { sessionId: newSessionId });
          },
          onsessionclosed: async (closedSessionId) => {
            const closed = sessions.get(closedSessionId);
            sessions.delete(closedSessionId);
            authSessions.delete(closedSessionId);
            await closed?.server.close().catch((error) => {
              logger.warn("mcp_session_server_close_failed", { sessionId: closedSessionId, error: error instanceof Error ? error.message : String(error) });
            });
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            sessions.delete(closedSessionId);
            authSessions.delete(closedSessionId);
            logger.info("mcp_session_closed", { sessionId: closedSessionId });
          }
        };
        await server.connect(transport);
        session = { server, transport, lastSeenAt: Date.now() };
      } else if (!session) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Invalid or missing MCP session id",
          },
          id: null,
        });
        return;
      }

      const { transport } = session;
      session.lastSeenAt = Date.now();
      if (sessionId) authSessions.touch(sessionId);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("mcp_request_failed", {
        error: redactSecrets(config, error instanceof Error ? error.message : String(error), extraSecrets),
        stack: config.developmentMode && error instanceof Error ? redactSecrets(config, error.stack, extraSecrets) : undefined,
        requestId: randomUUID(),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: "MCP_ERROR",
            message: "MCP request failed.",
            details: developmentErrorDetails(config, error, extraSecrets),
          },
        });
      }
    }
  });

  app.locals.mcpSessions = sessions;
  app.locals.authSessions = authSessions;
  app.locals.oauthCleanupInterval = cleanupInterval;
  return app;
}

export function listen(config: Config, app: express.Express) {
  const httpServer = app.listen(config.port, () => {
    logger.info("vibe_codex_listening", { port: config.port, auth: config.disableAuth ? "disabled" : "bearer" });
    if (config.disableAuth) {
      logger.warn("auth_disabled", { warning: "DISABLE_AUTH is enabled. Do not expose this server through a public tunnel." });
    }
    if (config.relayToken === "dev-token") {
      logger.warn("development_relay_token", { warning: "Bearer auth is using the default development token. Set RELAY_TOKEN before exposing the server." });
    }
    if (config.disableAuth && config.publicBaseUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(config.publicBaseUrl)) {
      logger.error("unsafe_public_tunnel_auth_disabled", { warning: "PUBLIC_BASE_URL appears non-local while DISABLE_AUTH=true." });
    }
  });
  return httpServer;
}
