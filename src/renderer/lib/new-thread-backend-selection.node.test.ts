import { describe, expect, it, vi } from "vite-plus/test";
import { NewThreadBackendSelectionOwner } from "./new-thread-backend-selection";

describe("NewThreadBackendSelectionOwner", () => {
  it("keeps a Session's page and composer dock on one backend choice", () => {
    const owner = new NewThreadBackendSelectionOwner();
    const page = vi.fn();
    const dock = vi.fn();
    owner.subscribe("session-1", page);
    owner.subscribe("session-1", dock);

    owner.write("session-1", {
      kind: "acp",
      agentDefinitionId: "claude-agent-acp",
      instanceConfigId: "claude-local",
    });

    expect(owner.read("session-1")).toEqual({
      kind: "acp",
      agentDefinitionId: "claude-agent-acp",
      instanceConfigId: "claude-local",
    });
    expect(page).toHaveBeenCalledOnce();
    expect(dock).toHaveBeenCalledOnce();
    expect(owner.read("session-2")).toBe("codex");
  });
});

describe("draft runtime availability", () => {
  it("keeps a disabled or removed profile's exact model choice and distinguishes runtime identity", async () => {
    const { resolveNewThreadBackendUnavailableReason } =
      await import("./new-thread-backend-selection");
    const { NativeAgentDraftOwner, nativeAgentDraftKey } =
      await import("./native-agent-draft-owner");
    const binding = { kind: "opencode", instanceConfigId: "shared" } as const;
    const owner = new NewThreadBackendSelectionOwner();
    const drafts = new NativeAgentDraftOwner();
    const key = nativeAgentDraftKey("session", "project", binding);
    owner.write("session", binding);
    drafts.write(key, { selection: { model: "moonshot/kimi-k3", effort: "default" } });
    const settings = {
      loading: false,
      error: null,
      instances: [
        { binding, enabled: false },
        { binding: { kind: "claude", instanceConfigId: "shared" } as const, enabled: true },
      ],
    };
    expect(resolveNewThreadBackendUnavailableReason(owner.read("session"), settings)).toBe(
      "This Agent profile is disabled.",
    );
    expect(
      resolveNewThreadBackendUnavailableReason(owner.read("session"), {
        ...settings,
        instances: [],
      }),
    ).toBe("This Agent profile is no longer configured.");
    expect(owner.read("session")).toEqual(binding);
    expect(drafts.read(key).selection.model).toBe("moonshot/kimi-k3");
    expect(
      resolveNewThreadBackendUnavailableReason(owner.read("session"), {
        ...settings,
        instances: [{ binding, enabled: true }],
      }),
    ).toBeNull();
  });
  it("distinguishes unresolved settings from a removed profile without replacing Codex", async () => {
    const { resolveNewThreadBackendUnavailableReason } =
      await import("./new-thread-backend-selection");
    const binding = { kind: "opencode", instanceConfigId: "local" } as const;
    const loading = { instances: [], loading: true, error: null };
    expect(resolveNewThreadBackendUnavailableReason(binding, loading)).toBe(
      "Wait for Agent profiles to finish loading.",
    );
    const failed = { ...loading, loading: false, error: "Could not load Agent profiles" };
    expect(resolveNewThreadBackendUnavailableReason(binding, failed)).toBe(failed.error);
    expect(resolveNewThreadBackendUnavailableReason("codex", failed)).toBeNull();
  });
});
