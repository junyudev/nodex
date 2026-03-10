import { describe, expect, test } from "bun:test";
import type { NfmBlock } from "./types";
import { parseNfm } from "./parser";
import { serializeNfm } from "./serializer";

describe("NFM code fences", () => {
  test("serializeNfm uses a longer fence when code contains triple backticks", () => {
    const blocks = [
      {
        type: "codeBlock",
        language: "ts",
        code: "const a = 1;\n```\nconst b = 2;",
        children: [],
      },
    ] satisfies NfmBlock[];

    const serialized = serializeNfm(blocks);
    expect(serialized).toBe("````ts\nconst a = 1;\n```\nconst b = 2;\n````");

    const reparsed = parseNfm(serialized);
    expect(reparsed.length).toBe(1);
    expect(reparsed[0]?.type).toBe("codeBlock");
    if (reparsed[0]?.type !== "codeBlock") return;

    expect(reparsed[0].language).toBe("ts");
    expect(reparsed[0].code).toBe("const a = 1;\n```\nconst b = 2;");
    expect(reparsed[0].children.length).toBe(0);
  });

  test("parseNfm accepts tilde fences and ignores shorter interior runs", () => {
    const input = "~~~~js\nconst a = 1;\n~~~\nconst b = 2;\n~~~~";

    const parsed = parseNfm(input);

    expect(parsed.length).toBe(1);
    expect(parsed[0]?.type).toBe("codeBlock");
    if (parsed[0]?.type !== "codeBlock") return;

    expect(parsed[0].language).toBe("js");
    expect(parsed[0].code).toBe("const a = 1;\n~~~\nconst b = 2;");
  });

  test("parseNfm accepts a longer closing fence than the opener", () => {
    const input = "````\nvalue\n`````";

    const parsed = parseNfm(input);

    expect(parsed.length).toBe(1);
    expect(parsed[0]?.type).toBe("codeBlock");
    if (parsed[0]?.type !== "codeBlock") return;

    expect(parsed[0].language).toBe("");
    expect(parsed[0].code).toBe("value");
  });
});
