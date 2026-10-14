import type { CodexCanonicalItem } from "../../shared/codex-conversation-state/codex-conversation-state";
import { describe, expect, test } from "vite-plus/test";
import { EMPTY_REALTIME_VOICE_PRODUCT_POLICY } from "../dictation/RealtimeVoicePolicyState";
import {
  DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS,
  resolveRealtimeVoiceStartSettings,
  resolveSupportedRealtimeVoice,
  buildRealtimeVoiceInitialItems,
} from "./CodexRealtimeVoiceConfiguration";

const settings = (config: Record<string, unknown>, sessionConfig: Record<string, unknown> = {}) =>
  resolveRealtimeVoiceStartSettings({
    ...EMPTY_REALTIME_VOICE_PRODUCT_POLICY,
    config,
    sessionConfig,
  });

describe("Realtime Voice native configuration", () => {
  test("keeps the session model/version in its separate configuration and only emits V3 handoff fields for V3", () => {
    expect(settings({ model: "wrong", version: "v3" })).toMatchObject({
      model: "gpt-live-1-boulder-alpha",
      version: "v1",
      includeStartupContext: false,
      flushTranscriptTailOnSessionEnd: true,
    });
    expect(
      settings(
        { codex_response_handoff_mode: "bemTags" },
        { model: "real-session", version: "v3" },
      ),
    ).toMatchObject({ model: "real-session", version: "v3", codexResponseHandoffMode: "bemTags" });
    expect(
      settings({ codex_response_handoff_mode: "bemTags" }, { model: "real-session", version: "v2" })
        .codexResponseHandoffMode,
    ).toBeUndefined();
  });
  test("does not forward invalid session override fields to native startup", () => {
    for (const sessionConfig of [
      { model: "" },
      { model: null },
      { version: "future" },
      { version: null },
    ]) {
      const result = settings({ codex_response_handoff_mode: "bemTags" }, sessionConfig);
      expect(result.model).toBeUndefined();
      expect(result.version).toBeUndefined();
      expect(result.codexResponseHandoffMode).toBeUndefined();
    }
  });
  test("reads a model's prompt override and keeps configuration whitespace while substituting the missing name", () => {
    const config = {
      prompt: " base {{ user_first_name }} ",
      model_overrides: { model: { prompt: " exact {{ user_first_name }} \n" } },
    };
    expect(settings(config, { model: "model", version: "v3" }).prompt).toBe(" exact there \n");
    expect(settings(config, { model: "other" }).prompt).toBe(" base there ");
  });
  test("rejects invalid channel maps as a unit and preserves valid channel values", () => {
    expect(
      settings(
        { codex_response_handoff_channel_prefixes: { commentary: [" X "], analysis: ["Y"] } },
        { version: "v3" },
      ).codexResponseHandoffChannelPrefixes,
    ).toEqual({ commentary: [" X "], analysis: ["Y"] });
    expect(
      settings({ codex_response_handoff_channel_prefixes: {} }, { version: "v3" })
        .codexResponseHandoffChannelPrefixes,
    ).toEqual({});
    for (const prefixes of [{ unknown: ["X"] }, { commentary: [""] }, { commentary: "X" }])
      expect(
        settings({ codex_response_handoff_channel_prefixes: prefixes }, { version: "v3" })
          .codexResponseHandoffChannelPrefixes,
      ).toBeUndefined();
  });
  test("derives a bounded start instruction from the pre-orchestration developer section", () => {
    const developer =
      " Voice coordinator.\nAfter every successful delegation or message sent to another thread, report.\nKeep work responsive.\n## Orchestration\nworker-only instructions";
    const result = settings({
      new_thread_developer_instructions: developer,
    }).realtimeStartInstructions;
    expect(result).toBe(
      "Voice coordinator.\nKeep work responsive.\n\n## Deferred voice-session tools\n\nDuring this voice session, load capture_screen_context and end_realtime_voice_call only when needed. Respect screen-context settings. End only the voice call and only when the user's intent to end it is clear; stopping work, stopping speech, and pausing do not end a call.",
    );
    expect(
      settings({
        realtime_start_instructions: " Explicit ",
        new_thread_developer_instructions: developer,
      }).realtimeStartInstructions,
    ).toBe(" Explicit ");
    expect(
      settings({ new_thread_developer_instructions: "No orchestration" }).realtimeStartInstructions,
    ).toBe(DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS);
    expect(
      settings({ new_thread_developer_instructions: "X".repeat(32768) + "\n## Orchestration" })
        .realtimeStartInstructions,
    ).toBe(DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS);
  });
  test("measures the instruction budget in UTF8 bytes and keeps the exact boundary", () => {
    const exact = "界".repeat(10922) + "ab";
    expect(new TextEncoder().encode(exact).length).toBe(32768);
    expect(settings({ realtime_start_instructions: exact }).realtimeStartInstructions).toBe(exact);
    expect(settings({ realtime_start_instructions: exact + "a" }).realtimeStartInstructions).toBe(
      DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS,
    );
  });
});

test("uses the native supported V1 voice catalog and maps account-only aliases", () => {
  const voices = { v1: ["arbor", "sol", "spruce"] as const, defaultV1: "arbor" as const };
  expect(resolveSupportedRealtimeVoice(voices, "glimmer")).toBe("sol");
  expect(resolveSupportedRealtimeVoice(voices, "orbit")).toBe("spruce");
  expect(resolveSupportedRealtimeVoice(voices, "unsupported")).toBe("arbor");
  expect(resolveSupportedRealtimeVoice({ v1: ["sol"], defaultV1: "arbor" }, null)).toBeNull();
});

const assistant = (text: string): CodexCanonicalItem => ({
  type: "agentMessage",
  id: text,
  text,
  phase: null,
  delivery: null,
  memoryCitation: null,
  questions: null,
});
const user = (text: string): CodexCanonicalItem => ({
  type: "userMessage",
  id: text,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});
test("reads only a configured resident tail, preserves roles and encloses it as existing task context", () => {
  const turns = [
    { items: [user("old"), assistant("old answer")] },
    { items: [user("  current  "), assistant(" answer ")] },
  ];
  expect(buildRealtimeVoiceInitialItems(turns, {}, "v3")).toEqual([]);
  expect(
    buildRealtimeVoiceInitialItems(turns, { realtime_continuity_enabled: true }, "v2"),
  ).toEqual([]);
  const items = buildRealtimeVoiceInitialItems(
    turns,
    { realtime_continuity_enabled: true, realtime_continuity_max_items: 2 },
    "v3",
  );
  expect(items.map((item) => item.role)).toEqual(["developer", "user", "assistant", "developer"]);
  expect(items.slice(1, -1)).toEqual([
    { role: "user", text: "current" },
    { role: "assistant", text: "answer" },
  ]);
  expect(items[0]!.text.startsWith("<recent_background_task_conversation>\n")).toBe(true);
  expect(items.at(-1)!.text.startsWith("</recent_background_task_conversation>\n")).toBe(true);
});
test("bounds recent history by both per-message suffix and the aggregate UTF8 token estimate", () => {
  const turns = [
    { items: Array.from({ length: 20 }, (_, index) => assistant(`${index} ` + "界".repeat(3999))) },
  ];
  const items = buildRealtimeVoiceInitialItems(
    turns,
    {
      realtime_continuity_enabled: true,
      realtime_continuity_max_items: 20,
      realtime_continuity_max_text_length: 4000,
    },
    "v3",
  );
  expect(
    items.reduce(
      (total, item) => total + Math.ceil(new TextEncoder().encode(item.text).byteLength / 4),
      0,
    ),
  ).toBeLessThanOrEqual(8192);
  expect(items.every((item) => !item.text.includes("\uFFFD"))).toBe(true);
  expect(items.some((item) => item.text.includes("…earlier continuity truncated…"))).toBe(true);
  expect(items.at(-2)!.text).toBe(
    turns[0]!.items.at(-1)!.type === "agentMessage"
      ? (
          turns[0]!.items.at(-1)! as Extract<CodexCanonicalItem, { type: "agentMessage" }>
        ).text.slice(-4000)
      : "",
  );
});
