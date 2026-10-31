import { describe, expect, test } from "vite-plus/test";
import {
  projectCodexCatalogDisplayTitle,
  resolveSidebarThreadTitle,
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

  test("projects catalog display titles with the source title as the empty fallback", () => {
    expect(projectCodexCatalogDisplayTitle("**Build** [search](https://example.com)")).toBe(
      "Build search",
    );
    expect(projectCodexCatalogDisplayTitle("---")).toBe("---");
  });
});
