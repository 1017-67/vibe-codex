import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Config } from "../config/types.js";
import { bearerAuth, getAuthMethod, getOAuthToken } from "./auth.js";
import { logger } from "../util/logger.js";
import { AuthSessionStore } from "./authSessions.js";
import { OAuthStore, validateRedirectUri } from "./oauthStore.js";

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

function requestBaseUrl(req: express.Request, config: Config): string {
  if (config.oauthIssuerBaseUrl) return config.oauthIssuerBaseUrl.replace(/\/+$/, "");
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function redactSecrets(config: Config, value: string | undefined, oauthStore?: OAuthStore): string | undefined {
  if (!value) return value;
  let redacted = value;
  for (const secret of [config.urlToken, config.relayToken, ...(oauthStore?.secretsForRedaction() ?? [])]) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function developmentErrorDetails(config: Config, error: unknown, oauthStore?: OAuthStore) {
  if (!config.developmentMode) return {};
  if (error instanceof Error) return { message: redactSecrets(config, error.message, oauthStore), stack: redactSecrets(config, error.stack, oauthStore) };
  return { message: redactSecrets(config, String(error), oauthStore) };
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

export function createHttpApp(config: Config, createServer: () => McpServer, authSessions = new AuthSessionStore(), oauthStore = new OAuthStore()) {
  const app = express();
  const sessions = new Map<string, McpSession>();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "0.2.0" });
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
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  app.post("/register", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
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
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "");
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const scope = typeof req.query.scope === "string" ? req.query.scope : "mcp";
    const resource = typeof req.query.resource === "string" ? req.query.resource : undefined;
    if (req.query.response_type !== "code" || !oauthStore.validateClient(clientId)) return res.status(400).send("invalid_request");
    if (!validateRedirectUri(config, redirectUri)) return res.status(400).send("invalid_redirect_uri");
    if (!codeChallenge || codeChallengeMethod !== "S256") return res.redirect(redirectWithError(redirectUri, "invalid_request", state));
    if (!config.oauthRequireLocalApproval || req.query.approve === "1") {
      const code = oauthStore.createCode({ clientId, redirectUri, codeChallenge, scope, resource, config });
      const url = new URL(redirectUri);
      url.searchParams.set("code", code.code);
      if (state) url.searchParams.set("state", state);
      return res.redirect(url.toString());
    }
    const escaped = (value: string | undefined) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]!);
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Approve Vibe Codex OAuth</title></head>
<body>
  <h1>Approve Vibe Codex OAuth</h1>
  <dl>
    <dt>client_id</dt><dd>${escaped(clientId)}</dd>
    <dt>redirect_uri</dt><dd>${escaped(redirectUri)}</dd>
    <dt>scope</dt><dd>${escaped(scope)}</dd>
    <dt>resource</dt><dd>${escaped(resource)}</dd>
  </dl>
  <form method="post" action="/authorize">
    ${["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"].map((key) => `<input type="hidden" name="${key}" value="${escaped(String(req.query[key] ?? ""))}">`).join("\n")}
    <button name="decision" value="approve" type="submit">Approve</button>
    <button name="decision" value="reject" type="submit">Reject</button>
  </form>
</body></html>`);
  });

  app.post("/authorize", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
    const clientId = String(req.body.client_id ?? "");
    const redirectUri = String(req.body.redirect_uri ?? "");
    const codeChallenge = String(req.body.code_challenge ?? "");
    const state = typeof req.body.state === "string" ? req.body.state : undefined;
    const scope = typeof req.body.scope === "string" ? req.body.scope : "mcp";
    const resource = typeof req.body.resource === "string" ? req.body.resource : undefined;
    if (!oauthStore.validateClient(clientId) || !validateRedirectUri(config, redirectUri)) return res.status(400).send("invalid_request");
    if (req.body.decision !== "approve") return res.redirect(redirectWithError(redirectUri, "access_denied", state));
    const code = oauthStore.createCode({ clientId, redirectUri, codeChallenge, scope, resource, config });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code.code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.post("/token", (req, res) => {
    if (!config.enableExperimentalOAuth) return oauthDisabled(res);
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

  app.all(["/mcp", "/mcp/:urlToken"], bearerAuth(config, oauthStore), async (req, res) => {
    try {
      const rawSessionId = req.header("mcp-session-id");
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && !sessionId && req.method === "POST" && isInitializeBody(req.body)) {
        const server = createServer();
        const authMethod = getAuthMethod(req) ?? "bearer";
        const oauthTokenRecord = authMethod === "oauth" ? oauthStore.verifyAccessToken(getOAuthToken(req) ?? "") : null;
        const remoteHost = req.ip;
        const userAgent = req.header("user-agent") ?? undefined;
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server, transport });
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
        session = { server, transport };
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
      if (sessionId) authSessions.touch(sessionId);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("mcp_request_failed", {
        error: redactSecrets(config, error instanceof Error ? error.message : String(error), oauthStore),
        stack: config.developmentMode && error instanceof Error ? redactSecrets(config, error.stack, oauthStore) : undefined,
        requestId: randomUUID(),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: "MCP_ERROR",
            message: "MCP request failed.",
            details: developmentErrorDetails(config, error, oauthStore),
          },
        });
      }
    }
  });

  app.locals.mcpSessions = sessions;
  app.locals.authSessions = authSessions;
  return app;
}

export function listen(config: Config, app: express.Express) {
  const httpServer = app.listen(config.port, () => {
    logger.info("vibe_codex_listening", { port: config.port, auth: config.disableAuth ? "disabled" : "bearer" });
  });
  return httpServer;
}
