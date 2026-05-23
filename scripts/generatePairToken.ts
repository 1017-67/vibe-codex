import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const token = `vibe_${randomBytes(32).toString("hex")}`;
const writeEnv = process.argv.includes("--write-env");
const envPath = path.resolve(process.cwd(), ".env");

const lines = [
  "ALLOW_URL_TOKEN_AUTH=true",
  `URL_TOKEN=${token}`,
  "URL_TOKEN_REQUIRED_PREFIX=vibe_",
  "URL_TOKEN_MIN_LENGTH=32",
];

function upsertEnv(existing: string, updates: string[]): string {
  const map = new Map(updates.map((line) => [line.split("=")[0], line]));
  const output = existing.split(/\r?\n/).map((line) => {
    const key = line.includes("=") ? line.split("=")[0] : "";
    return map.has(key) ? map.get(key)! : line;
  });
  for (const [key, line] of map) {
    if (!output.some((existingLine) => existingLine.startsWith(`${key}=`))) output.push(line);
  }
  return `${output.filter((line, index, arr) => line !== "" || index < arr.length - 1).join("\n")}\n`;
}

if (writeEnv) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  fs.writeFileSync(envPath, upsertEnv(existing, lines), "utf8");
}

console.log(`Token:\n${token}\n`);
console.log("Example .env lines:");
console.log(lines.join("\n"));
console.log("\nChatGPT Developer Mode MCP URL:");
console.log(`https://<ngrok-url>/mcp/${token}`);
if (writeEnv) console.log(`\nUpdated ${envPath}`);
