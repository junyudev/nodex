import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { jsonLines } from "./JsonLines.ts";

const collect = async (chunks: ReadonlyArray<Uint8Array | string>) => {
  const lines: string[] = [];
  for await (const line of jsonLines(Readable.from(chunks))) lines.push(line);
  return lines;
};

describe("JSON Lines", () => {
  it("keeps line and paragraph separators inside a record", async () => {
    const record = JSON.stringify({ pattern: "^[^  ]+$", text: "a b" });
    const lines = await collect([`${record}\n`]);
    expect(lines).toEqual([record]);
    expect(JSON.parse(lines[0]!)).toEqual({ pattern: "^[^  ]+$", text: "a b" });
  });

  it("joins records and characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"a":"é"}\r\n{"b":1}\n{"c":2}');
    const split = [bytes.slice(0, 7), bytes.slice(7, 14), bytes.slice(14)];
    expect(await collect(split)).toEqual(['{"a":"é"}', '{"b":1}', '{"c":2}']);
  });
});
