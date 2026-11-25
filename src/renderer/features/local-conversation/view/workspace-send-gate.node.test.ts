import { describe, expect, test, vi } from "vite-plus/test";
import { workspaceSendGate, type WorkspaceCheck } from "./workspace-send-gate";

const fixes = (canMove = true) => ({
  restore: vi.fn(async () => {}),
  checkAgain: vi.fn(async () => {}),
  workLocally: canMove ? vi.fn(async () => {}) : null,
});
const checked = (availability: Extract<WorkspaceCheck, { status: "checked" }>["availability"]) =>
  ({ status: "checked", availability }) as const;
const idle = { requiresCheck: false, moving: false };
const restorable = (projectCheckout: string | null) =>
  checked({
    state: "restorable",
    repositoryPath: "/repo",
    snapshotRef: "refs/codex/snapshots/one",
    projectCheckout,
  });

describe("workspaceSendGate", () => {
  test("lets a chat send once its working directory is known to be usable", () => {
    expect(workspaceSendGate(checked({ state: "available" }), idle, fixes())).toBeNull();
  });

  test("offers to restore a cleaned-up worktree or to work locally instead", async () => {
    const actions = fixes();
    const gate = workspaceSendGate(restorable("/repo"), idle, actions);
    expect(gate?.notice).toMatchObject({ tone: "warning", title: "Worktree cleaned up" });
    expect(gate?.notice?.actions?.map((action) => action.label)).toEqual([
      "Restore worktree",
      "Work locally",
    ]);
    await gate?.notice?.actions?.[0]?.run();
    expect(actions.restore).toHaveBeenCalledOnce();
    await gate?.notice?.actions?.[1]?.run();
    expect(actions.workLocally).toHaveBeenCalledOnce();
  });

  test("offers working locally only with a Project folder to continue in and a move owner", () => {
    const labels = (gate: ReturnType<typeof workspaceSendGate>) =>
      gate?.notice?.actions?.map((action) => action.label);
    expect(labels(workspaceSendGate(restorable(null), idle, fixes()))).toEqual([
      "Restore worktree",
    ]);
    expect(labels(workspaceSendGate(restorable("/repo"), idle, fixes(false)))).toEqual([
      "Restore worktree",
    ]);
  });

  test("continues a chat whose worktree is gone in its Project folder", async () => {
    const actions = fixes();
    const gate = workspaceSendGate(
      checked({ state: "gone", worktree: true, projectCheckout: "/repo" }),
      idle,
      actions,
    );
    expect(gate?.notice).toMatchObject({
      tone: "danger",
      title: "Working directory missing",
      detail: "This chat’s worktree no longer exists",
    });
    expect(gate?.unsentReason).toBe("This chat’s worktree no longer exists");
    expect(gate?.notice?.actions?.map((action) => action.label)).toEqual(["Work locally"]);
    await gate?.notice?.actions?.[0]?.run();
    expect(actions.workLocally).toHaveBeenCalledOnce();
  });

  test("says a missing Project folder has no fix in the chat", () => {
    const gate = workspaceSendGate(
      checked({ state: "gone", worktree: false, projectCheckout: null }),
      idle,
      fixes(),
    );
    expect(gate?.notice).toMatchObject({
      title: "Working directory missing",
      detail: "This chat’s working directory no longer exists",
    });
    expect(gate?.notice?.actions).toBeUndefined();
  });

  test("shows the move in progress in place of the fixes, still holding sending", () => {
    for (const availability of [
      restorable("/repo").availability,
      { state: "gone", worktree: true, projectCheckout: "/repo" } as const,
    ]) {
      const gate = workspaceSendGate(checked(availability), { ...idle, moving: true }, fixes());
      expect(gate?.notice).toMatchObject({
        tone: "progress",
        title: "Moving to the Project folder…",
      });
      expect(gate?.notice?.actions).toBeUndefined();
      expect(gate?.unsentReason).toBe("This chat is moving to the Project folder");
    }
    // A move that isn't recovering a lost directory leaves a usable chat alone.
    expect(
      workspaceSendGate(checked({ state: "available" }), { ...idle, moving: true }, fixes()),
    ).toBeNull();
  });

  test("offers to check again after an inspection that could not finish", async () => {
    const actions = fixes();
    const gate = workspaceSendGate(
      checked({ state: "unavailable", reason: "inspection-failed", message: "offline" }),
      idle,
      actions,
    );
    expect(gate?.notice?.title).toBe("Couldn’t check worktree status");
    expect(gate?.notice?.actions?.map((action) => action.label)).toEqual(["Retry"]);
    await gate?.notice?.actions?.[0]?.run();
    expect(actions.checkAgain).toHaveBeenCalledOnce();
  });

  test("holds only a chat that needs a checked worktree while the check is unknown", () => {
    const requiring = { ...idle, requiresCheck: true };
    // Quiet while checking: the composer stays, sending waits, nothing is announced.
    expect(workspaceSendGate({ status: "checking" }, requiring, fixes())).toMatchObject({
      notice: null,
    });
    expect(workspaceSendGate({ status: "checking" }, idle, fixes())).toBeNull();
    expect(workspaceSendGate({ status: "failed" }, requiring, fixes())?.notice?.title).toBe(
      "Couldn’t check worktree status",
    );
    expect(workspaceSendGate({ status: "failed" }, idle, fixes())).toBeNull();
  });
});
