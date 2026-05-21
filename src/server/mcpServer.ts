import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "../config/types.js";
import { RunStore } from "../runs/runStore.js";
import { registerTools } from "../tools/registerTools.js";

export function createMcpServer(config: Config, runStore: RunStore): McpServer {
  const server = new McpServer({ name: "vibe-codex", version: "0.1.0" });
  registerTools(server, config, runStore);
  return server;
}
