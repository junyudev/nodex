import { describe, expect, it } from "vitest";

import { resolveDatabaseViewPresentationActivity } from "./database-view-presentation-activity";

describe("Database View presentation activity", () => {
  it("keeps optimistic personal persistence interactive", () => {
    expect(
      resolveDatabaseViewPresentationActivity({
        loading: false,
        saving: true,
        publishing: false,
      }),
    ).toEqual({ phase: "saving", interactionLocked: false });
  });

  it("locks interactions while authority is unavailable or being published", () => {
    expect(
      resolveDatabaseViewPresentationActivity({
        loading: true,
        saving: false,
        publishing: false,
      }),
    ).toEqual({ phase: "loading", interactionLocked: true });
    expect(
      resolveDatabaseViewPresentationActivity({
        loading: false,
        saving: true,
        publishing: true,
      }),
    ).toEqual({ phase: "publishing", interactionLocked: true });
  });
});
