import { describe, expect, test } from "vite-plus/test";
import { resolveRealtimeVoiceProductPolicy } from "./RealtimeVoicePolicyState";

const input = {
  identity: { accountId: "account", userId: "user" },
  authMethod: "chatgpt",
  plan: "plus",
  gates: {
    entryPoint: true,
    blocked: false,
    clientOwnedCall: false,
    config: { existing_thread_voice_enabled: true },
    sessionConfig: {},
  },
  workspace: null,
};

describe("Realtime Voice product admission", () => {
  test("never promotes missing account/auth/plan to available Voice", () => {
    for (const change of [{ identity: null }, { authMethod: "apikey" }, { plan: null }]) {
      const policy = resolveRealtimeVoiceProductPolicy({ ...input, ...change });
      expect(policy.status).toBe("unknown");
      expect(policy.accessAllowed).toBe(false);
      expect(policy.entryPoint).toBe(false);
    }
  });
  test("keeps rollout and blocker distinct from product access", () => {
    expect(resolveRealtimeVoiceProductPolicy(input)).toMatchObject({
      status: "ready",
      accessAllowed: true,
      entryPoint: true,
    });
    for (const gates of [
      { ...input.gates, entryPoint: false },
      { ...input.gates, blocked: true },
    ])
      expect(resolveRealtimeVoiceProductPolicy({ ...input, gates })).toMatchObject({
        status: "ready",
        accessAllowed: true,
        entryPoint: false,
      });
  });
  test("requires the loaded workspace's local and voice permissions without treating missing settings as allowed", () => {
    const enterprise = { ...input, plan: "enterprise" };
    expect(resolveRealtimeVoiceProductPolicy(enterprise).status).toBe("unknown");
    expect(
      resolveRealtimeVoiceProductPolicy({
        ...enterprise,
        workspace: { localAccess: true, permissions: ["chatgpt.workspace.feature.voice.access"] },
      }).accessAllowed,
    ).toBe(true);
    expect(
      resolveRealtimeVoiceProductPolicy({
        ...enterprise,
        workspace: { localAccess: true, permissions: undefined },
      }).accessAllowed,
    ).toBe(true);
    expect(
      resolveRealtimeVoiceProductPolicy({
        ...enterprise,
        workspace: { localAccess: false, permissions: ["chatgpt.workspace.feature.voice.access"] },
      }).accessAllowed,
    ).toBe(false);
    expect(
      resolveRealtimeVoiceProductPolicy({
        ...enterprise,
        workspace: { localAccess: true, permissions: [] },
      }).accessAllowed,
    ).toBe(false);
  });
});
