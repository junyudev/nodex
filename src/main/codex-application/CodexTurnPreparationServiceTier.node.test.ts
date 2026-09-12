import { describe, expect, test } from "vitest";
import {
  projectCodexTurnServiceTier,
  resolveNativeTurnExecutionSettings,
} from "./CodexTurnPreparation";

describe("turn service-tier projection", () => {
  test("sends an explicit Standard reset as null", () => {
    expect(projectCodexTurnServiceTier({ serviceTier: null }, "priority")).toEqual({
      serviceTier: null,
    });
  });

  test("inherits a named tier when no override is supplied", () => {
    expect(projectCodexTurnServiceTier(undefined, "priority")).toEqual({
      serviceTier: "priority",
    });
    expect(projectCodexTurnServiceTier({ serviceTier: undefined }, "priority")).toEqual({
      serviceTier: "priority",
    });
  });

  test("retains native sentinel values and explicitly materializes an absent tier as null", () => {
    expect(projectCodexTurnServiceTier(undefined, null)).toEqual({ serviceTier: null });
    expect(projectCodexTurnServiceTier(undefined, "default")).toEqual({ serviceTier: "default" });
    expect(projectCodexTurnServiceTier({ serviceTier: "standard" }, "priority")).toEqual({
      serviceTier: "standard",
    });
  });
});

describe("native turn owner materialization", () => {
  const inherited = { model: "owner-model", effort: "high" as const, collaborationMode: null };
  test("resolves omitted fields from the receiving owner while preserving explicit null effort", () => {
    expect(resolveNativeTurnExecutionSettings({ threadId: "a", input: [] }, inherited)).toEqual(
      inherited,
    );
    expect(
      resolveNativeTurnExecutionSettings(
        { threadId: "a", input: [], model: null, effort: null },
        inherited,
      ),
    ).toEqual({ ...inherited, effort: null });
    expect(
      resolveNativeTurnExecutionSettings(
        { threadId: "a", input: [], model: "  explicit  " },
        inherited,
      ).model,
    ).toBe("explicit");
  });
  test("retains the full explicit collaboration object and suppresses independent model and effort", () => {
    const collaborationMode = {
      mode: "plan" as const,
      settings: {
        model: "plan-model",
        reasoning_effort: "low" as const,
        developer_instructions: "keep this context",
      },
    };
    expect(
      resolveNativeTurnExecutionSettings(
        { threadId: "a", input: [], model: "ignored", effort: "high", collaborationMode },
        inherited,
      ),
    ).toEqual({ model: null, effort: null, collaborationMode });
    expect(
      resolveNativeTurnExecutionSettings(
        { threadId: "a", input: [] },
        { ...inherited, collaborationMode },
      ),
    ).toEqual({ ...inherited, collaborationMode });
  });
});
