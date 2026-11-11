import { describe, expect, test, vi } from "vite-plus/test";
import { managedWorktreeSendGate, type ManagedWorktreeCheck } from "./managed-worktree-send-gate";

const fixes = () => ({ restore: vi.fn(async () => {}), checkAgain: vi.fn(async () => {}) });
const checked = (
  availability: Extract<ManagedWorktreeCheck, { status: "checked" }>["availability"],
) => ({ status: "checked", availability }) as const;

describe("managedWorktreeSendGate", () => {
  test("lets a chat send once its worktree is known to be usable", () => {
    expect(managedWorktreeSendGate(checked({ state: "available" }), true, fixes())).toBeNull();
    // The chat is treated as managed while its inspection says otherwise: nothing to fix.
    expect(managedWorktreeSendGate(checked({ state: "not-managed" }), true, fixes())).toBeNull();
  });

  test("offers to restore a cleaned-up worktree", async () => {
    const actions = fixes();
    const gate = managedWorktreeSendGate(
      checked({ state: "restorable", repositoryPath: "/repo", snapshotRef: "refs/snapshots/one" }),
      false,
      actions,
    );
    expect(gate?.notice).toMatchObject({ tone: "warning", title: "Worktree cleaned up" });
    expect(gate?.notice?.actions?.map((action) => action.label)).toEqual(["Restore worktree"]);
    await gate?.notice?.actions?.[0]?.run();
    expect(actions.restore).toHaveBeenCalledOnce();
  });

  test("says a missing working directory has no fix", () => {
    const gate = managedWorktreeSendGate(checked({ state: "gone" }), false, fixes());
    expect(gate?.notice).toMatchObject({ tone: "danger", title: "Working directory missing" });
    expect(gate?.notice?.actions).toBeUndefined();
  });

  test("offers to check again after an inspection that could not finish", async () => {
    const actions = fixes();
    const gate = managedWorktreeSendGate(
      checked({ state: "unavailable", reason: "inspection-failed", message: "offline" }),
      false,
      actions,
    );
    expect(gate?.notice?.title).toBe("Couldn’t check worktree status");
    await gate?.notice?.actions?.[0]?.run();
    expect(actions.checkAgain).toHaveBeenCalledOnce();
  });

  test("holds only a chat that needs a checked worktree while the check is unknown", () => {
    // Quiet while checking: the composer stays, sending waits, nothing is announced.
    expect(managedWorktreeSendGate({ status: "checking" }, true, fixes())).toMatchObject({
      notice: null,
    });
    expect(managedWorktreeSendGate({ status: "checking" }, false, fixes())).toBeNull();
    expect(managedWorktreeSendGate({ status: "failed" }, true, fixes())?.notice?.title).toBe(
      "Couldn’t check worktree status",
    );
    expect(managedWorktreeSendGate({ status: "failed" }, false, fixes())).toBeNull();
  });
});
