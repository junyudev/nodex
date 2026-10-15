import { describe, expect, it } from "vite-plus/test";
import {
  failedWorkspacePreparation,
  projectAgentRuntimeConnection,
} from "./agent-runtime-conversation-adapter";

describe("Runtime chat connection", () => {
  it("reports one shared execution process without inventing per-chat reconnects", () => {
    expect(projectAgentRuntimeConnection({ status: "idle" }).status).toBe("connected");
    expect(projectAgentRuntimeConnection({ status: "ready", generation: "g" }).status).toBe(
      "connected",
    );
    expect(projectAgentRuntimeConnection({ status: "starting" }).status).toBe("starting");
    expect(projectAgentRuntimeConnection({ status: "restarting", attempt: 2 })).toMatchObject({
      status: "disconnected",
      retries: 2,
    });
    expect(
      projectAgentRuntimeConnection({ status: "failed", message: "Execution keeps crashing" }),
    ).toMatchObject({ status: "error", message: "Execution keeps crashing" });
  });

  it("keeps a stable view per state so subscribers do not re-render without a change", () => {
    const failed = { status: "failed", message: "x" } as const;
    expect(projectAgentRuntimeConnection(failed)).toBe(projectAgentRuntimeConnection(failed));
  });
});

describe("Runtime chat workspace preparation", () => {
  const run = (patch: Record<string, unknown>) => ({
    id: "run:1",
    ordinal: 1,
    status: "failed",
    startedAt: null,
    workspacePreparation: { type: "worktree", baseRef: "main" },
    ...patch,
  });

  it("offers recovery only for the latest Run that failed before it started", () => {
    expect(failedWorkspacePreparation([run({})])).toBe("run:1");
    // A Run that started and later failed is an ordinary provider failure.
    expect(failedWorkspacePreparation([run({ startedAt: "2026-10-15T00:00:00Z" })])).toBeNull();
    expect(failedWorkspacePreparation([run({ workspacePreparation: undefined })])).toBeNull();
    // A newer Run supersedes an older preparation failure.
    expect(
      failedWorkspacePreparation([run({}), run({ id: "run:2", ordinal: 2, status: "completed" })]),
    ).toBeNull();
  });
});
