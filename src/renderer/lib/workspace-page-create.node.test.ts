import { describe, expect, test } from "vite-plus/test";
import { NEW_CHAT_TITLE } from "../../shared/session-title";
import { DEFAULT_NEW_PAGE_TITLE, resolveNewPageTitleForSession } from "./workspace-page-create";

describe("resolveNewPageTitleForSession", () => {
  test("reuses a chat's displayTitle normalized onto one line", () => {
    expect(
      resolveNewPageTitleForSession({
        displayTitle: "  Update\n  implementation\tnotes  ",
        noThreadFallbackTitle: NEW_CHAT_TITLE,
      }),
    ).toBe("Update implementation notes");
  });

  test("falls back to noThreadFallbackTitle when displayTitle is blank", () => {
    expect(
      resolveNewPageTitleForSession({
        displayTitle: "   ",
        noThreadFallbackTitle: "Release checklist",
      }),
    ).toBe("Release checklist");
  });

  test("falls back to Untitled for unnamed drafts and missing titles", () => {
    for (const source of [
      null,
      undefined,
      "",
      "   ",
      NEW_CHAT_TITLE,
      `  ${NEW_CHAT_TITLE}  `,
      { displayTitle: NEW_CHAT_TITLE, noThreadFallbackTitle: NEW_CHAT_TITLE },
      { displayTitle: "", noThreadFallbackTitle: NEW_CHAT_TITLE },
      { displayTitle: "", noThreadFallbackTitle: "" },
    ]) {
      expect(resolveNewPageTitleForSession(source)).toBe(DEFAULT_NEW_PAGE_TITLE);
    }
  });

  test("bounds very long titles without splitting surrogate pairs", () => {
    const longEmojiTitle = "🚀".repeat(2_100);
    const resolved = resolveNewPageTitleForSession(longEmojiTitle);
    expect(Array.from(resolved)).toHaveLength(2_000);
    expect(resolved.endsWith("🚀")).toBe(true);
  });
});
