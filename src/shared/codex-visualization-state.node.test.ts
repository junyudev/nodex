import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_VISUALIZATION_STATE_MAX_BYTES,
  CodexVisualizationStateIdentitySchema,
  codexVisualizationStateAtomKey,
  codexVisualizationStateEntryKey,
  parseCodexVisualizationWidgetState,
} from "./codex-visualization-state";

describe("file widget state contract", () => {
  test("keeps JSON extension fields and defaults separate model/private state", () => {
    expect(
      parseCodexVisualizationWidgetState({ selected: [1, "a", false], nested: { count: 2 } }),
    ).toEqual({
      ok: true,
      state: {
        modelContent: null,
        privateContent: null,
        selected: [1, "a", false],
        nested: { count: 2 },
      },
    });
    expect(
      parseCodexVisualizationWidgetState({
        modelContent: { result: 1 },
        privateContent: { secret: 2 },
        imageIds: [],
      }),
    ).toEqual({
      ok: true,
      state: { modelContent: { result: 1 }, privateContent: { secret: 2 }, imageIds: [] },
    });
  });
  test("budgets the full defaulted UTF-8 JSON at the exact 16KiB boundary", () => {
    const overhead = new TextEncoder().encode(
      JSON.stringify({ modelContent: null, privateContent: null, value: "" }),
    ).byteLength;
    const value = "x".repeat(CODEX_VISUALIZATION_STATE_MAX_BYTES - overhead);
    expect(parseCodexVisualizationWidgetState({ value }).ok).toBe(true);
    expect(parseCodexVisualizationWidgetState({ value: `${value}x` })).toMatchObject({
      ok: false,
      code: "state_too_large",
    });
    expect(parseCodexVisualizationWidgetState({ value: "界".repeat(6_000) })).toMatchObject({
      ok: false,
      code: "state_too_large",
    });
  });
  test("rejects malformed JSON, non-finite values, cycles, and unsupported images", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      null,
      [],
      "state",
      { value: Infinity },
      { value: NaN },
      { value: undefined },
      { value: () => 1 },
      cycle,
    ])
      expect(parseCodexVisualizationWidgetState(value)).toMatchObject({
        ok: false,
        code: "invalid_state",
      });
    expect(parseCodexVisualizationWidgetState({ imageIds: ["image-a"] })).toMatchObject({
      ok: false,
      code: "images_unsupported",
    });
  });
  test("partitions host/Thread while normalizing only the native path identity", () => {
    const identity = { hostId: "local", threadId: "display-thread", path: "/Plot.html" };
    expect(codexVisualizationStateAtomKey(identity)).not.toBe(
      codexVisualizationStateAtomKey({ ...identity, hostId: "ssh" }),
    );
    expect(codexVisualizationStateAtomKey(identity)).not.toBe(
      codexVisualizationStateAtomKey({ ...identity, threadId: "other-thread" }),
    );
    expect(codexVisualizationStateEntryKey(identity)).toBe("/Plot.html");
    expect(codexVisualizationStateEntryKey({ ...identity, path: "/plot.html" })).not.toBe(
      codexVisualizationStateEntryKey(identity),
    );
    expect(codexVisualizationStateEntryKey({ ...identity, path: "C:\\Plot.html" })).toBe(
      "win32:/mnt/c/plot.html",
    );
    expect(codexVisualizationStateEntryKey({ ...identity, path: "\\\\?\\C:\\Plot.html" })).toBe(
      "win32:/mnt/c/plot.html",
    );
    expect(
      codexVisualizationStateEntryKey({ ...identity, path: "\\\\wsl$\\Ubuntu\\home\\Plot.html" }),
    ).toBe("wsl:ubuntu:/home/Plot.html");
    expect(
      codexVisualizationStateEntryKey({
        ...identity,
        path: "\\\\wsl.localhost\\Ubuntu\\mnt\\C\\Plot.html",
      }),
    ).toBe("win32:/mnt/c/plot.html");
    for (const path of ["plot.html", "\0", "\\\\", "//server"])
      expect(CodexVisualizationStateIdentitySchema.safeParse({ ...identity, path }).success).toBe(
        false,
      );
  });
});
