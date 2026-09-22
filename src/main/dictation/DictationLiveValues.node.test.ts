import { describe, expect, test } from "vite-plus/test";
import { makeDictationLiveValues } from "./DictationLiveValues";
import { statsigNameHash } from "./DictationPolicyState";

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
      payload({ time: 102, live_entity_names: emptyNames, feature_gates: {}, dynamic_configs: {} }),
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
