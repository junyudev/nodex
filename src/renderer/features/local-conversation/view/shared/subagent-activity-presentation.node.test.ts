import { describe, expect, test } from "vite-plus/test";
import { getSubagentActivityDisplayBudget } from "./subagent-activity-presentation";

describe("subagent activity display budget", () => {
  test.each([
    [0, 0, 0, 0],
    [1, 1, 1, 0],
    [2, 2, 2, 0],
    [3, 3, 3, 0],
    [4, 4, 2, 2],
    [6, 4, 2, 4],
  ])(
    "keeps independent avatar and name limits for %i agents",
    (count, avatarCount, namedCount, hiddenCount) => {
      expect(getSubagentActivityDisplayBudget(count!)).toEqual({
        avatarCount,
        namedCount,
        hiddenCount,
      });
    },
  );
});
