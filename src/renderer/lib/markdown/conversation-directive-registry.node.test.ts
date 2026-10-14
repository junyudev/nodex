import { describe, expect, test } from "vite-plus/test";
import {
  conversationTokenChildren,
  createConversationTokenEngine,
  type ConversationToken,
} from "./conversation-tokens";
import { readConversationDirectiveRegistration } from "./conversation-directive-registry";

const engine = createConversationTokenEngine();
function read(source: string) {
  const visit = (tokens: readonly ConversationToken[]): ConversationToken | undefined => {
    for (const token of tokens) {
      if (token.type === "codexDirective") return token;
      const child = visit(conversationTokenChildren(token));
      if (child) return child;
    }
    return undefined;
  };
  const token = visit(engine.read(source, false).tokens);
  if (!token || token.type !== "codexDirective") throw new Error("Missing parsed directive");
  return { token, registration: readConversationDirectiveRegistration(token) };
}

describe("conversation directive registration", () => {
  test.each([
    ':github-details[Inline]{summary="More"}',
    '::github-details[Leaf]{summary="More"}',
    ':::github-details{summary="More"}\nContainer\n:::',
  ])("keeps renderer admission independent of the directive marker family: %s", (source) => {
    expect(read(source).registration.kind).toBe("github-details");
  });
  test.each([
    ['open="true"', true],
    ["open=true", true],
    ["open", false],
    ['open="TRUE"', false],
    ["open=1", false],
    ['open="false"', false],
    ["", false],
  ])("uses parsed string attributes for disclosure state: %s", (attribute, initiallyOpen) => {
    const { token, registration } = read(
      `:::github-details{summary="More" ${attribute}}\nBody **strong**\n:::`,
    );
    expect(registration).toEqual({ kind: "github-details", summary: "More", initiallyOpen });
    expect(token.tokens.some((child) => child.type === "paragraph")).toBe(true);
    expect(Object.isFrozen(token)).toBe(true);
  });

  test("does not invent summary text or reinterpret a valueless attribute", () => {
    expect(read(":::github-details{summary}\nBody\n:::").registration).toEqual({
      kind: "github-details",
      summary: undefined,
      initiallyOpen: false,
    });
  });

  test.each(["inbox-item", "created-thread", "git-push"])(
    "keeps registered null metadata separate from unregistered content: %s",
    (name) => {
      expect(read(`::${name}{title="No UI"}`).registration).toEqual({ kind: "null" });
    },
  );

  test.each([
    [':task-stub[raw **inline**]{title="Review"}', "raw **inline**"],
    ['::task-stub[raw **leaf**]{title="Review"}', "raw **leaf**"],
    [
      ':::task-stub{title="Review"}\nraw **body**\n\nkeep `code`\n:::',
      "\nraw **body**\n\nkeep `code`",
    ],
  ])("keeps a task's authored prompt separate from its title: %s", (source, prompt) => {
    expect(read(source).registration).toEqual({ kind: "task-stub", title: "Review", prompt });
  });
  test("preserves empty task fields without inventing a submission gate", () => {
    expect(read("::task-stub{title}").registration).toEqual({
      kind: "task-stub",
      title: "",
      prompt: "",
    });
  });
  test.each(["unknown-next", "code-comment", "writing", "automation-citation"])(
    "does not grant a renderer to an unowned family: %s",
    (name) => {
      const source = `:::${name}{title="Keep"}\nAuthored body\n:::`;
      const { token, registration } = read(source);
      expect(registration).toEqual({ kind: "unregistered" });
      expect(token.raw).toBe(source);
    },
  );
});
