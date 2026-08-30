import { describe, expect, it } from "vitest";

import type { DatabaseViewConditionalColorRule } from "../../shared/database-kernel";
import { reconcileDatabaseConditionalColorDraft } from "./database-conditional-color-sync";

const rule = (ruleId: string, color: DatabaseViewConditionalColorRule["color"]) =>
  ({
    ruleId,
    propertyId: "property-1",
    operator: "is_not_empty",
    color,
    colorSource: "fixed",
  }) satisfies DatabaseViewConditionalColorRule;

describe("conditional-color shared synchronization", () => {
  it("adopts remote shared changes while the editor is clean", () => {
    const previousShared = [rule("rule-1", "blue")];
    const nextShared = [rule("rule-1", "green")];
    expect(
      reconcileDatabaseConditionalColorDraft({
        previousShared,
        nextShared,
        draft: previousShared,
      }),
    ).toBe(nextShared);
  });

  it("keeps a newer local draft through an in-flight canonical handoff", () => {
    const previousShared = [rule("rule-1", "blue")];
    const nextShared = [rule("rule-1", "green")];
    const newerDraft = [rule("rule-1", "purple")];
    expect(
      reconcileDatabaseConditionalColorDraft({
        previousShared,
        nextShared,
        draft: newerDraft,
      }),
    ).toBe(newerDraft);
  });
});
