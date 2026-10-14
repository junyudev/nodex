import { describe, expect, test } from "vite-plus/test";
import cases from "./fixtures/conversation-markdown-targets.json";
import {
  createConversationTokenEngine,
  conversationTokenChildren,
  type ConversationToken,
} from "./conversation-tokens";
import { resolveConversationFileLink } from "./conversation-markdown-targets";

function findLinks(
  tokens: readonly ConversationToken[],
): Extract<ConversationToken, { type: "link" }>[] {
  return tokens.flatMap((token) => [
    ...(token.type === "link" ? [token] : []),
    ...findLinks(conversationTokenChildren(token)),
  ]);
}
describe("ordinary authored file target grammar", () => {
  const engine = createConversationTokenEngine();
  test.each(cases)(
    "passes actual lexer/recovery to the typed target for $name",
    ({ source, links }) => {
      const document = engine.read(source, false);
      const actual = findLinks(document.tokens);
      expect(actual).toHaveLength(links.length);
      expect(
        actual.map((link) => ({
          href: link.href,
          reference: resolveConversationFileLink(link.href, link.text)?.reference ?? null,
          label: resolveConversationFileLink(link.href, link.text)?.label ?? null,
        })),
      ).toEqual(links);
      expect(Object.isFrozen(document)).toBe(true);
    },
  );
  test("preserves code/escape scopes and nested reference metadata while admitting real citations", () => {
    const citation = "【F:src/a%2520b.ts†L0-L2】";
    const document = engine.read(
      `${citation}\n\n\`${citation}\`\n\n\`\`\`text\n${citation}\n\`\`\``,
      false,
    );
    const token = conversationTokenChildren(document.tokens[0]!)[0];
    expect(token).toMatchObject({
      type: "codexDirective",
      name: "codex-file-citation",
      block: false,
      attributes: { path: "src/a%20b.ts", line_range_start: "0", line_range_end: "2" },
    });
    const last = document.tokens.findLast((value) => value.type === "code");
    expect(last).toMatchObject({ type: "code", text: citation });
    const streaming = engine.readStreaming("[answer][ref]\n\n> [ref]: /tmp/a.ts\n\ntail", {
      source: "",
      length: 0,
      document: null,
    });
    expect(streaming.fullDocument).toBe(true);
    expect(findLinks(streaming.tokens)[0]?.href).toBe("/tmp/a.ts");
  });
});
