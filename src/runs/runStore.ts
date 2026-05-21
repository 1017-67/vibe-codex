import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { AutonomyLevel } from "../config/types.js";
import { ProjectRecord, RunRecord, RunStatus } from "./types.js";

export interface RunStore {
  db: Database.Database;
  createProject(args: { name: string; path: string }): ProjectRecord;
  listProjects(): ProjectRecord[];
  createRun(args: {
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
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at, updatedAt: row.updated_at };
}

function rowToRun(row: any): RunRecord {
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
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
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

  return {
    db,
    createProject(args) {
      const timestamp = now();
      const existing = db.prepare("SELECT * FROM projects WHERE path = ?").get(args.path);
      if (existing) return rowToProject(existing);
      const id = randomUUID();
      db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, args.name, args.path, timestamp, timestamp);
      return { id, name: args.name, path: args.path, createdAt: timestamp, updatedAt: timestamp };
    },
    listProjects() {
      return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all().map(rowToProject);
    },
    createRun(args) {
      const timestamp = now();
      const id = randomUUID();
      db.prepare(`INSERT INTO runs (id, workspace_path, status, autonomy, prompt, stdout, stderr, exit_code, command, created_at, updated_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
      );
      return this.getRun(id)!;
    },
    updateRun(id, patch) {
      const current = this.getRun(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      const next = { ...current, ...patch, updatedAt: now() };
      db.prepare(`UPDATE runs SET workspace_path = ?, status = ?, autonomy = ?, prompt = ?, stdout = ?, stderr = ?, exit_code = ?, command = ?, updated_at = ?, metadata_json = ? WHERE id = ?`).run(
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
