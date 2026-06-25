import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { loadConfig } from "../src/config/loadConfig.js";

function b64url(input: Buffer) {
  return input.toString("base64url");
}

function parseMcpResponse(text: string): any {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

type SimpleResponse = {
  status: number;
  ok: boolean;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

function curlFetch(url: string, init?: RequestInit): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const method = init?.method ?? "GET";
    const args = ["-sS", "-i", "-X", method];
    const headers = init?.headers as Record<string, string> | undefined;
    for (const [name, value] of Object.entries(headers ?? {})) args.push("-H", `${name}: ${value}`);
    let body = "";
    if (init?.body != null) {
      body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
      args.push("--data-binary", "@-");
    }
    args.push(url);

    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`curl exited with ${code}: ${err}`));
        return;
      }
      const raw = Buffer.concat(stdout).toString("utf8");
      const separator = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
      const parts = raw.split(separator);
      const headerText = parts.shift() ?? "";
      const responseBody = parts.join(separator);
      const headerLines = headerText.split(/\r?\n/);
      const status = Number(headerLines[0]?.match(/HTTP\/\S+\s+(\d+)/)?.[1] ?? 0);
      const headerMap = new Map<string, string>();
      for (const line of headerLines.slice(1)) {
        const index = line.indexOf(":");
        if (index === -1) continue;
        headerMap.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
      }
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
        text: async () => responseBody,
        json: async () => JSON.parse(responseBody),
      });
    });
    child.stdin.end(body);
  });
}

async function fetchWithRetry(url: string, init?: RequestInit, attempts = 3): Promise<SimpleResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await curlFetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

async function expectOk(response: SimpleResponse, label: string) {
  if (response.ok || [302, 303].includes(response.status)) return;
  const text = await response.text();
  const ngrokOffline = text.includes("ERR_NGROK_3200") || text.includes("endpoint") && text.includes("is offline");
  const body = ngrokOffline ? "ngrok endpoint is offline" : text.slice(0, 500);
  throw new Error(`${label} failed: HTTP ${response.status} ${body}`);
}

const config = loadConfig({ ...process.env, VIBE_CODEX_DEV: process.env.VIBE_CODEX_DEV ?? "true" });
const baseUrl = config.publicBaseUrl?.replace(/\/+$/, "");
if (!baseUrl) throw new Error("PUBLIC_BASE_URL is required for npm run verify:public.");
if (!config.enableExperimentalOAuth) throw new Error("ENABLE_EXPERIMENTAL_OAUTH=true is required for npm run verify:public.");

const redirectUri = "https://chatgpt.com/connector/oauth/vibe-codex-public-smoke";
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = `vibe_smoke_${randomBytes(12).toString("hex")}`;

const protectedResourceResponse = await fetchWithRetry(`${baseUrl}/.well-known/oauth-protected-resource`);
await expectOk(protectedResourceResponse, "oauth protected resource metadata");
const protectedResource = await protectedResourceResponse.json() as any;
if (protectedResource.resource !== `${baseUrl}/mcp`) throw new Error(`Unexpected OAuth resource: ${protectedResource.resource}`);

const authServerResponse = await fetchWithRetry(`${baseUrl}/.well-known/oauth-authorization-server`);
await expectOk(authServerResponse, "oauth authorization server metadata");
const authServer = await authServerResponse.json() as any;
if (authServer.authorization_endpoint !== `${baseUrl}/authorize`) throw new Error("Unexpected OAuth authorization endpoint.");
if (authServer.token_endpoint !== `${baseUrl}/token`) throw new Error("Unexpected OAuth token endpoint.");
if (!authServer.scopes_supported?.includes("mcp")) throw new Error("OAuth metadata does not advertise mcp scope.");

const registerResponse = await fetchWithRetry(`${baseUrl}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Vibe Codex public smoke" }),
});
await expectOk(registerResponse, "oauth client registration");
const registered = await registerResponse.json() as { client_id: string };

const authParams = new URLSearchParams({
  response_type: "code",
  client_id: registered.client_id,
  redirect_uri: redirectUri,
  scope: "mcp",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: `${baseUrl}/mcp`,
  state,
});
const authorizeResponse = await fetchWithRetry(`${baseUrl}/authorize`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...Object.fromEntries(authParams), decision: "approve" }),
});
await expectOk(authorizeResponse, "oauth authorize");
const location = authorizeResponse.headers.get("location");
if (!location) throw new Error("OAuth authorize response did not include a redirect location.");
const callback = new URL(location);
if (callback.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
const code = callback.searchParams.get("code");
if (!code) throw new Error("OAuth authorize response did not include code.");

const tokenResponse = await fetchWithRetry(`${baseUrl}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
  }),
});
await expectOk(tokenResponse, "oauth token");
const token = await tokenResponse.json() as { access_token: string; token_type: string; scope?: string };
if (token.token_type !== "Bearer" || !token.access_token) throw new Error("OAuth token response was malformed.");

const mcpHeaders = {
  authorization: `Bearer ${token.access_token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const initResponse = await fetchWithRetry(`${baseUrl}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vibe-public-smoke", version: "0" } },
  }),
});
await expectOk(initResponse, "mcp initialize");
const sessionId = initResponse.headers.get("mcp-session-id");
if (!sessionId) throw new Error("MCP initialize did not return mcp-session-id.");
await fetchWithRetry(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { ...mcpHeaders, "mcp-session-id": sessionId },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
}).then((response) => response.text());

async function mcpCall(id: number, method: string, params: Record<string, unknown>) {
  const response = await fetchWithRetry(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...mcpHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  await expectOk(response, method);
  return parseMcpResponse(await response.text());
}

const tools = await mcpCall(2, "tools/list", {});
const toolNames = new Set<string>(tools.result.tools.map((tool: any) => tool.name));
for (const name of ["relay_health", "connector_setup_status", "register_project", "send_codex_app_thread_message", "start_project_task"]) {
  if (!toolNames.has(name)) throw new Error(`Missing public OAuth tool: ${name}`);
}

const resources = await mcpCall(3, "resources/list", {});
const resourceUris = new Set<string>(resources.result.resources.map((resource: any) => resource.uri));
for (const uri of ["vibe://status", "vibe://operator-guide", "vibe://feature-matrix", "vibe://setup"]) {
  if (!resourceUris.has(uri)) throw new Error(`Missing public OAuth resource: ${uri}`);
}

const health = await mcpCall(4, "tools/call", { name: "relay_health", arguments: {} });
if (!["ok", "degraded"].includes(health.result.structuredContent.status)) throw new Error("relay_health returned unexpected status.");

const setupStatus = await mcpCall(5, "tools/call", { name: "connector_setup_status", arguments: {} });
if (setupStatus.result.structuredContent.chatGptDeveloperMode.authentication !== "OAuth") throw new Error("connector_setup_status did not report OAuth mode.");

const projectPath = path.resolve(process.env.VERIFY_PROJECT_PATH ?? process.cwd());
const registeredProject = await mcpCall(6, "tools/call", {
  name: "register_project",
  arguments: { name: "vibe-codex-public-smoke", workspacePath: projectPath, preferredExecutionMode: "codex-app-thread" },
});
if (registeredProject.result.isError) throw new Error(`register_project returned MCP error: ${JSON.stringify(registeredProject.result.structuredContent)}`);
if (registeredProject.result.structuredContent.createdWorkspace !== false) throw new Error("Public register_project did not reuse the existing workspace.");

const appServerStatus = await mcpCall(7, "tools/call", { name: "get_codex_app_server_status", arguments: {} });
if (typeof appServerStatus.result.structuredContent.available !== "boolean") throw new Error("get_codex_app_server_status returned malformed content.");

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  tools: toolNames.size,
  resources: resourceUris.size,
  relayHealth: health.result.structuredContent.status,
  codexAppServerAvailable: appServerStatus.result.structuredContent.available,
  projectPath,
}, null, 2));
