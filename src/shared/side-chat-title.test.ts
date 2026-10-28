import { expect, test } from "vite-plus/test";
import { sideChatRequestTitle } from "./side-chat-title";
import { appendAgentAppContext, prepareAgentMessage } from "./agent-prompt";

test("names a side chat from the last request body with Markdown and citations projected to prose", () => {
  expect(
    sideChatRequestTitle(
      "Context\n## My request:\nEarlier request\n## My request for Codex:\n  **Review** [this guide](https://example.com)\n\n and `report`\tresults citeturn0search0",
    ),
  ).toBe("Review this guide and report results");
});

test("removes only the exact leading page-comment context envelope before projecting its request", () => {
  const request = "**Inspect** this\n## My request:\nliteral request heading";
  expect(
    sideChatRequestTitle(
      `<page-comment-context>\nPage evidence\n</page-comment-context>\n## My request:\n${request}`,
    ),
  ).toBe("Inspect this My request: literal request heading");
  expect(sideChatRequestTitle("<page-comment-context>authored prose</page-comment-context>")).toBe(
    "authored prose",
  );
});

test("leaves an empty request untitled and preserves long display labels without a character cap", () => {
  expect(sideChatRequestTitle("Context\n## My request:\n \t")).toBeNull();
  expect(sideChatRequestTitle("<!-- invisible comment -->")).toBeNull();
  const request = "Detailed request ".repeat(200).trim();
  expect(sideChatRequestTitle(request)).toBe(request);
});

test("names a compiled request from its authored text without attached selections or app context", async () => {
  const compile = (text: string) =>
    prepareAgentMessage(
      text,
      { text, selectedTextAttachments: [{ id: "selection", text: "Inherited evidence" }] },
      async () => "",
    );
  const selected = await compile("**Inspect** the request");
  const message = appendAgentAppContext(
    selected,
    [{ text: "Interactive response state" }],
    "App context",
  );
  expect(sideChatRequestTitle(message.text)).toBe("Inspect the request");
  expect(sideChatRequestTitle((await compile("")).text)).toBeNull();
});
