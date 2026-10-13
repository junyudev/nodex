import { expect, test } from "vite-plus/test";
import type { Element, Root } from "hast";
import { createMarkdownElementKeyOwner } from "./markdown-element-keys";

const paragraph = (): Element => ({
  type: "element",
  tagName: "p",
  properties: {},
  children: [
    { type: "text", value: "Before " },
    {
      type: "element",
      tagName: "img",
      properties: { src: "https://example.com/image.png", alt: "Retained" },
      children: [],
    },
  ],
});
const heading = (value: string): Element => ({
  type: "element",
  tagName: "h1",
  properties: {},
  children: [{ type: "text", value }],
});
const root = (...children: Element[]): Root => ({ type: "root", children });

test("semantic sibling keys survive preceding insertions without consuming IDs for discarded renders", () => {
  const owner = createMarkdownElementKeyOwner();
  const original = paragraph();
  const first = owner.prepare(root(original), new WeakMap());
  owner.commit(first);
  const discarded = heading("Discarded");
  const pending = owner.prepare(root(discarded, paragraph()), new WeakMap());
  const actual = heading("Actual");
  const retained = paragraph();
  const next = owner.prepare(root(actual, retained), new WeakMap());
  expect(next.keys.get(actual)).toBe(pending.keys.get(discarded));
  expect(next.keys.get(retained)).toBe(first.keys.get(original));
  expect(next.keys.get(retained.children[1]!)).toBe(first.keys.get(original.children[1]!));
  owner.commit(next);
  const duplicate = paragraph();
  const final = owner.prepare(root(paragraph(), duplicate), new WeakMap());
  expect(final.keys.get(duplicate)).not.toBe(first.keys.get(original));
  expect(new Set(final.roots.map((value) => value.key)).size).toBe(2);
});

test("a ten-thousand-block preceding insertion preserves identities with a bounded record-read budget", () => {
  const owner = createMarkdownElementKeyOwner();
  const make = (index: number): Element => ({
    type: "element",
    tagName: "p",
    properties: {},
    children: [{ type: "text", value: `unique-${index} paragraph` }],
  });
  const original = Array.from({ length: 10_000 }, (_value, index) => make(index));
  const first = owner.prepare(root(...original), new WeakMap());
  let reads = 0;
  owner.commit({
    ...first,
    roots: first.roots.map(
      (value) =>
        new Proxy(value, {
          get(target, key, receiver) {
            if (key === "seed" || key === "key") reads += 1;
            return Reflect.get(target, key, receiver);
          },
        }),
    ),
  });
  const nextNodes = original.map((_value, index) => make(index));
  const next = owner.prepare(root(heading("inserted"), ...nextNodes), new WeakMap());
  expect(next.keys.get(nextNodes[0]!)).toBe(first.keys.get(original[0]!));
  expect(next.keys.get(nextNodes.at(-1)!)).toBe(first.keys.get(original.at(-1)!));
  expect(new Set(next.roots.map((value) => value.key)).size).toBe(10_001);
  expect(reads).toBeLessThanOrEqual(60_000);
});

test("semantic first-word distinctions between units 64 and 80 retain their own reordered element identities", () => {
  const owner = createMarkdownElementKeyOwner();
  const word = "a".repeat(70);
  const first = heading(`${word}first`);
  const second = heading(`${word}other`);
  const initial = owner.prepare(root(first, second), new WeakMap());
  owner.commit(initial);
  const reorderedFirst = heading(`${word}other`);
  const reorderedSecond = heading(`${word}first`);
  const next = owner.prepare(root(reorderedFirst, reorderedSecond), new WeakMap());
  expect(next.keys.get(reorderedFirst)).toBe(initial.keys.get(second));
  expect(next.keys.get(reorderedSecond)).toBe(initial.keys.get(first));
});
