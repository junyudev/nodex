import { describe, expect, it, vi } from "vite-plus/test";
import { NewThreadBackendSelectionOwner } from "./new-thread-backend-selection";

describe("NewThreadBackendSelectionOwner", () => {
  it("keeps a Session's page and composer dock on one backend choice", () => {
    const owner = new NewThreadBackendSelectionOwner();
    const page = vi.fn();
    const dock = vi.fn();
    owner.subscribe("session-1", page);
    owner.subscribe("session-1", dock);

    owner.write("session-1", { acpInstanceId: "claude-local" });

    expect(owner.read("session-1")).toEqual({ acpInstanceId: "claude-local" });
    expect(page).toHaveBeenCalledOnce();
    expect(dock).toHaveBeenCalledOnce();
    expect(owner.read("session-2")).toBe("codex");
  });
});
