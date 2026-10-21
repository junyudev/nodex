import { describe, expect, it } from "vite-plus/test";
import { parseMessageText, serializeMessageText } from "./message-text";
import { parseNfm } from "./nfm/parser";

describe("message text", () => {
  it("reads back exactly as it was written", () => {
    for (const text of [
      "Settings buttons have **no labels**:\n- the gear\n  - in the toolbar\n- the close button",
      "First line\nsecond line\n\nA new paragraph with a < b and C:\\Users",
      "> quoted\n> twice\n\nThen see https://example.com/docs.",
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "\\- not a list\n1\\. not a number either",
      "Plan:\n  first, the toolbar\n    then the dialogs\nDone.",
      "- item\n  more about it\n  and more\n- next",
      "Plan:\n\tfirst\n\t\tthen",
    ]) {
      expect(serializeMessageText(parseMessageText(text))).toBe(text);
    }
  });

  it("writes a stored message back the way a person writes it", () => {
    expect(serializeMessageText(parseNfm("one<br>two\nthree\n- [link](https://a.example/x)"))).toBe(
      "one\ntwo\n\nthree\n- [link](https://a.example/x)",
    );
    expect(serializeMessageText(parseNfm("[https://a.example/x](https://a.example/x) works"))).toBe(
      "https://a.example/x works",
    );
  });

  it("says when message text cannot hold a stored body exactly", () => {
    expect(serializeMessageText(parseNfm("one<br><br>two"))).toBeNull();
  });

  it("links bare URLs, but not inside words or code", () => {
    expect(parseMessageText("see https://a.example/x, then `https://b.example`")).toEqual(
      parseNfm("see [https://a.example/x](https://a.example/x), then `https://b.example`"),
    );
    expect(parseMessageText("foohttps://a.example")).toEqual(parseNfm("foohttps://a.example"));
  });
});
