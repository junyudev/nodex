import { describe, expect, test } from "bun:test";
import {
  removeActiveDevStoryFromSearch,
  readActiveDevStoryFromSearch,
  resolveActiveDevStory,
} from "./dev-story";

describe("dev-story", () => {
  test("parses threads-panel query aliases", () => {
    expect(readActiveDevStoryFromSearch("?dev-story=threads-panel")).toBe("threads-panel");
    expect(readActiveDevStoryFromSearch("?dev-story=threads")).toBe("threads-panel");
    expect(readActiveDevStoryFromSearch("?dev-story=thread-panel")).toBe("threads-panel");
  });

  test("parses card-stage query aliases", () => {
    expect(readActiveDevStoryFromSearch("?dev-story=card-stage")).toBe("card-stage");
    expect(readActiveDevStoryFromSearch("?dev-story=card")).toBe("card-stage");
    expect(readActiveDevStoryFromSearch("?dev-story=cardstage")).toBe("card-stage");
  });

  test("parses ui-components query aliases", () => {
    expect(readActiveDevStoryFromSearch("?dev-story=ui-components")).toBe("ui-components");
    expect(readActiveDevStoryFromSearch("?dev-story=ui")).toBe("ui-components");
    expect(readActiveDevStoryFromSearch("?dev-story=components")).toBe("ui-components");
  });

  test("returns null for unknown stories", () => {
    expect(readActiveDevStoryFromSearch("?dev-story=unknown")).toBe(null);
    expect(readActiveDevStoryFromSearch("")).toBe(null);
  });

  test("gates story behind development mode", () => {
    expect(
      resolveActiveDevStory({
        search: "?dev-story=threads-panel",
        isDevelopment: false,
      }),
    ).toBe(null);
    expect(
      resolveActiveDevStory({
        search: "?dev-story=threads-panel",
        isDevelopment: true,
      }),
    ).toBe("threads-panel");
  });

  test("removes story query while preserving other params", () => {
    expect(removeActiveDevStoryFromSearch("?dev-story=threads-panel&foo=bar")).toBe("?foo=bar");
    expect(removeActiveDevStoryFromSearch("?foo=bar&dev-story=threads")).toBe("?foo=bar");
    expect(removeActiveDevStoryFromSearch("?foo=bar")).toBe("?foo=bar");
    expect(removeActiveDevStoryFromSearch("?dev-story=threads-panel")).toBe("");
  });
});
