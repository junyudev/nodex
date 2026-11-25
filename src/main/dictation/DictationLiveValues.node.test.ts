import { describe, expect, test, vi } from "vite-plus/test";
import { makeDictationLiveValues } from "./DictationLiveValues";
import { statsigNameHash, resolveDictationPolicy } from "./DictationPolicyState";
import { resolveRealtimeVoiceProductPolicy } from "./RealtimeVoicePolicyState";
import {
  createSystemMicrophonePermissionService,
  type HostMicrophoneAccessStatus,
} from "./system-microphone-permission-service";

describe("DictationLiveValues", () => {
  const gate = "codex-app-dictation-streaming";
  const config = "3845962714";
  const payload = (overrides: Record<string, unknown> = {}) => ({
    has_updates: true,
    response_mode: "live_overlay",
    time: 100,
    live_entity_names: {
      feature_gates: [gate],
      dynamic_configs: [config],
      experiments: [],
    },
    feature_gates: { [gate]: { value: true } },
    dynamic_configs: { [config]: { value: { dictation_custom_dictionary_enabled: true } } },
    ...overrides,
  });
  const emptyNames = { feature_gates: [], dynamic_configs: [], experiments: [] };

  describe("dictation live evaluations", () => {
    test("uses SDK baseline fallbacks until a live entity owns the name", () => {
      const live = makeDictationLiveValues(undefined);
      const baselineConfig = { enabled: true };
      expect(live.intervalMs).toBe(600_000);
      expect(live.requestCursor()).toEqual({});
      expect(live.gate(gate, true)).toBe(true);
      expect(live.config(config, baselineConfig)).toBe(baselineConfig);
      live.advance("500");
      expect(live.requestCursor()).toEqual({});
      expect(live.apply(payload({ feature_gates: {}, dynamic_configs: {} }))).toBe(true);
      expect(live.gate(gate, true)).toBe(false);
      expect(live.config(config, baselineConfig)).toEqual({});
      expect(live.gate("unlisted", true)).toBe(true);
      expect(live.config("unlisted", baselineConfig)).toBe(baselineConfig);
    });

    test.each([undefined, null, 0, -1, "10", Number.NaN, Number.POSITIVE_INFINITY])(
      "defaults an invalid interval %s to ten minutes",
      (seconds) => {
        const live = makeDictationLiveValues({
          sdk_configs: { live_values_auto_refresh_interval_seconds: seconds },
        });
        expect(live.intervalMs).toBe(600_000);
      },
    );

    test("captures a positive interval once, including fractional seconds", () => {
      const live = makeDictationLiveValues(
        payload({ sdk_configs: { live_values_auto_refresh_interval_seconds: 0.25 } }),
      );
      expect(live.intervalMs).toBe(250);
      live.apply(payload({ sdk_configs: { live_values_auto_refresh_interval_seconds: 5 } }));
      expect(live.intervalMs).toBe(250);
    });

    test("seeds values without a cursor unless the caller verifies the full user hash", () => {
      const baseline = payload({ derived_fields: { region: "x" }, full_checksum: "base-checksum" });
      const unverified = makeDictationLiveValues(baseline);
      expect(unverified.gate(gate, false)).toBe(true);
      expect(unverified.requestCursor()).toEqual({});
      unverified.advance("200");
      expect(unverified.requestCursor()).toEqual({});
      expect(unverified.apply(payload({ time: 50, live_entity_names: emptyNames }))).toBe(true);
      expect(unverified.gate(gate, false)).toBe(false);

      const verified = makeDictationLiveValues(baseline, true);
      expect(verified.requestCursor()).toEqual({
        sinceTime: 100,
        previousDerivedFields: { region: "x" },
      });
      expect(verified.apply(payload({ time: 50 }))).toBe(false);
      expect(verified.apply(payload({ time: 100, live_entity_names: emptyNames }))).toBe(true);
      expect(verified.gate(gate, false)).toBe(true);
    });

    test.each([
      null,
      [],
      payload({ has_updates: false }),
      payload({ response_format: "init-v2" }),
      payload({ live_entity_names: undefined }),
    ])("does not seed non-v1 or unusable baseline values", (baseline) => {
      const live = makeDictationLiveValues(baseline, true);
      expect(live.requestCursor()).toEqual({});
      expect(live.gate(gate, false)).toBe(false);
    });

    test("replaces cursor fields and rejects stale or malformed overlays atomically", () => {
      const live = makeDictationLiveValues(undefined);
      expect(
        live.apply(
          payload({ time: 200, derived_fields: { region: "y" }, full_checksum: "live-sum" }),
        ),
      ).toBe(true);
      const cursor = {
        sinceTime: 200,
        previousDerivedFields: { region: "y" },
        full_checksum: "live-sum",
      };
      expect(live.requestCursor()).toEqual(cursor);
      for (const invalid of [
        null,
        [],
        payload({ response_mode: "initialize" }),
        payload({ time: 199 }),
        payload({ time: "300" }),
        payload({ time: -1 }),
        payload({ time: Number.POSITIVE_INFINITY }),
        payload({ time: 300, full_checksum: 123 }),
        payload({ time: 300, live_entity_names: { feature_gates: [1] } }),
        payload({ time: 300, feature_gates: [] }),
      ]) {
        expect(live.apply(invalid)).toBe(false);
        expect(live.requestCursor()).toEqual(cursor);
        expect(live.gate(gate, false)).toBe(true);
      }
      expect(live.apply(payload({ time: 200, derived_fields: null }))).toBe(true);
      expect(live.requestCursor()).toEqual({ sinceTime: 200, previousDerivedFields: null });
    });

    test.each([
      [" 0 ", 0],
      ["-0", -0],
      ["201.5", 201.5],
      ["+201", 201],
      ["201.0", 201],
      ["2e3", 2_000],
      ["0x100", 256],
      ["0b100", 4],
      ["0o100", 64],
      ["9007199254740992", 9_007_199_254_740_992],
    ])("accepts the finite nonnegative Number conversion of header %s", (header, expected) => {
      const live = makeDictationLiveValues(undefined);
      live.apply(payload({ time: 0 }));
      live.advance(header);
      expect(live.requestCursor().sinceTime).toBe(expected);
    });

    test("advances a 204 cursor monotonically and rejects blank, negative and nonfinite headers", () => {
      const live = makeDictationLiveValues(undefined);
      live.apply(payload({ time: 0, derived_fields: { x: 1 }, full_checksum: "sum" }));
      live.advance(" 0 ");
      expect(live.requestCursor().sinceTime).toBe(0);
      live.advance(" 200 ");
      const cursor = { sinceTime: 200, previousDerivedFields: { x: 1 }, full_checksum: "sum" };
      expect(live.requestCursor()).toEqual(cursor);
      for (const header of [
        null,
        "",
        " ",
        "-1",
        "201junk",
        "1_000",
        "NaN",
        "Infinity",
        "1e309",
        "199",
      ])
        live.advance(header);
      expect(live.requestCursor()).toEqual(cursor);
      expect(live.apply(payload({ time: 199, feature_gates: {} }))).toBe(false);
      expect(live.gate(gate, false)).toBe(true);
    });

    test("accepts finite fractional and large payload timestamps without a safe-integer restriction", () => {
      const live = makeDictationLiveValues(payload({ time: 100.25 }), true);
      expect(live.requestCursor().sinceTime).toBe(100.25);
      expect(live.apply(payload({ time: 100.5 }))).toBe(true);
      expect(live.requestCursor().sinceTime).toBe(100.5);
      expect(live.apply(payload({ time: 100.4 }))).toBe(false);
      expect(live.apply(payload({ time: 9_007_199_254_740_992 }))).toBe(true);
      expect(live.requestCursor().sinceTime).toBe(9_007_199_254_740_992);
    });

    test("preserves opaque derived fields and nested configuration values through decoding and retention", () => {
      const derived = { routing: { future: ["x", null, { enabled: false }] } };
      const dictionary = {
        dictation_custom_dictionary_enabled: true,
        future_config: { entries: ["word", { value: 3 }], nullable: null },
      };
      const live = makeDictationLiveValues(
        payload({ derived_fields: derived, dynamic_configs: { [config]: { value: dictionary } } }),
        true,
      );
      expect(live.requestCursor().previousDerivedFields).toEqual(derived);
      expect(live.config(config, {})).toEqual(dictionary);
      live.apply(payload({ time: 101, live_entity_names: emptyNames, derived_fields: [derived] }));
      expect(live.requestCursor().previousDerivedFields).toEqual([derived]);
      expect(live.config(config, {})).toEqual(dictionary);
    });

    test("reads named and hashed entities, including experiments as dynamic configs", () => {
      const live = makeDictationLiveValues(undefined);
      live.apply(
        payload({
          live_entity_names: {
            feature_gates: [statsigNameHash(gate)],
            dynamic_configs: [],
            experiments: [statsigNameHash(config)],
          },
          feature_gates: { [statsigNameHash(gate)]: { value: true } },
          dynamic_configs: { [statsigNameHash(config)]: { value: { live: true } } },
        }),
      );
      expect(live.gate(gate, false)).toBe(true);
      expect(live.config(config, {})).toEqual({ live: true });
      live.apply(
        payload({
          feature_gates: { [gate]: { value: false }, [statsigNameHash(gate)]: { value: true } },
          dynamic_configs: {
            [config]: { value: { named: true } },
            [statsigNameHash(config)]: { value: {} },
          },
        }),
      );
      expect(live.gate(gate, true)).toBe(false);
      expect(live.config(config, {})).toEqual({ named: true });
    });

    test("retains dropped values across overlays and clears them on hashed reentry", () => {
      const live = makeDictationLiveValues(undefined);
      live.apply(payload());
      live.apply(payload({ time: 101, live_entity_names: emptyNames }));
      live.apply(
        payload({
          time: 102,
          live_entity_names: emptyNames,
          feature_gates: {},
          dynamic_configs: {},
        }),
      );
      expect(live.gate(gate, false)).toBe(true);
      expect(live.config(config, {})).toEqual({ dictation_custom_dictionary_enabled: true });
      live.apply(
        payload({
          time: 103,
          live_entity_names: {
            feature_gates: [statsigNameHash(gate)],
            dynamic_configs: [statsigNameHash(config)],
          },
          feature_gates: {},
          dynamic_configs: {},
        }),
      );
      expect(live.gate(gate, true)).toBe(false);
      expect(live.config(config, { base: true })).toEqual({});
      live.apply(payload({ time: 104, live_entity_names: emptyNames }));
      expect(live.gate(gate, true)).toBe(false);
      expect(live.config(config, { base: true })).toEqual({});
    });

    test("retains missing results and respects strict boolean and nullish config defaults", () => {
      const live = makeDictationLiveValues(undefined);
      live.apply(payload({ feature_gates: {}, dynamic_configs: {} }));
      live.apply(payload({ time: 101, live_entity_names: emptyNames }));
      expect(live.gate(gate, true)).toBe(false);
      expect(live.config(config, { base: true })).toEqual({});
      live.apply(
        payload({
          time: 102,
          feature_gates: { [gate]: { value: "true" } },
          dynamic_configs: { [config]: { value: false } },
        }),
      );
      expect(live.gate(gate, true)).toBe(false);
      expect(live.config(config, {})).toBe(false);
    });
  });
});

describe("DictationPolicyState", () => {
  describe("DictationPolicyState", () => {
    const identity = { accountId: "account-a", userId: "user-a", isFedramp: false };

    describe("authenticated dictation policy", () => {
      test("combines the default-host feature, workspace permission and account dictionary gate", () => {
        const input = {
          identity,
          featureEnabled: true,
          plan: "enterprise",
          permissions: null,
          gates: {
            composer: true,
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
        expect(resolveDictationPolicy({ ...input, plan: "plus" })).toMatchObject({
          composer: true,
        });
        expect(resolveDictationPolicy({ ...input, plan: "team" })).toMatchObject({
          composer: true,
        });
        expect(resolveDictationPolicy({ ...input, plan: null })).toMatchObject({ composer: false });
        expect(
          resolveDictationPolicy({ ...input, featureEnabled: false, plan: "plus" }),
        ).toMatchObject({ composer: false, global: false });
      });

      test("admits desktop capture and bundled sounds without secondary rollout assignments", () => {
        for (const assigned of [false, true]) {
          const input = {
            identity,
            featureEnabled: true,
            plan: "plus",
            permissions: null,
            gates: {
              composer: true,
              global: assigned,
              streaming: assigned,
              sounds: assigned,
              voiceDictionary: false,
              workspacePermissions: false,
            },
          };
          expect(resolveDictationPolicy(input)).toMatchObject({
            composer: true,
            global: true,
            streaming: true,
            sounds: true,
          });
          expect(resolveDictationPolicy({ ...input, featureEnabled: false })).toMatchObject({
            composer: false,
            global: false,
            streaming: false,
            sounds: true,
          });
          expect(
            resolveDictationPolicy({
              ...input,
              auth: { method: "apikey", requiresAuth: true, hasToken: false },
            }).streaming,
          ).toBe(false);
        }
      });
    });

    describe("global policy authentication", () => {
      const gates = {
        composer: true,
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
          expect(resolveDictationPolicy({ ...policy, auth, featureEnabled: false }).global).toBe(
            false,
          );
          expect(
            resolveDictationPolicy({ ...policy, auth, gates: { ...gates, composer: false } })
              .global,
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
  });

  describe("RealtimeVoicePolicyState", () => {
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
            workspace: {
              localAccess: true,
              permissions: ["chatgpt.workspace.feature.voice.access"],
            },
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
            workspace: {
              localAccess: false,
              permissions: ["chatgpt.workspace.feature.voice.access"],
            },
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
  });
});

describe("system-microphone-permission-service", () => {
  function createFixture(input: {
    readonly askResult?: boolean | Error;
    readonly platform?: NodeJS.Platform;
    readonly statuses: readonly (HostMicrophoneAccessStatus | Error)[];
  }) {
    let statusIndex = 0;
    const getMediaAccessStatus = vi.fn(() => {
      const value = input.statuses[Math.min(statusIndex, input.statuses.length - 1)];
      statusIndex += 1;
      if (value instanceof Error) throw value;
      if (!value) throw new Error("A fixture microphone status is required");
      return value;
    });
    const askForMediaAccess = vi.fn(async () => {
      if (input.askResult instanceof Error) throw input.askResult;
      return input.askResult ?? true;
    });
    const service = createSystemMicrophonePermissionService({
      platform: input.platform ?? "darwin",
      systemPreferences: { askForMediaAccess, getMediaAccessStatus },
    });
    return { askForMediaAccess, getMediaAccessStatus, service };
  }

  describe("system microphone permission service", () => {
    test("reports unavailable without touching TCC on unsupported platforms", async () => {
      const fixture = createFixture({ platform: "win32", statuses: ["granted"] });

      expect(fixture.service.readStatus()).toBe("unavailable");
      await expect(fixture.service.requestAccess()).resolves.toEqual({
        kind: "unavailable",
        status: "unavailable",
      });
      expect(fixture.getMediaAccessStatus).not.toHaveBeenCalled();
      expect(fixture.askForMediaAccess).not.toHaveBeenCalled();
    });

    test.each(["granted", "denied", "restricted", "unknown"] as const)(
      "does not prompt again from the %s state",
      async (status) => {
        const fixture = createFixture({ statuses: [status] });

        await expect(fixture.service.requestAccess()).resolves.toEqual(
          status === "granted"
            ? { kind: "granted", status: "granted" }
            : status === "unknown"
              ? { kind: "unavailable", status: "unknown" }
              : { kind: "blocked", restartRequired: true, status },
        );
        expect(fixture.askForMediaAccess).not.toHaveBeenCalled();
      },
    );

    test("prompts only from not-determined and trusts the reread status", async () => {
      const fixture = createFixture({
        askResult: false,
        statuses: ["not-determined", "granted"],
      });

      await expect(fixture.service.requestAccess()).resolves.toEqual({
        kind: "granted",
        status: "granted",
      });
      expect(fixture.askForMediaAccess).toHaveBeenCalledOnce();
      expect(fixture.getMediaAccessStatus).toHaveBeenCalledTimes(2);
    });

    test("returns the reread blocked state after a declined prompt", async () => {
      const fixture = createFixture({
        askResult: true,
        statuses: ["not-determined", "denied"],
      });

      await expect(fixture.service.requestAccess()).resolves.toEqual({
        kind: "blocked",
        restartRequired: true,
        status: "denied",
      });
    });

    test("classifies status, prompt, and unresolved failures", async () => {
      const failure = (nativeName: string) => ({
        kind: "failed",
        error: {
          kind: "unknown",
          operation: "permission",
          retryable: true,
          nativeName,
        },
      });
      await expect(
        createFixture({ statuses: [new Error("TCC unavailable")] }).service.requestAccess(),
      ).resolves.toEqual(failure("StatusReadFailed"));
      await expect(
        createFixture({
          askResult: new Error("prompt failed"),
          statuses: ["not-determined"],
        }).service.requestAccess(),
      ).resolves.toEqual(failure("RequestFailed"));
      await expect(
        createFixture({ statuses: ["not-determined", "not-determined"] }).service.requestAccess(),
      ).resolves.toEqual(failure("StatusUnresolved"));
    });

    test("maps a read exception to the stable unknown status", () => {
      const fixture = createFixture({ statuses: [new Error("TCC unavailable")] });
      expect(fixture.service.readStatus()).toBe("unknown");
    });
  });
});
