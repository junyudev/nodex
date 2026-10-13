import { describe, expect, it } from "vitest";
import { createAgentRuntimeFrameDecoder } from "./agent-runtime-framing";

const encode = (value: string) => new TextEncoder().encode(value);

describe("Agent Runtime frame decoding", () => {
  it("preserves UTF-8 and frame identity across arbitrary byte boundaries", () => {
    const decoder = createAgentRuntimeFrameDecoder(128);
    const bytes = encode('{"id":"1","text":"委派完成"}\n{"id":"2"}\n');
    const frames: unknown[] = [];
    for (const byte of bytes) frames.push(...decoder.push(new Uint8Array([byte])));
    expect(frames).toEqual([{ id: "1", text: "委派完成" }, { id: "2" }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects an over-budget frame before a producer supplies its newline", () => {
    const decoder = createAgentRuntimeFrameDecoder(12);
    decoder.push(encode('{"text":"'));
    expect(() => decoder.push(encode("12345"))).toThrow("transport budget");
  });

  it("rejects a truncated final reply instead of silently losing it", () => {
    const decoder = createAgentRuntimeFrameDecoder(128);
    decoder.push(encode('{"id":"unfinished"}'));
    expect(() => decoder.finish()).toThrow("incomplete frame");
  });

  it("applies its budget per frame while decoding multiple replies in one chunk", () => {
    const decoder = createAgentRuntimeFrameDecoder(10);
    expect(decoder.push(encode('{"id":1}\n{"id":2}\n'))).toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => decoder.push(encode("invalid\n"))).toThrow();
  });
});
