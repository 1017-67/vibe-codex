import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";

describe("approval store", () => {
  it("approves, consumes once, and rejects missing reuse", () => {
    const store = new ApprovalStore();
    const summary = { tool: "start_codex_task", executionMode: "exec-hidden", workspacePath: "/tmp/repo" };
    const approval = store.create({ reason: "hidden codex", actionRisk: "codex-hidden", actionSummary: summary });
    expect(store.list("pending")).toHaveLength(1);
    expect(store.approve(approval.id)?.status).toBe("approved");
    expect(store.consumeApproved("codex-hidden", summary)).toBe(true);
    expect(store.consumeApproved("codex-hidden", summary)).toBe(false);
  });

  it("records rejection reason", () => {
    const store = new ApprovalStore();
    const approval = store.create({ reason: "write", actionRisk: "write", actionSummary: { tool: "write_file" } });
    const rejected = store.reject(approval.id, "not now");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.rejectionReason).toBe("not now");
  });
});
