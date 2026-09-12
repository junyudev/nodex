import { describe, expect, test } from "vite-plus/test";
import {
  projectCodexCatalogDisplayTitle,
  resolveSidebarThreadTitle,
  resolveThreadSearchResultTitle,
} from "./CodexThreadCatalogProjection";

describe("Codex Thread catalog title projection", () => {
  test("projects sidebar titles and bounded preview fallbacks", () => {
    expect(
      resolveSidebarThreadTitle({
        threadName: "**Stored** [title](https://example.com)",
        threadPreview: "ignored",
      }),
    ).toBe("Stored title");
    expect(resolveSidebarThreadTitle({ threadPreview: "x".repeat(61) })).toBe(`${"x".repeat(59)}…`);
  });

  test("keeps raw search previews and falls back through cwd and id", () => {
    expect(
      resolveThreadSearchResultTitle({
        threadName: null,
        threadPreview: "  **Raw** preview  ",
        cwd: "/workspace",
        threadId: "thread-1",
      }),
    ).toBe("**Raw** preview");
    expect(
      resolveThreadSearchResultTitle({
        threadName: null,
        threadPreview: " ",
        cwd: " /workspace ",
        threadId: "thread-1",
      }),
    ).toBe("/workspace");
    expect(
      resolveThreadSearchResultTitle({
        threadName: null,
        threadPreview: "",
        cwd: "",
        threadId: "thread-1",
      }),
    ).toBe("thread-1");
  });

  test("projects catalog display titles with the source title as the empty fallback", () => {
    expect(projectCodexCatalogDisplayTitle("**Build** [search](https://example.com)")).toBe(
      "Build search",
    );
    expect(projectCodexCatalogDisplayTitle("---")).toBe("---");
  });
});
