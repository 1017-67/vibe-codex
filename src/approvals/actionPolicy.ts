import { randomUUID } from "node:crypto";
import { Config } from "../config/types.js";

export type ActionRisk = "read" | "write" | "execute" | "codex-visible" | "codex-hidden" | "dangerous";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface ApprovalRecord {
  id: string;
  status: ApprovalStatus;
  reason: string;
  actionRisk: ActionRisk;
  actionKey: string;
  actionSummary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  rejectionReason?: string;
}

export class ApprovalStore {
  private approvals = new Map<string, ApprovalRecord>();

  create(args: { reason: string; actionRisk: ActionRisk; actionSummary: Record<string, unknown> }): ApprovalRecord {
    const now = new Date().toISOString();
    const record: ApprovalRecord = {
      id: randomUUID(),
      status: "pending",
      reason: args.reason,
      actionRisk: args.actionRisk,
      actionKey: actionKey(args.actionRisk, args.actionSummary),
      actionSummary: args.actionSummary,
      createdAt: now,
      updatedAt: now,
    };
    this.approvals.set(record.id, record);
    return record;
  }

  approve(id: string): ApprovalRecord | null {
    const record = this.approvals.get(id);
    if (!record) return null;
    record.status = "approved";
    record.updatedAt = new Date().toISOString();
    return record;
  }

  reject(id: string, reason?: string): ApprovalRecord | null {
    const record = this.approvals.get(id);
    if (!record) return null;
    record.status = "rejected";
    record.rejectionReason = reason;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  consumeApproved(actionRisk: ActionRisk, actionSummary: Record<string, unknown>): boolean {
    const key = actionKey(actionRisk, actionSummary);
    for (const record of this.approvals.values()) {
      if (record.status === "approved" && record.actionKey === key) {
        record.status = "consumed";
        record.updatedAt = new Date().toISOString();
        return true;
      }
    }
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function actionKey(actionRisk: ActionRisk, actionSummary: Record<string, unknown>): string {
  return `${actionRisk}:${stableStringify(actionSummary)}`;
}

export function approvalRequired(record: ApprovalRecord) {
  return {
    approvalRequired: true,
    approvalId: record.id,
    reason: record.reason,
    actionSummary: record.actionSummary,
  };
}

export function requiresApproval(config: Config, actionRisk: ActionRisk): boolean {
  if (actionRisk === "codex-visible") return config.requireApprovalForCodexVisible;
  if (actionRisk === "codex-hidden") return config.requireApprovalForCodexHidden;
  if (actionRisk === "write") return config.requireApprovalForWriteFile;
  if (actionRisk === "execute") return config.requireApprovalForNormalCommands;
  if (actionRisk === "dangerous") return true;
  return false;
}
