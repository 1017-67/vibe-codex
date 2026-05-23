import { loadConfig } from "./config/loadConfig.js";
import { initRunStore } from "./runs/runStore.js";
import { createMcpServer } from "./server/mcpServer.js";
import { createHttpApp, listen } from "./server/http.js";
import { logger } from "./util/logger.js";
import { ApprovalStore } from "./approvals/actionPolicy.js";
import { AuthSessionStore } from "./server/authSessions.js";

async function main() {
  const config = loadConfig();
  const runStore = initRunStore(config.databasePath);
  const stores = { approvals: new ApprovalStore(), authSessions: new AuthSessionStore() };
  const app = createHttpApp(config, () => createMcpServer(config, runStore, stores), stores.authSessions);
  const httpServer = listen(config, app);

  process.on("SIGINT", async () => {
    logger.info("shutting_down");
    httpServer.close();
    runStore.db.close();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("startup_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
