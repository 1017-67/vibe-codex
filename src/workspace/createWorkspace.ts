import fs from "node:fs/promises";
import path from "node:path";
import { AutonomyLevel, Config } from "../config/types.js";
import { assertSafeWorkspacePath } from "../safety/paths.js";
import { VibeError } from "../util/errors.js";
import { generateAgentsMd } from "./agentsMd.js";
import { gitInit, gitIsRepository } from "./git.js";

export type WorkspaceTemplate = "empty" | "node" | "python" | "vite" | "next" | "chrome-extension";

export function sanitizeWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("~")) {
    throw new VibeError("UNSAFE_WORKSPACE_NAME", "Workspace name must contain only letters, numbers, dot, dash, and underscore.", { name });
  }
  return trimmed;
}

async function writeTemplateFiles(workspacePath: string, template: WorkspaceTemplate, name: string): Promise<string[]> {
  const files: Record<string, string> = {};
  if (template === "node" || template === "vite" || template === "next") {
    files["package.json"] = JSON.stringify({ name, version: "0.1.0", type: "module", scripts: { build: "tsc -p tsconfig.json", dev: "tsx src/index.ts" }, dependencies: {}, devDependencies: {} }, null, 2) + "\n";
    files["src/index.ts"] = "console.log('Hello from Vibe Codex workspace');\n";
    files["README.md"] = `# ${name}\n\nCreated by Vibe Codex.\n`;
  } else if (template === "python") {
    files["README.md"] = `# ${name}\n\nCreated by Vibe Codex.\n`;
    files["src/main.py"] = "def main():\n    print('Hello from Vibe Codex workspace')\n\nif __name__ == '__main__':\n    main()\n";
    files["requirements.txt"] = "";
  } else if (template === "chrome-extension") {
    files["manifest.json"] = JSON.stringify({ manifest_version: 3, name, version: "0.1.0", background: { service_worker: "src/background.js" }, content_scripts: [{ matches: ["<all_urls>"], js: ["src/content.js"] }] }, null, 2) + "\n";
    files["src/content.js"] = "console.log('Vibe Codex extension content script loaded');\n";
    files["src/background.js"] = "console.log('Vibe Codex extension background loaded');\n";
    files["README.md"] = `# ${name}\n\nChrome extension prototype created by Vibe Codex.\n`;
  }

  const created: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspacePath, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    created.push(relative);
  }
  return created;
}

export async function createWorkspace(args: {
  name: string;
  parentDir?: string;
  template?: WorkspaceTemplate;
  initGit?: boolean;
  createAgentsMd?: boolean;
  autonomy: AutonomyLevel;
  userNotes?: string;
  config: Config;
}) {
  const name = sanitizeWorkspaceName(args.name);
  const parent = await assertSafeWorkspacePath(args.parentDir ?? args.config.defaultParentDir, args.config);
  const workspacePath = await assertSafeWorkspacePath(path.join(parent, name), args.config);
  await fs.mkdir(workspacePath, { recursive: false });
  const createdFiles = await writeTemplateFiles(workspacePath, args.template ?? "empty", name);

  if (args.createAgentsMd) {
    await fs.writeFile(path.join(workspacePath, "AGENTS.md"), generateAgentsMd({ projectName: name, autonomy: args.autonomy, userNotes: args.userNotes }), "utf8");
    createdFiles.push("AGENTS.md");
  }

  let gitInitialized = false;
  if (args.initGit) {
    const result = await gitInit(workspacePath, args.config);
    gitInitialized = result.exitCode === 0 && await gitIsRepository(workspacePath, args.config);
    if (!gitInitialized) {
      throw new VibeError("CODEX_EXEC_FAILED", "git init did not produce a usable Git repository.", { workspacePath, stderr: result.stderr });
    }
  }

  return { workspacePath, createdFiles, gitInitialized };
}
