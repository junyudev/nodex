import { describe, expect, test } from "bun:test";
import { shouldPublishCardStagePatch } from "./card-stage-draft-sync";

describe("card stage draft sync", () => {
  test("keeps freeform text drafts local to the stage", () => {
    expect(shouldPublishCardStagePatch({ title: "Next title" })).toBeFalse();
    expect(shouldPublishCardStagePatch({ description: "Next description" })).toBeFalse();
    expect(shouldPublishCardStagePatch({ assignee: "alex" })).toBeFalse();
    expect(shouldPublishCardStagePatch({ agentStatus: "waiting" })).toBeFalse();
    expect(shouldPublishCardStagePatch({
      title: "Next title",
      description: "Next description",
    })).toBeFalse();
  });

  test("still publishes discrete card property patches", () => {
    expect(shouldPublishCardStagePatch({ priority: "p1-high" })).toBeTrue();
    expect(shouldPublishCardStagePatch({ estimate: "m" })).toBeTrue();
    expect(shouldPublishCardStagePatch({ agentBlocked: true })).toBeTrue();
    expect(shouldPublishCardStagePatch({
      description: "Next description",
      priority: "p1-high",
    })).toBeTrue();
  });
});
