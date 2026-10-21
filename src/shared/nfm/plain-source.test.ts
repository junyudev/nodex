import { describe, expect, it } from "vite-plus/test";
import { parseNfm } from "./parser";
import { serializePlainNfm } from "./plain-source";

const plain = (source: string) => serializePlainNfm(parseNfm(source));

describe("serializePlainNfm", () => {
  it("shows everyday text as typed", () => {
    expect(plain("a < b and [draft and price is $5")).toBe("a < b and [draft and price is $5");
    expect(plain("path C:\\Users\\me")).toBe("path C:\\Users\\me");
    expect(plain("<div>html</div>")).toBe("<div>html</div>");
  });

  it("keeps the escapes that stop text from becoming markup", () => {
    const literal = parseNfm("\\*not bold\\* and **bold**");
    const source = serializePlainNfm(literal);
    expect(parseNfm(source)).toEqual(literal);
    expect(source).toContain("**bold**");
    expect(source).not.toBe("*not bold* and **bold**");
  });

  it("always reads back as the same message", () => {
    for (const source of [
      "**Ship** the changelog\n- check the links\n1. first\n2. second",
      "use `x \\< y` and \\`ticks\\`",
      'see <mention-page url="nodex://pages/x" /> then a \\< b',
      "trailing backslash \\\\",
      "```ts\nconst a = 1 < 2;\n```",
    ]) {
      const blocks = parseNfm(source);
      expect(parseNfm(serializePlainNfm(blocks))).toEqual(blocks);
    }
  });
});
