import { describe, expect, test } from "vite-plus/test";
import { chatHighlightSegments, chatFieldHighlightSegments } from "./chat-search";

describe("chat search presentation", () => {
  test("cuts CJK text at its matched ranges without splitting characters", () => {
    expect(chatHighlightSegments("帮我把我的服务器配置一下", [{ start: 5, end: 8 }])).toEqual([
      { text: "帮我把我的", highlight: false },
      { text: "服务器", highlight: true },
      { text: "配置一下", highlight: false },
    ]);
    expect(chatHighlightSegments("No match", [])).toBeNull();
  });

  test("offsets a branch hint past the worktree prefix it omits", () => {
    const hint = { label: "Branch", text: "fix-search", ranges: [{ start: 4, end: 10 }] };
    expect(chatFieldHighlightSegments("nodex/runtime/fix-search", hint, "Branch")).toEqual([
      { text: "nodex/runtime/fix-", highlight: false },
      { text: "search", highlight: true },
    ]);
    expect(chatFieldHighlightSegments("Nodex", hint, "Project")).toBeNull();
  });
});
