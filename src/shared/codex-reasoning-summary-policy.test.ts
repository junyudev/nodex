import { describe, expect, it } from "vite-plus/test";
import {
  parseCodexReasoningSummary,
  resolveCodexReasoningSummary,
} from "./codex-reasoning-summary-policy";

describe("codex reasoning summary policy", () => {
  it("enables detailed summaries by default", () => {
    expect(resolveCodexReasoningSummary()).toBe("detailed");
    expect(resolveCodexReasoningSummary({ configuredSummary: "none" })).toBe("detailed");
  });

  it("preserves a configured mode when the capability is disabled", () => {
    expect(
      resolveCodexReasoningSummary({
        configuredSummary: "concise",
        concurrentReasoningSummaries: false,
      }),
    ).toBe("concise");
  });

  it("lets an explicit per-turn mode win over the feature default", () => {
    expect(resolveCodexReasoningSummary({ explicitSummary: "none" })).toBe("none");
    expect(resolveCodexReasoningSummary({ explicitSummary: "auto" })).toBe("auto");
    expect(resolveCodexReasoningSummary({ explicitSummary: null })).toBeNull();
  });

  it("rejects malformed protocol values at the boundary", () => {
    expect(parseCodexReasoningSummary("detailed")).toBe("detailed");
    expect(parseCodexReasoningSummary(null)).toBeNull();
    expect(parseCodexReasoningSummary("verbose")).toBeUndefined();
    expect(parseCodexReasoningSummary({})).toBeUndefined();
  });

  it("inherits an assigned Turn only when next settings leave summary absent", () => {
    expect(
      resolveCodexReasoningSummary({
        inheritedSummary: "auto",
        concurrentReasoningSummaries: false,
      }),
    ).toBe("auto");
    expect(
      resolveCodexReasoningSummary({
        inheritedSummary: "auto",
        configuredSummary: null,
        concurrentReasoningSummaries: false,
      }),
    ).toBeNull();
    expect(
      resolveCodexReasoningSummary({
        inheritedSummary: "auto",
        configuredSummary: "concise",
        concurrentReasoningSummaries: false,
      }),
    ).toBe("concise");
  });
});
