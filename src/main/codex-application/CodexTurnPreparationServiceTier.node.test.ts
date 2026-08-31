import { describe, expect, test } from "vitest";
import { projectCodexTurnServiceTier } from "./CodexTurnPreparation";

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

  test("omits Standard aliases when they are only inherited", () => {
    expect(projectCodexTurnServiceTier(undefined, null)).toEqual({});
    expect(projectCodexTurnServiceTier(undefined, "default")).toEqual({});
  });
});
