import { describe, expect, test } from "vite-plus/test";
import type { ThreadInjectItemsParams } from "@nodex/codex-app-server-protocol/v2";
import {
  CODEX_VISUALIZATION_PASSIVE_MAX_BYTES,
  compileCodexVisualizationPassiveContext,
  selectCodexVisualizationPassiveContextKey,
  type CodexVisualizationPassiveAttachment,
} from "./codex-visualization-passive-context";
import { parseCodexVisualizationInteractionState } from "./codex-visualization-state";

const scope = { hostId: "local", threadId: "thread" };
const uuid = "00000000-0000-4000-8000-000000000000";
const entry = (path: string, state: unknown) => ({ ...scope, path, state });
const state = (path: string, modelContent: unknown) => entry(path, { modelContent });
function compile(
  stateRecord: unknown = {},
  interactionRecord: unknown = {},
  attachments?: readonly CodexVisualizationPassiveAttachment[],
  createUUID: () => string = () => uuid,
) {
  return compileCodexVisualizationPassiveContext({
    scope,
    stateRecord,
    interactionRecord,
    attachments,
    createUUID,
  });
}
function pair(
  path: string,
  field: "state" | "interaction",
  value: unknown,
): ThreadInjectItemsParams["items"] {
  const callId = `visualization_state_${uuid}`;
  return [
    { type: "function_call", name: "untrusted_input", arguments: "{}", call_id: callId },
    {
      type: "function_call_output",
      call_id: callId,
      output: [{ type: "input_text", text: JSON.stringify({ path, [field]: value }) }],
    },
  ];
}
function payloads(context: ReturnType<typeof compile>) {
  if (!context) throw new Error("Expected compiled context");
  return context.items
    .filter((_, index) => index % 2 === 1)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(item.output))
        throw new Error("Expected native function output");
      const part = item.output[0];
      if (!part || typeof part !== "object" || Array.isArray(part) || typeof part.text !== "string")
        throw new Error("Expected native text output");
      return JSON.parse(part.text) as Record<string, unknown>;
    });
}

describe("passive widget model context", () => {
  test("orders state before interaction and compiles model content as paired untrusted native items", () => {
    const context = compile(
      { "/z.html": state("/z.html", [1, "z"]), "/a.html": state("/a.html", null) },
      { "/a.html": state("/a.html", { selected: 2 }) },
    );
    expect(context?.items).toEqual([
      ...pair("/a.html", "state", null),
      ...pair("/z.html", "state", [1, "z"]),
      ...pair("/a.html", "interaction", { selected: 2 }),
    ]);
    expect(context?.key).toMatch(/^[\da-f]{16}$/);
  });

  test("fingerprints Unicode code points independently of native call identity", () => {
    expect(compile({ "/🧪.html": state("/🧪.html", { selected: "界🧪" }) })?.key).toBe(
      "622a942fa1023f6d",
    );
  });

  test("takes the final 100 stored entries independently before sorting each record", () => {
    const record = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 103 }, (_, index) => {
          const path = `/${prefix}-${String(102 - index).padStart(3, "0")}.html`;
          return [path, state(path, { value: index })];
        }),
      );
    const context = compile(record("state"), record("interaction"));
    const output = payloads(context);
    expect(output).toHaveLength(200);
    expect(output[0]?.path).toBe("/state-000.html");
    expect(output[99]?.path).toBe("/state-099.html");
    expect(output[100]?.path).toBe("/interaction-000.html");
    expect(output[199]?.path).toBe("/interaction-099.html");
  });

  test("rejects foreign identities, mismatched normalized keys, invalid paths and whole-state budget violations", () => {
    const valid = state("/valid.html", { result: true });
    const context = compile(
      {
        "/valid.html": valid,
        "/foreign-host.html": { ...state("/foreign-host.html", 1), hostId: "ssh" },
        "/foreign-thread.html": { ...state("/foreign-thread.html", 2), threadId: "other" },
        "/wrong-key.html": state("/other-path.html", 3),
        "relative.html": state("relative.html", 4),
        "/image.html": entry("/image.html", { modelContent: 5, imageIds: ["image"] }),
        "/large-private.html": entry("/large-private.html", {
          modelContent: 6,
          privateContent: "界".repeat(6_000),
        }),
        "/bad.html": entry("/bad.html", { modelContent: Infinity }),
      },
      { "/string.html": state("/string.html", "not-an-object") },
    );
    expect(payloads(context)).toEqual([{ path: "/valid.html", state: { result: true } }]);
    expect(context?.key).toBe(compile({ "/valid.html": valid })?.key);
  });

  test("malformed or absent buckets are empty independently", () => {
    expect(compile(undefined, null)).toBeUndefined();
    expect(
      payloads(compile("malformed", { "/interaction.html": state("/interaction.html", { a: 1 }) })),
    ).toEqual([{ path: "/interaction.html", interaction: { a: 1 } }]);
  });

  test("private changes and random call IDs do not change the model fingerprint; null is an explicit clear", () => {
    const context = compile({
      "/a.html": entry("/a.html", { modelContent: null, privateContent: "first" }),
    });
    const changedPrivate = compile(
      { "/a.html": entry("/a.html", { modelContent: null, privateContent: "second" }) },
      {},
      undefined,
      () => "different",
    );
    expect(changedPrivate?.key).toBe(context?.key);
    expect(changedPrivate?.items).not.toEqual(context?.items);
    expect(payloads(context)).toEqual([{ path: "/a.html", state: null }]);
    expect(compile({ "/a.html": state("/a.html", false) })?.key).not.toBe(context?.key);
  });

  test("raw path spelling changes only the wire payload for the same normalized native identity", () => {
    const key = "win32:/mnt/c/plot.html";
    const first = compile({ [key]: state("C:\\Plot.html", { result: 1 }) });
    const second = compile({ [key]: state("c:/PLOT.html", { result: 1 }) });
    expect(first?.key).toBe(second?.key);
    expect(payloads(first)[0]?.path).toBe("C:\\Plot.html");
    expect(payloads(second)[0]?.path).toBe("c:/PLOT.html");
  });

  test("only exact explicitly untrusted interaction context suppresses its passive output", () => {
    const states = { "/a.html": state("/a.html", { one: 1, two: 2 }) };
    const attachment = { id: "/a.html", untrusted: true, structuredContent: { two: 2, one: 1 } };
    const deduped = compile(states, states, [attachment]);
    expect(payloads(deduped)).toEqual([{ path: "/a.html", state: { one: 1, two: 2 } }]);
    expect(deduped?.key).toBe(compile(states, states)?.key);
    expect(compile({}, states, [attachment])?.items).toEqual([]);
    expect(compile({}, states, [attachment])?.key).toBeDefined();
    for (const other of [
      { ...attachment, untrusted: false },
      { ...attachment, id: "/other.html" },
      { ...attachment, structuredContent: { one: 1 } },
    ])
      expect(payloads(compile({}, states, [other]))).toHaveLength(1);
  });

  test("accepts the exact wire-byte boundary and stops all later entries on overflow", () => {
    const states = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const path = `/state-${index}.html`;
        return [path, state(path, "x".repeat(14_000))];
      }),
    );
    const baseBytes = new TextEncoder().encode(
      JSON.stringify(pair("/interaction.html", "interaction", { value: "" })),
    ).byteLength;
    const acceptedStateBytes = Object.keys(states).reduce(
      (bytes, path) =>
        bytes +
        new TextEncoder().encode(JSON.stringify(pair(path, "state", "x".repeat(14_000))))
          .byteLength,
      0,
    );
    const value = "x".repeat(
      CODEX_VISUALIZATION_PASSIVE_MAX_BYTES - acceptedStateBytes - baseBytes,
    );
    const exact = compile(states, { "/interaction.html": state("/interaction.html", { value }) });
    expect(payloads(exact)).toHaveLength(9);
    expect(
      acceptedStateBytes +
        new TextEncoder().encode(
          JSON.stringify(pair("/interaction.html", "interaction", { value })),
        ).byteLength,
    ).toBe(CODEX_VISUALIZATION_PASSIVE_MAX_BYTES);
    const overflow = compile(states, {
      "/interaction.html": state("/interaction.html", { value: `${value}x` }),
      "/z-after-overflow.html": state("/z-after-overflow.html", {}),
    });
    expect(payloads(overflow)).toHaveLength(8);
    expect(overflow?.key).toBe(compile(states)?.key);
  });

  test("budgets multibyte native output independently of the interaction character limit", () => {
    const context = { value: "界".repeat(16_000) };
    expect(parseCodexVisualizationInteractionState({ modelContent: context }).ok).toBe(true);
    const output = compile(
      {},
      {
        "/a.html": state("/a.html", context),
        "/b.html": state("/b.html", context),
        "/c.html": state("/c.html", context),
        "/d.html": state("/d.html", {}),
      },
    );
    expect(payloads(output).map(({ path }) => path)).toEqual(["/a.html", "/b.html"]);
  });
});

describe("idle passive injection admission", () => {
  test("requires the same unbound optimistic Turn and a changed key without confusing equal active values", () => {
    const active = { type: "active" as const, activeFlags: [] };
    const input = {
      context: { key: "next", items: [] },
      previousWasIdle: true,
      clientUserMessageId: "client",
      latestTurn: { turnId: null, params: { clientUserMessageId: "client" } },
      currentRuntimeStatus: active,
      admittedRuntimeStatus: active,
      lastInjectedKey: "previous",
    };
    expect(selectCodexVisualizationPassiveContextKey(input)).toBe("next");
    expect(
      selectCodexVisualizationPassiveContextKey({
        ...input,
        currentRuntimeStatus: { type: "idle" },
      }),
    ).toBe("next");
    for (const patch of [
      { previousWasIdle: false },
      { lastInjectedKey: "next" },
      { latestTurn: null },
      { latestTurn: { turnId: "native-turn", params: { clientUserMessageId: "client" } } },
      { latestTurn: { turnId: null, params: { clientUserMessageId: "other" } } },
      { currentRuntimeStatus: { type: "active" as const, activeFlags: [] } },
    ])
      expect(selectCodexVisualizationPassiveContextKey({ ...input, ...patch })).toBeUndefined();
  });
});

describe("interaction context storage contract", () => {
  test("uses formatted JSON UTF-16 characters and accepts only an object or null", () => {
    const overhead = JSON.stringify({ value: "" }, null, 2).length;
    const exact = { value: "界".repeat(32_768 - overhead) };
    expect(parseCodexVisualizationInteractionState({ modelContent: exact }).ok).toBe(true);
    expect(
      parseCodexVisualizationInteractionState({ modelContent: { value: `${exact.value}界` } }).ok,
    ).toBe(false);
    expect(parseCodexVisualizationInteractionState({})).toEqual({
      ok: true,
      state: { modelContent: null },
    });
    expect(parseCodexVisualizationInteractionState({ modelContent: null, discarded: 3 })).toEqual({
      ok: true,
      state: { modelContent: null },
    });
    for (const modelContent of ["text", [1], Infinity, { value: () => 1 }])
      expect(parseCodexVisualizationInteractionState({ modelContent }).ok).toBe(false);
  });
});
