import { expect, test } from "vite-plus/test";
import { createConversationDocumentOwner } from "./conversation-document";
import { createConversationTokenEngine } from "./conversation-tokens";

test("append and a revised tail preserve keys without indexing the old siblings", () => {
  const owner = createConversationDocumentOwner(null, createConversationTokenEngine());
  const source = "Repeated\n\nRepeated\n\nTail";
  const first = owner.prepare(source, true);
  owner.commit(first, true);
  const keys = (candidate: typeof first) => candidate.nodes.map((node) => node.key);
  const rewrite = owner.prepare(source + " growing", true);
  expect(keys(rewrite)).toEqual(keys(first));
  owner.commit(rewrite, true);
  const append = owner.prepare(source + " growing\n\nNew block", true);
  expect(keys(append).slice(0, first.nodes.length)).toEqual(keys(first));
  expect(owner.getMeasurements().contentIndexesBuilt).toBe(0);
});

test("unchanged fences reserve their keys ahead of an insertion, even with repeated code", () => {
  const owner = createConversationDocumentOwner(null, createConversationTokenEngine());
  const block = (code: string) => "\x60\x60\x60ts\n" + code + "\n\x60\x60\x60";
  const source = [block("one"), block("two"), block("one")].join("\n\n");
  const first = owner.prepare(source, false);
  owner.commit(first, false);
  const discarded = owner.prepare(block("discarded") + "\n\n" + source, false);
  const actual = owner.prepare(block("inserted") + "\n\n" + source, false);
  const fences = (candidate: typeof first) =>
    candidate.nodes.filter((node) => node.token.type === "code").map((node) => node.key);
  expect(fences(actual).slice(1)).toEqual(fences(first));
  expect(fences(actual)[0]).toBe(fences(discarded)[0]);
  expect(new Set(fences(actual)).size).toBe(4);
  expect(owner.getMeasurements().contentIndexesBuilt).toBe(2);
});
