import { describe, expect, test } from "bun:test";
import {
  buildCardStageDraftOverlay,
  shouldPublishCardStagePatch,
} from "./card-stage-draft-sync";

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

  test("derives only changed text fields into the draft overlay", () => {
    const overlay = buildCardStageDraftOverlay({
      title: "Persisted title",
      description: "Persisted body",
      assignee: "alex",
      agentStatus: "waiting",
    }, {
      title: "Draft title",
      description: "Persisted body",
      assignee: "alex",
      agentStatus: "blocked",
    });

    expect(overlay.title).toBe("Draft title");
    expect(overlay.agentStatus).toBe("blocked");
    expect("description" in overlay).toBeFalse();
    expect("assignee" in overlay).toBeFalse();
  });
});
