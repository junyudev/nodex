import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  corpusMarkdown,
  corpusStreamChunks,
  RUNTIME_CORPORA,
  runtimeCorpusManifest,
} from "./runtime-corpora";

const recorded: unknown = JSON.parse(
  readFileSync(new URL("./runtime-corpora.manifest.json", import.meta.url), "utf8"),
);

describe("Runtime corpora", () => {
  it("rebuild byte for byte as their recorded manifests, so baselines stay comparable", () => {
    // A content change must arrive with a new revision and new recorded baselines.
    expect(Object.values(RUNTIME_CORPORA).map(runtimeCorpusManifest)).toEqual(recorded);
  });

  it("generate exactly the requested ASCII bytes with paragraph boundaries", () => {
    const text = corpusMarkdown(7, 4096);
    expect(Buffer.byteLength(text, "utf8")).toBe(4096);
    expect(text.length).toBe(4096);
    expect(text.split("\n\n").length).toBeGreaterThan(8);
  });

  it("chunk a steady stream into its whole text", () => {
    const stream = RUNTIME_CORPORA["stream-steady"].stream!;
    for (const item of stream.items) {
      const chunks = corpusStreamChunks(stream, item);
      expect(chunks.join("")).toBe(item.text);
      expect(chunks.every((chunk) => chunk.length <= stream.chunkBytes)).toBe(true);
    }
    // Each dual-window chunk completes exactly one paragraph.
    const dual = RUNTIME_CORPORA["dual-window"].stream!;
    expect(corpusStreamChunks(dual, dual.items[0]!).every((chunk) => chunk.endsWith("\n\n"))).toBe(
      true,
    );
  });
});
