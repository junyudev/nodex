import { createIntl } from "react-intl";
import { expect, test } from "vite-plus/test";
import { NEW_CHAT_TITLE } from "../../shared/session-title";
import { presentSessionTitle } from "./session-title-presentation";

const zh = createIntl({
  locale: "zh-CN",
  messages: { "command.newThread.title": "新聊天" },
});

test("presents the canonical Session placeholder and empty titles in the display language", () => {
  for (const title of [NEW_CHAT_TITLE, "", "  ", null, undefined]) {
    expect(presentSessionTitle(title, zh)).toBe("新聊天");
  }
});

test("preserves real Session titles and a real fallback title", () => {
  expect(presentSessionTitle("  Review the PR  ", zh)).toBe("  Review the PR  ");
  expect(presentSessionTitle("New chat with Sam", zh)).toBe("New chat with Sam");
  expect(presentSessionTitle({ displayTitle: "", noThreadFallbackTitle: "Roadmap" }, zh)).toBe(
    "Roadmap",
  );
});
