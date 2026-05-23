import { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcpServer.js";
import { createHttpApp } from "../src/server/http.js";
import { initRunStore, RunStore } from "../src/runs/runStore.js";
import { tempConfig } from "./helpers.js";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";
import { AuthSessionStore } from "../src/server/authSessions.js";
import { OAuthStore } from "../src/server/oauthStore.js";

let ctx: Awaited<ReturnType<typeof tempConfig>>;
let store: RunStore;
let baseUrl: string;
let httpServer: ReturnType<ReturnType<typeof createHttpApp>["listen"]>;

function pkce(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseMcpResponse(text: string): any {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

async function getCode(args?: { verifier?: string; redirectUri?: string; clientId?: string; expectCode?: boolean }) {
  const verifier = args?.verifier ?? randomBytes(32).toString("base64url");
  const redirectUri = args?.redirectUri ?? "https://chatgpt.com/aip/callback";
  const clientId = args?.clientId ?? await registerClient(redirectUri);
  const auth = new URL(`${baseUrl}/authorize`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("code_challenge", pkce(verifier));
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("state", "abc");
  auth.searchParams.set("scope", "mcp");
  auth.searchParams.set("resource", `${baseUrl}/mcp`);
  auth.searchParams.set("approve", "1");
  const response = await fetch(auth, { redirect: "manual" });
  const location = response.headers.get("location")!;
  if (args?.expectCode === false) return { verifier, redirectUri, clientId, code: null, response };
  return { verifier, redirectUri, clientId, code: new URL(location).searchParams.get("code")!, response };
}

async function registerClient(redirectUri = "https://chatgpt.com/aip/callback") {
  const response = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "ChatGPT" }),
  });
  const body = await response.json();
  return body.client_id as string;
}

async function exchange(args: { code: string; verifier: string; redirectUri?: string; clientId: string }) {
  return fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      redirect_uri: args.redirectUri ?? "https://chatgpt.com/aip/callback",
      code_verifier: args.verifier,
    }),
  });
}

beforeEach(async () => {
  ctx = await tempConfig();
  ctx.config.developmentMode = true;
  ctx.config.disableAuth = false;
  ctx.config.relayToken = "test-token";
  ctx.config.urlToken = "vibe_url_token_that_should_not_render";
  ctx.config.enableExperimentalOAuth = true;
  ctx.config.oauthRequireLocalApproval = false;
  ctx.config.oauthAllowedRedirectHosts = ["chatgpt.com", "chat.openai.com"];
  store = initRunStore(ctx.config.databasePath);
  const stores = { approvals: new ApprovalStore(), authSessions: new AuthSessionStore() };
  const oauthStore = new OAuthStore();
  const app = createHttpApp(ctx.config, () => createMcpServer(ctx.config, store, stores), stores.authSessions, oauthStore);
  httpServer = app.listen(0);
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  store.db.close();
  await ctx.cleanup();
});

describe("experimental OAuth", () => {
  it("serves OAuth metadata endpoints", async () => {
    const resource = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json();
    const server = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(resource.authorization_servers).toContain(baseUrl);
    expect(server.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(server.code_challenge_methods_supported).toContain("S256");
  });

  it("supports dynamic client registration", async () => {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/aip/callback"], client_name: "ChatGPT" }),
    });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.client_id).toMatch(/^vibe_client_/);
  });

  it("shows local approval page and supports approve/reject POST", async () => {
    ctx.config.oauthRequireLocalApproval = true;
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const resource = `${baseUrl}/mcp?note=<script>alert(1)</script>`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/aip/callback",
      code_challenge: pkce(verifier),
      code_challenge_method: "S256",
      state: "local",
      scope: "mcp",
      resource,
    });
    const page = await fetch(`${baseUrl}/authorize?${params}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Vibe Codex");
    expect(html).toContain("Local ChatGPT ↔ Codex pairing");
    expect(html).toContain("ChatGPT wants to connect");
    expect(html).toContain("Approving allows ChatGPT to call Vibe Codex tools on this Mac.");
    expect(html).toContain(clientId);
    expect(html).toContain("chatgpt.com");
    expect(html).toContain("<code>mcp</code>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("1 hour");
    expect(html).toContain(`name="client_id" value="${clientId}"`);
    expect(html).toContain('name="response_type" value="code"');
    expect(html).toContain('name="code_challenge_method" value="S256"');
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="reject"');
    expect(html).not.toContain("test-token");
    expect(html).not.toContain("vibe_url_token_that_should_not_render");
    expect(html).not.toContain("vibe_oauth_");
    expect(html).not.toContain("code_verifier");
    expect(html).not.toContain(verifier);

    const rejected = await fetch(`${baseUrl}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(params), decision: "reject" }) });
    expect(rejected.headers.get("location")).toContain("error=access_denied");

    const approved = await fetch(`${baseUrl}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(params), decision: "approve" }) });
    expect(approved.headers.get("location")).toContain("code=");
  });

  it("rejects invalid redirect_uri", async () => {
    const response = await getCode({ redirectUri: "https://evil.example/callback", expectCode: false });
    expect(response.response.status).toBe(400);
  });

  it("rejects unknown OAuth clients", async () => {
    const response = await getCode({ clientId: "unknown-client", expectCode: false });
    expect(response.response.status).toBe(400);
  });

  it("rejects invalid OAuth scope and empty provided state", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const scoped = new URL(`${baseUrl}/authorize`);
    scoped.searchParams.set("response_type", "code");
    scoped.searchParams.set("client_id", clientId);
    scoped.searchParams.set("redirect_uri", "https://chatgpt.com/aip/callback");
    scoped.searchParams.set("code_challenge", pkce(verifier));
    scoped.searchParams.set("code_challenge_method", "S256");
    scoped.searchParams.set("state", "abc");
    scoped.searchParams.set("scope", "openid");
    scoped.searchParams.set("approve", "1");
    const badScope = await fetch(scoped, { redirect: "manual" });
    expect(badScope.headers.get("location")).toContain("error=invalid_scope");

    scoped.searchParams.set("scope", "mcp");
    scoped.searchParams.set("state", "");
    const emptyState = await fetch(scoped, { redirect: "manual" });
    expect(emptyState.headers.get("location")).toContain("error=invalid_request");
  });

  it("exchanges authorization code with PKCE and calls MCP", async () => {
    const auth = await getCode();
    expect(auth.code).toBeTruthy();
    const tokenResponse = await exchange({ code: auth.code!, verifier: auth.verifier, clientId: auth.clientId });
    const token = await tokenResponse.json();
    expect(tokenResponse.status).toBe(200);
    expect(token.access_token).toMatch(/^vibe_oauth_/);

    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth-test", version: "0" } } }),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    expect(init.status).toBe(200);
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    const health = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "relay_health", arguments: {} } }),
    });
    const payload = parseMcpResponse(await health.text());
    expect(payload.result.structuredContent.status).toMatch(/ok|degraded/);
  });

  it("rejects bad PKCE verifier and reused code", async () => {
    const auth = await getCode();
    expect(auth.code).toBeTruthy();
    const bad = await exchange({ code: auth.code!, verifier: "wrong", clientId: auth.clientId });
    expect(bad.status).toBe(400);
    const good = await exchange({ code: auth.code!, verifier: auth.verifier, clientId: auth.clientId });
    expect(good.status).toBe(200);
    const reused = await exchange({ code: auth.code!, verifier: auth.verifier, clientId: auth.clientId });
    expect(reused.status).toBe(400);
  });

  it("rejects expired code and expired token", async () => {
    ctx.config.oauthAuthCodeTtlSeconds = -1;
    const expired = await getCode();
    expect(expired.code).toBeTruthy();
    const expiredExchange = await exchange({ code: expired.code!, verifier: expired.verifier, clientId: expired.clientId });
    expect(expiredExchange.status).toBe(400);

    ctx.config.oauthAuthCodeTtlSeconds = 300;
    ctx.config.oauthAccessTokenTtlSeconds = -1;
    const auth = await getCode();
    expect(auth.code).toBeTruthy();
    const tokenResponse = await exchange({ code: auth.code!, verifier: auth.verifier, clientId: auth.clientId });
    const token = await tokenResponse.json();
    const mcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "expired", version: "0" } } }),
    });
    expect(mcp.status).toBe(403);
  });

  it("rejects invalid OAuth bearer tokens on MCP", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer vibe_oauth_invalid", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "invalid", version: "0" } } }),
    });
    const text = await response.text();
    expect(response.status).toBe(403);
    expect(text).not.toContain("vibe_oauth_invalid");
  });

  it("rate limits dynamic client registration", async () => {
    let response: Response | undefined;
    for (let i = 0; i < 21; i += 1) {
      response = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/aip/callback"], client_name: `Client ${i}` }),
      });
    }
    expect(response?.status).toBe(429);
  });

  it("revokes OAuth access tokens", async () => {
    const auth = await getCode();
    const tokenResponse = await exchange({ code: auth.code!, verifier: auth.verifier, clientId: auth.clientId });
    const token = await tokenResponse.json();
    const revoked = await fetch(`${baseUrl}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: token.access_token }),
    });
    expect(revoked.status).toBe(200);
    const mcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "revoked", version: "0" } } }),
    });
    expect(mcp.status).toBe(403);
  });
});
