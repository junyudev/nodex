import { describe, expect, test } from "bun:test";
import {
  buildCardStageStoryCard,
  buildCardStageStoryCollapsedProperties,
  buildCardStageStoryThreads,
  CARD_STAGE_STORY_WORKTREE_PATH,
  resolveCardStageStoryPreset,
} from "./card-stage-dev-story-data";

describe("card stage dev story data", () => {
  test("builds dense linked-thread lists with mixed preview coverage", () => {
    const threads = buildCardStageStoryThreads({ threadDensity: "few", previewMode: "mixed" }, 2);

    expect(threads.length).toBe(5);
    expect(typeof threads[0]?.preview).toBe("string");
    expect(threads[1]?.preview === undefined).toBeTrue();
    expect(threads[4]?.threadId).toBe("story-thread-5");
  });

  test("builds worktree card variants with managed path when requested", () => {
    const card = buildCardStageStoryCard({ runInTarget: "newWorktree", existingWorktree: true });

    expect(card.runInTarget).toBe("newWorktree");
    expect(card.runInWorktreePath).toBe(CARD_STAGE_STORY_WORKTREE_PATH);
    expect(card.runInEnvironmentPath).toBe(".codex/environments/ui-polish.toml");
  });

  test("includes threads in collapsed defaults only when requested", () => {
    const collapsed = buildCardStageStoryCollapsedProperties({
      collapseThreadsByDefault: true,
      collapseSecondaryProperties: true,
    });

    expect(JSON.stringify(collapsed)).toBe(JSON.stringify(["tags", "assignee", "agentBlocked", "agentStatus", "threads"]));
  });

  test("falls back to the default preset for unknown ids", () => {
    expect(resolveCardStageStoryPreset("missing").id).toBe("overview");
  });
});
