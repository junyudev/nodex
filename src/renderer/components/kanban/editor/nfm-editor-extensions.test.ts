import { describe, expect, test } from "bun:test";
import {
  createNfmEditorExtensions,
  NFM_DISABLED_EXTENSIONS,
  THREAD_SECTION_SHORTCUT_PATTERN,
  threadSectionInputRule,
} from "./nfm-editor-extensions";
import { createEmptyThreadSectionBlock } from "./thread-section";

describe("nfm editor extensions", () => {
  test("replaces the built-in divider shortcut with the thread-section shortcut", () => {
    const extensions = createNfmEditorExtensions();

    expect(NFM_DISABLED_EXTENSIONS.includes("divider-block-shortcuts")).toBeTrue();
    expect(extensions.includes(threadSectionInputRule)).toBeTrue();
    expect(THREAD_SECTION_SHORTCUT_PATTERN.test("---")).toBeTrue();
    expect(THREAD_SECTION_SHORTCUT_PATTERN.test("--")).toBeFalse();
  });

  test("reuses the shared empty thread-section block shape", () => {
    expect(JSON.stringify(createEmptyThreadSectionBlock())).toBe(JSON.stringify({
      type: "threadSection",
      props: {
        label: "",
        threadId: "",
      },
    }));
  });
});
