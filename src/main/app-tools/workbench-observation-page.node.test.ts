import { describe, expect, it } from "vitest";
import {
  readWorkbenchObservationPage,
  workbenchObservationHandle,
} from "./workbench-observation-page";

describe("Workbench observation pagination", () => {
  it("binds continuation to the observation, collection and filters", () => {
    const input = {
      observationId: "observation",
      kind: "tabs" as const,
      panelId: "right" as const,
      groupId: "group",
      limit: 2,
    };
    const first = readWorkbenchObservationPage([1, 2, 3], input)!;
    expect(first.items).toEqual([1, 2]);
    expect(first.complete).toBe(false);
    const continued = { ...input, cursor: first.nextCursor! };
    expect(readWorkbenchObservationPage([1, 2, 3], continued)).toEqual({
      items: [3],
      nextCursor: null,
      total: 3,
      complete: true,
    });
    for (const changed of [
      { observationId: "other" },
      { kind: "groups" as const },
      { panelId: "bottom" as const },
      { groupId: "other" },
    ])
      expect(readWorkbenchObservationPage([1, 2, 3], { ...continued, ...changed })).toBeNull();
    expect(
      readWorkbenchObservationPage([1, 2, 3], { ...continued, cursor: `${first.nextCursor}x` }),
    ).toBeNull();
  });

  it("does not expose embedded resource identities through tab handles", () => {
    const internal = "page:private-page-id";
    const handle = workbenchObservationHandle("one", "tab", internal);
    expect(handle).not.toContain(internal);
    expect(workbenchObservationHandle("one", "tab", internal)).toBe(handle);
    expect(workbenchObservationHandle("two", "tab", internal)).not.toBe(handle);
    expect(workbenchObservationHandle("one", "group", internal)).not.toBe(handle);
  });
});
