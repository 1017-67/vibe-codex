import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const uid = process.getuid?.() ?? Number(spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim());
const logDir = path.join(repoRoot, ".vibe-codex", "launchd");

const agents = [
  {
    label: "com.vibecodex.server",
    script: path.join(repoRoot, "scripts", "start-vibe-codex-service.sh"),
    stdout: path.join(logDir, "server.stdout.log"),
    stderr: path.join(logDir, "server.stderr.log"),
  },
  {
    label: "com.vibecodex.ngrok",
    script: path.join(repoRoot, "scripts", "start-vibe-codex-ngrok.sh"),
    stdout: path.join(logDir, "ngrok.stdout.log"),
    stderr: path.join(logDir, "ngrok.stderr.log"),
  },
];

function plistPath(label: string) {
  return path.join(launchAgentsDir, `${label}.plist`);
}

function plistFor(agent: typeof agents[number]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${agent.script}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${agent.stdout}</string>
  <key>StandardErrorPath</key>
  <string>${agent.stderr}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function run(command: string, args: string[], allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function bootout(label: string) {
  run("launchctl", ["bootout", `gui/${uid}`, plistPath(label)], true);
  run("launchctl", ["bootout", `gui/${uid}/${label}`], true);
}

function install() {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  for (const agent of agents) {
    fs.writeFileSync(plistPath(agent.label), plistFor(agent));
    bootout(agent.label);
    run("launchctl", ["bootstrap", `gui/${uid}`, plistPath(agent.label)]);
    run("launchctl", ["enable", `gui/${uid}/${agent.label}`], true);
    run("launchctl", ["kickstart", "-k", `gui/${uid}/${agent.label}`], true);
    console.log(`installed ${agent.label}`);
  }
  console.log(`logs: ${logDir}`);
}

function uninstall() {
  for (const agent of agents) {
    bootout(agent.label);
    try {
      fs.unlinkSync(plistPath(agent.label));
    } catch {
      // Already removed.
    }
    console.log(`removed ${agent.label}`);
  }
}

function status() {
  for (const agent of agents) {
    const result = run("launchctl", ["print", `gui/${uid}/${agent.label}`], true);
    console.log(`\n## ${agent.label}`);
    if (result.status === 0) {
      const useful = result.stdout
        .split("\n")
        .filter((line) => /\b(state|pid|last exit code|program|path|KeepAlive)\b/i.test(line))
        .slice(0, 20)
        .join("\n");
      console.log(useful || result.stdout.slice(0, 1200));
    } else {
      console.log("not loaded");
    }
  }
}

const command = process.argv[2] ?? "install";
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else {
  console.error("Usage: tsx scripts/installLaunchAgents.ts [install|uninstall|status]");
  process.exit(1);
}
