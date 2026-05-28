import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { AutonomyLevel } from "../config/types.js";
import { ProjectRecord, RunRecord, RunStatus } from "./types.js";

export interface RunStore {
  db: Database.Database;
  createProject(args: { name: string; path: string; repoRemote?: string; preferredExecutionMode?: ProjectRecord["preferredExecutionMode"]; defaultCodexThreadId?: string; recentCodexThreadIds?: string[]; notes?: string }): ProjectRecord;
  updateProject(id: string, patch: Partial<Omit<ProjectRecord, "id" | "createdAt">>): ProjectRecord;
  getProject(id: string): ProjectRecord | null;
  getProjectByPath(path: string): ProjectRecord | null;
  getProjectByName(name: string): ProjectRecord | null;
  touchProject(id: string): ProjectRecord;
  listProjects(): ProjectRecord[];
  createRun(args: {
    projectId?: string;
    workspacePath: string;
    status: RunStatus;
    autonomy: AutonomyLevel;
    prompt: string;
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    metadata?: Record<string, unknown>;
  }): RunRecord;
  updateRun(id: string, patch: Partial<Omit<RunRecord, "id" | "createdAt">>): RunRecord;
  getRun(id: string): RunRecord | null;
  listRuns(workspacePath?: string): RunRecord[];
}

function now() {
  return new Date().toISOString();
}

function rowToProject(row: any): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    repoRemote: row.repo_remote ?? undefined,
    preferredExecutionMode: row.preferred_execution_mode ?? undefined,
    defaultCodexThreadId: row.default_codex_thread_id ?? undefined,
    recentCodexThreadIds: row.recent_codex_thread_ids_json ? JSON.parse(row.recent_codex_thread_ids_json) : [],
    lastUsedAt: row.last_used_at ?? row.updated_at,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: any): RunRecord {
  const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  const enrichedMetadata = {
    ...metadata,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.execution_mode ? { executionMode: row.execution_mode } : {}),
    ...(row.codex_thread_id ? { codexThreadId: row.codex_thread_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.prompt_path ? { promptPath: row.prompt_path } : {}),
    ...(row.run_metadata_path ? { metadataPath: row.run_metadata_path } : {}),
    ...(row.baseline_git_status ? { baselineGitStatus: row.baseline_git_status } : {}),
    ...(row.final_git_status ? { finalGitStatus: row.final_git_status } : {}),
    ...(row.changed_files_json ? { changedFilesSinceRun: JSON.parse(row.changed_files_json) } : {}),
    ...(row.new_changed_files_json ? { newChangedFilesSinceRun: JSON.parse(row.new_changed_files_json) } : {}),
  };
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    status: row.status,
    autonomy: row.autonomy,
    prompt: row.prompt,
    codexCommand: row.command ?? "",
    stdout: row.stdout ?? "",
    stderr: row.stderr ?? "",
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: row.summary ?? undefined,
    metadata: Object.keys(enrichedMetadata).length ? enrichedMetadata : undefined,
  };
}

export function initRunStore(databasePath: string): RunStore {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      repo_remote TEXT,
      preferred_execution_mode TEXT,
      default_codex_thread_id TEXT,
      recent_codex_thread_ids_json TEXT,
      last_used_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      autonomy TEXT NOT NULL,
      prompt TEXT NOT NULL,
      stdout TEXT,
      stderr TEXT,
      exit_code INTEGER,
      command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT
    );
  `);
  const projectColumns = new Set(db.prepare("PRAGMA table_info(projects)").all().map((row: any) => row.name));
  for (const [name, type] of [
    ["repo_remote", "TEXT"],
    ["preferred_execution_mode", "TEXT"],
    ["default_codex_thread_id", "TEXT"],
    ["recent_codex_thread_ids_json", "TEXT"],
    ["last_used_at", "TEXT"],
    ["notes", "TEXT"],
  ] as const) {
    if (!projectColumns.has(name)) db.prepare(`ALTER TABLE projects ADD COLUMN ${name} ${type}`).run();
  }
  const runColumns = new Set(db.prepare("PRAGMA table_info(runs)").all().map((row: any) => row.name));
  for (const [name, type] of [
    ["project_id", "TEXT"],
    ["execution_mode", "TEXT"],
    ["codex_thread_id", "TEXT"],
    ["parent_run_id", "TEXT"],
    ["prompt_path", "TEXT"],
    ["run_metadata_path", "TEXT"],
    ["baseline_git_status", "TEXT"],
    ["final_git_status", "TEXT"],
    ["changed_files_json", "TEXT"],
    ["new_changed_files_json", "TEXT"],
    ["summary", "TEXT"],
  ] as const) {
    if (!runColumns.has(name)) db.prepare(`ALTER TABLE runs ADD COLUMN ${name} ${type}`).run();
  }

  return {
    db,
    createProject(args) {
      const timestamp = now();
      const existing = db.prepare("SELECT * FROM projects WHERE path = ?").get(args.path);
      if (existing) {
        const current = rowToProject(existing);
        return this.updateProject(current.id, {
          name: args.name ?? current.name,
          repoRemote: args.repoRemote ?? current.repoRemote,
          preferredExecutionMode: args.preferredExecutionMode ?? current.preferredExecutionMode,
          defaultCodexThreadId: args.defaultCodexThreadId ?? current.defaultCodexThreadId,
          recentCodexThreadIds: args.recentCodexThreadIds ?? current.recentCodexThreadIds,
          notes: args.notes ?? current.notes,
        });
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO projects (id, name, path, repo_remote, preferred_execution_mode, default_codex_thread_id, recent_codex_thread_ids_json, last_used_at, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        args.name,
        args.path,
        args.repoRemote ?? null,
        args.preferredExecutionMode ?? "codex-app-thread",
        args.defaultCodexThreadId ?? null,
        JSON.stringify(args.recentCodexThreadIds ?? []),
        timestamp,
        args.notes ?? null,
        timestamp,
        timestamp,
      );
      return this.getProject(id)!;
    },
    updateProject(id, patch) {
      const current = this.getProject(id);
      if (!current) throw new Error(`Project not found: ${id}`);
      const next = { ...current, ...patch, updatedAt: now() };
      db.prepare(`UPDATE projects SET name = ?, path = ?, repo_remote = ?, preferred_execution_mode = ?, default_codex_thread_id = ?, recent_codex_thread_ids_json = ?, last_used_at = ?, notes = ?, updated_at = ? WHERE id = ?`).run(
        next.name,
        next.path,
        next.repoRemote ?? null,
        next.preferredExecutionMode ?? null,
        next.defaultCodexThreadId ?? null,
        JSON.stringify(next.recentCodexThreadIds ?? []),
        next.lastUsedAt ?? next.updatedAt,
        next.notes ?? null,
        next.updatedAt,
        id,
      );
      return this.getProject(id)!;
    },
    getProject(id) {
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
      return row ? rowToProject(row) : null;
    },
    getProjectByPath(projectPath) {
      const row = db.prepare("SELECT * FROM projects WHERE path = ?").get(projectPath);
      return row ? rowToProject(row) : null;
    },
    getProjectByName(name) {
      const row = db.prepare("SELECT * FROM projects WHERE lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1").get(name);
      return row ? rowToProject(row) : null;
    },
    touchProject(id) {
      const project = this.getProject(id);
      if (!project) throw new Error(`Project not found: ${id}`);
      return this.updateProject(id, { lastUsedAt: now() });
    },
    listProjects() {
      return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all().map(rowToProject);
    },
    createRun(args) {
      const timestamp = now();
      const id = randomUUID();
      const metadata = args.metadata ?? {};
      const changedFiles = metadata.changedFilesSinceRun;
      const newChangedFiles = metadata.newChangedFilesSinceRun;
      db.prepare(`INSERT INTO runs (id, workspace_path, status, autonomy, prompt, stdout, stderr, exit_code, command, created_at, updated_at, metadata_json, project_id, execution_mode, codex_thread_id, parent_run_id, prompt_path, run_metadata_path, baseline_git_status, final_git_status, changed_files_json, new_changed_files_json, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        args.workspacePath,
        args.status,
        args.autonomy,
        args.prompt,
        args.stdout ?? "",
        args.stderr ?? "",
        args.exitCode ?? null,
        args.command,
        timestamp,
        timestamp,
        args.metadata ? JSON.stringify(args.metadata) : null,
        args.projectId ?? metadata.projectId ?? null,
        typeof metadata.executionMode === "string" ? metadata.executionMode : null,
        typeof metadata.codexThreadId === "string" ? metadata.codexThreadId : null,
        typeof metadata.parentRunId === "string" ? metadata.parentRunId : null,
        typeof metadata.promptPath === "string" ? metadata.promptPath : null,
        typeof metadata.metadataPath === "string" ? metadata.metadataPath : null,
        typeof metadata.baselineGitStatus === "string" ? metadata.baselineGitStatus : null,
        typeof metadata.finalGitStatus === "string" ? metadata.finalGitStatus : null,
        Array.isArray(changedFiles) ? JSON.stringify(changedFiles) : null,
        Array.isArray(newChangedFiles) ? JSON.stringify(newChangedFiles) : null,
        typeof metadata.summary === "string" ? metadata.summary : null,
      );
      return this.getRun(id)!;
    },
    updateRun(id, patch) {
      const current = this.getRun(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      const next = { ...current, ...patch, updatedAt: now() };
      const metadata = next.metadata ?? {};
      db.prepare(`UPDATE runs SET workspace_path = ?, status = ?, autonomy = ?, prompt = ?, stdout = ?, stderr = ?, exit_code = ?, command = ?, updated_at = ?, metadata_json = ?, project_id = ?, execution_mode = ?, codex_thread_id = ?, parent_run_id = ?, prompt_path = ?, run_metadata_path = ?, baseline_git_status = ?, final_git_status = ?, changed_files_json = ?, new_changed_files_json = ?, summary = ? WHERE id = ?`).run(
        next.workspacePath,
        next.status,
        next.autonomy,
        next.prompt,
        next.stdout,
        next.stderr,
        next.exitCode,
        next.codexCommand,
        next.updatedAt,
        next.metadata ? JSON.stringify(next.metadata) : null,
        typeof metadata.projectId === "string" ? metadata.projectId : null,
        typeof metadata.executionMode === "string" ? metadata.executionMode : null,
        typeof metadata.codexThreadId === "string" ? metadata.codexThreadId : null,
        typeof metadata.parentRunId === "string" ? metadata.parentRunId : null,
        typeof metadata.promptPath === "string" ? metadata.promptPath : null,
        typeof metadata.metadataPath === "string" ? metadata.metadataPath : null,
        typeof metadata.baselineGitStatus === "string" ? metadata.baselineGitStatus : null,
        typeof metadata.finalGitStatus === "string" ? metadata.finalGitStatus : null,
        Array.isArray(metadata.changedFilesSinceRun) ? JSON.stringify(metadata.changedFilesSinceRun) : null,
        Array.isArray(metadata.newChangedFilesSinceRun) ? JSON.stringify(metadata.newChangedFilesSinceRun) : null,
        next.summary ?? (typeof metadata.summary === "string" ? metadata.summary : null),
        id,
      );
      return this.getRun(id)!;
    },
    getRun(id) {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
      return row ? rowToRun(row) : null;
    },
    listRuns(workspacePath) {
      const rows = workspacePath
        ? db.prepare("SELECT * FROM runs WHERE workspace_path = ? ORDER BY created_at DESC").all(workspacePath)
        : db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all();
      return rows.map(rowToRun);
    },
  };
}
