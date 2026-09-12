import { describe, expect, test } from "vite-plus/test";
import { produce } from "immer";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { mutateCanonicalThreadSettingsPatch } from "./codex-thread-settings-update";

const initial = () =>
  createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread([]), {
    hostId: "local",
    model: "first",
    reasoningEffort: "high",
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace"],
  });

describe("partial conversation settings", () => {
  test("preserves explicit null effort and leaves unrelated settings absent", () => {
    const state = initial();
    const next = produce(state, (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, { effort: null }),
    );
    expect(next.latestReasoningEffort).toBeNull();
    expect(next.latestCollaborationMode.settings.reasoning_effort).toBeNull();
    expect(next.latestThreadSettings?.model).toBe(state.latestModel);
    expect(next.latestThreadSettings).not.toHaveProperty("approvalPolicy");
    expect(next.hydrationContext).toBe(state.hydrationContext);
  });
  test("named permissions and sandbox overrides clear the previous profile independently", () => {
    const named = produce(initial(), (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, { permissions: "workspace" }),
    );
    expect(named.latestThreadSettings?.activePermissionProfile).toEqual({
      id: "workspace",
      extends: null,
    });
    const sandbox = produce(named, (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }),
    );
    expect(sandbox.latestThreadSettings?.activePermissionProfile).toBeNull();
    expect(sandbox.latestThreadSettings?.permissions).toBeNull();
    const explicit = produce(sandbox, (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, {
        permissions: "other",
        activePermissionProfile: { id: "explicit", extends: null },
      }),
    );
    expect(explicit.latestThreadSettings?.activePermissionProfile?.id).toBe("explicit");
  });
  test("collaboration settings supply model and effort while explicit scalar values take precedence", () => {
    const state = initial();
    const mode = {
      ...state.latestCollaborationMode,
      settings: {
        ...state.latestCollaborationMode.settings,
        model: "mode",
        reasoning_effort: "low" as const,
      },
    };
    const next = produce(state, (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, {
        collaborationMode: mode,
        model: "scalar",
        effort: null,
        cwd: null,
      }),
    );
    expect(next.latestModel).toBe("scalar");
    expect(next.latestReasoningEffort).toBeNull();
    expect(next.latestCollaborationMode).toEqual(mode);
    expect(next.cwd).toBe(state.cwd);
  });
});

function clientHarness() {
  let state = initial();
  let support: "unknown" | "supported" | "unsupported" = "unknown";
  const calls: string[] = [];
  let send: () => Promise<unknown> = async () => undefined;
  const client: import("./codex-thread-settings-update").CanonicalThreadSettingsClient = {
    getConversation: () => state,
    updateConversation: (_id, recipe) => {
      state = produce(state, recipe);
    },
    getSupport: () => support,
    setSupport: (next) => {
      support = next;
    },
    isUnsupported: (error) => error === "unsupported",
    updateThread: async () => {
      calls.push("thread");
      return send();
    },
    updateTurnReviewer: async () => {
      calls.push("turn");
    },
    supportsTurnReviewer: () => true,
  };
  return {
    client,
    calls,
    read: () => state,
    send: (next: typeof send) => {
      send = next;
    },
  };
}

test("a native settings notification wins the in-flight update and reviewer update follows", async () => {
  const f = clientHarness();
  f.send(async () => {
    f.client.updateConversation("id", (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, { model: "notification" }),
    );
  });
  const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
  expect(
    await updateCanonicalThreadSettings(
      f.client,
      "id",
      { model: "request", approvalsReviewer: "user" },
      undefined,
      "turn",
    ),
  ).toBe(true);
  expect(f.read().latestModel).toBe("notification");
  expect(f.calls).toEqual(["thread", "turn"]);
});

test("condition failure performs neither native request nor local mutation", async () => {
  const f = clientHarness();
  const before = f.read();
  const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
  expect(
    await updateCanonicalThreadSettings(
      f.client,
      "id",
      { model: "request" },
      { ifEffortEquals: "low" },
    ),
  ).toBe(false);
  expect(f.read()).toBe(before);
  expect(f.calls).toEqual([]);
});

test("only unsupported method errors switch future updates to local fallback", async () => {
  const f = clientHarness();
  const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
  f.send(async () => {
    throw new Error("disconnected");
  });
  await expect(updateCanonicalThreadSettings(f.client, "id", { model: "failed" })).rejects.toThrow(
    "disconnected",
  );
  expect(f.client.getSupport()).toBe("unknown");
  f.send(async () => {
    throw "unsupported";
  });
  await updateCanonicalThreadSettings(f.client, "id", { model: "fallback" });
  await updateCanonicalThreadSettings(f.client, "id", { model: "next" });
  expect(f.read().latestModel).toBe("next");
  expect(f.calls).toEqual(["thread", "thread"]);
});
