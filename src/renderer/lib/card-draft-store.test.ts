import { describe, expect, test } from "bun:test";
import {
  clearCardDraftOverlay,
  getCardDraftOverlay,
  mergeCardDraftOverlay,
  resetCardDraftStoreForTest,
  setCardDraftOverlay,
} from "./card-draft-store";

describe("card draft store", () => {
  test("stores and clears scoped draft overlays", () => {
    resetCardDraftStoreForTest();

    setCardDraftOverlay("default", "card-1", {
      title: "Draft title",
      description: "Draft body",
    });

    const stored = getCardDraftOverlay("default", "card-1");
    expect(stored?.title).toBe("Draft title");
    expect(stored?.description).toBe("Draft body");

    clearCardDraftOverlay("default", "card-1");
    expect(getCardDraftOverlay("default", "card-1")).toBe(null);
  });

  test("merges overlays without touching unrelated fields", () => {
    const merged = mergeCardDraftOverlay({
      id: "card-1",
      title: "Persisted title",
      description: "Persisted body",
      priority: "p2-medium",
    }, {
      title: "Draft title",
    });

    expect(merged?.title).toBe("Draft title");
    expect(merged?.description).toBe("Persisted body");
    expect(merged?.priority).toBe("p2-medium");
  });
});
