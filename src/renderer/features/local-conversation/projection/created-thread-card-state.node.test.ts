import { describe, expect, test } from "vite-plus/test";
import { truncateCreatedThreadReply } from "./created-thread-card-state";
describe("compact created chat replies", () => {
  test("keeps the full 120-character reply and cuts longer text at a word boundary", () => {
    const source = "x".repeat(120);
    expect(truncateCreatedThreadReply(source)).toBe(source);
    expect(truncateCreatedThreadReply(`${"word ".repeat(24)}tail`)).toBe(
      `${"word ".repeat(23)}word…`,
    );
    expect(truncateCreatedThreadReply(`${"x".repeat(120)}tail`)).toBe(`${"x".repeat(119)}…`);
  });
  test("never tears an emoji sequence while truncating", () => {
    const emoji = "👩‍💻";
    expect(truncateCreatedThreadReply(emoji.repeat(121))).toBe(`${emoji.repeat(119)}…`);
  });
});
