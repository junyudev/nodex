import { describe, expect, test } from "vite-plus/test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeIntelligence } from "./ClaudeIntelligence";

const model = (id: string): ModelInfo => ({
  value: id,
  displayName: id,
  description: "",
  supportsAdaptiveThinking: true,
});
const resolve = (
  settings: unknown,
  extra: Partial<Parameters<typeof resolveClaudeIntelligence>[0]> = {},
) =>
  resolveClaudeIntelligence({
    settings,
    models: [model("claude-opus-5"), model("claude-sonnet-5-5")],
    customModels: [],
    environment: {},
    acknowledged: {},
    ...extra,
  });

describe("native resolved intelligence", () => {
  test("applied model and effort win over settings while accepted toggles follow the merged cascade", () => {
    expect(
      resolve({
        applied: { model: "claude-opus-5", effort: "medium" },
        effective: {
          model: "ignored",
          effortLevel: "max",
          alwaysThinkingEnabled: false,
          fastMode: true,
        },
      }),
    ).toEqual({ model: "claude-opus-5", effort: "medium", thinking: false, fast: true });
    expect(
      resolve({
        applied: { model: "claude-opus-5", effort: "max" },
        effective: { alwaysThinkingEnabled: false },
      }),
    ).toMatchObject({ effort: "high", thinking: false });
    expect(
      resolve(
        {
          applied: { model: "claude-opus-5", effort: null },
          effective: { alwaysThinkingEnabled: true, fastMode: false },
        },
        { acknowledged: { thinking: false, fast: true } },
      ),
    ).toMatchObject({ effort: null, thinking: true, fast: false });
  });
  test("mandatory thinking ignores an inherited disabled preference and unknown models stay unknown", () => {
    expect(
      resolve({
        applied: { model: "claude-sonnet-5-5", effort: "medium" },
        effective: { alwaysThinkingEnabled: false },
      }),
    ).toMatchObject({ thinking: true });
    expect(
      resolve({
        applied: { model: "claude-opus-5[1m]", effort: "high" },
        effective: { alwaysThinkingEnabled: false },
      }),
    ).toMatchObject({ model: "claude-opus-5[1m]", thinking: false });
    expect(
      resolve({
        applied: { model: "claude-sonnet-5-5[1m]", effort: "medium" },
        effective: { alwaysThinkingEnabled: false },
      }),
    ).toMatchObject({ model: "claude-sonnet-5-5[1m]", thinking: true });
    expect(
      resolve({
        applied: { model: "gateway/opaque", effort: "high" },
        effective: { alwaysThinkingEnabled: false },
      }),
    ).toMatchObject({ model: "gateway/opaque", thinking: null });
    expect(
      resolve(
        {
          applied: { model: "gateway/opaque", effort: "high" },
          effective: { alwaysThinkingEnabled: false },
        },
        {
          customModels: [
            { id: "gateway/opaque", displayName: "Opaque", traits: { disableThinking: true } },
          ],
        },
      ),
    ).toMatchObject({ thinking: false });
  });
  test("native environment priority and live fast state override accepted flag settings", () => {
    const settings = {
      applied: { model: "claude-opus-5", effort: "high" },
      effective: { alwaysThinkingEnabled: false, fastMode: true },
    };
    expect(
      resolve(settings, { environment: { MAX_THINKING_TOKENS: "1000" }, fastState: "off" }),
    ).toMatchObject({ thinking: true, fast: false });
    expect(
      resolve(settings, { environment: { MAX_THINKING_TOKENS: "0" }, fastState: "on" }),
    ).toMatchObject({ thinking: false, fast: true });
    expect(
      resolve(settings, {
        environment: { CLAUDE_CODE_DISABLE_THINKING: "true" },
        fastState: "cooldown",
      }),
    ).toMatchObject({ thinking: null, fast: false });
  });
  test("absent or malformed native fields never fabricate a default model or effort", () => {
    expect(resolve(undefined)).toEqual({ model: null, effort: null, thinking: null, fast: null });
    expect(resolve({ applied: { model: "claude-opus-5", effort: "invented" } })).toEqual({
      model: "claude-opus-5",
      effort: null,
      thinking: true,
      fast: null,
    });
  });
});
