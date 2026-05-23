import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Config } from "../config/types.js";
import { bearerAuth, getAuthMethod } from "./auth.js";
import { logger } from "../util/logger.js";
import { AuthSessionStore } from "./authSessions.js";

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

function redactSecrets(config: Config, value: string | undefined): string | undefined {
  if (!value) return value;
  let redacted = value;
  for (const secret of [config.urlToken, config.relayToken]) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function developmentErrorDetails(config: Config, error: unknown) {
  if (!config.developmentMode) return {};
  if (error instanceof Error) return { message: redactSecrets(config, error.message), stack: redactSecrets(config, error.stack) };
  return { message: redactSecrets(config, String(error)) };
}

export function createHttpApp(config: Config, createServer: () => McpServer) {
  const app = express();
  const sessions = new Map<string, McpSession>();
  const authSessions = new AuthSessionStore();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "0.2.0" });
  });

  app.all(["/mcp", "/mcp/:urlToken"], bearerAuth(config), async (req, res) => {
    try {
      const rawSessionId = req.header("mcp-session-id");
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && !sessionId && req.method === "POST" && isInitializeBody(req.body)) {
        const server = createServer();
        const authMethod = getAuthMethod(req) ?? "bearer";
        const remoteHost = req.ip;
        const userAgent = req.header("user-agent") ?? undefined;
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server, transport });
            authSessions.create({ mcpSessionId: newSessionId, authMethod, remoteHost, userAgent, config });
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
        error: redactSecrets(config, error instanceof Error ? error.message : String(error)),
        stack: config.developmentMode && error instanceof Error ? redactSecrets(config, error.stack) : undefined,
        requestId: randomUUID(),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: "MCP_ERROR",
            message: "MCP request failed.",
            details: developmentErrorDetails(config, error),
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
