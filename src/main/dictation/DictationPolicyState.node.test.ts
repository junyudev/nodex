import { describe, expect, test } from "vite-plus/test";
import { resolveDictationPolicy } from "./DictationPolicyState";

const identity = { accountId: "account-a", userId: "user-a", isFedramp: false };

describe("authenticated dictation policy", () => {
  test("combines the default-host feature, workspace permission and child gates", () => {
    const input = {
      identity,
      featureEnabled: true,
      plan: "enterprise",
      permissions: null,
      gates: {
        composer: true,
        global: true,
        streaming: true,
        sounds: true,
        voiceDictionary: true,
        workspacePermissions: true,
      },
    };
    expect(resolveDictationPolicy(input)).toMatchObject({
      composer: false,
      global: false,
      streaming: false,
      voiceDictionary: false,
      sounds: true,
    });
    expect(
      resolveDictationPolicy({
        ...input,
        permissions: ["chatgpt.workspace.feature.dictation.access"],
      }),
    ).toMatchObject({ composer: true, global: true, streaming: true, voiceDictionary: true });
    expect(resolveDictationPolicy({ ...input, plan: "plus" })).toMatchObject({ composer: true });
    expect(resolveDictationPolicy({ ...input, plan: "team" })).toMatchObject({ composer: true });
    expect(resolveDictationPolicy({ ...input, plan: null })).toMatchObject({ composer: false });
    expect(resolveDictationPolicy({ ...input, featureEnabled: false, plan: "plus" })).toMatchObject(
      { composer: false, global: false },
    );
    expect(
      resolveDictationPolicy({ ...input, plan: "plus", gates: { ...input.gates, global: false } }),
    ).toMatchObject({ composer: true, global: false });
  });
});

describe("global policy authentication", () => {
  const gates = {
    composer: true,
    global: true,
    streaming: true,
    sounds: true,
    voiceDictionary: true,
    workspacePermissions: true,
  };
  const policy = { identity: null, gates, featureEnabled: true, plan: null, permissions: null };
  test("keeps independent auth, configuration and gate requirements", () => {
    for (const auth of [
      { method: "apikey", requiresAuth: true, hasToken: false },
      { method: null, requiresAuth: false, hasToken: false },
    ]) {
      const result = resolveDictationPolicy({ ...policy, auth });
      expect(result.global).toBe(true);
      expect(result.composer).toBe(false);
      expect(result.voiceDictionary).toBe(false);
      expect(resolveDictationPolicy({ ...policy, auth, featureEnabled: false }).global).toBe(false);
      for (const key of ["composer", "global"] as const)
        expect(
          resolveDictationPolicy({ ...policy, auth, gates: { ...gates, [key]: false } }).global,
        ).toBe(false);
    }
    expect(
      resolveDictationPolicy({
        ...policy,
        auth: { method: null, requiresAuth: true, hasToken: false },
      }).global,
    ).toBe(false);
    expect(
      resolveDictationPolicy({
        ...policy,
        plan: "pro",
        auth: { method: "chatgpt", requiresAuth: true, hasToken: false },
      }).global,
    ).toBe(false);
  });
});
