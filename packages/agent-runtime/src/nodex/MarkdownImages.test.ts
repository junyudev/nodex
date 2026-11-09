import { describe, expect, it } from "@effect/vitest";

import { markdownImages, rebindMarkdownImages } from "./MarkdownImages.ts";

const reply = [
  "Before: ![The old chart](/Users/me/charts/before.png) and after:",
  "",
  "![After][after]",
  "",
  '![Spaced](</Users/me/My Pictures/space.png> "A title")',
  "",
  "A [link](/Users/me/notes.md), `![code](/Users/me/code.png)` and a gone one ![x](/tmp/gone&amp;lost.png).",
  "",
  "```",
  "![fenced](/Users/me/fenced.png)",
  "```",
  "",
  "[after]: /Users/me/charts/after.png",
].join("\n");

describe("a reply's Markdown pictures", () => {
  it("finds each picture it shows, in order, by the address Markdown reads", () => {
    expect(markdownImages(reply).map(({ url, alt }) => [url, alt])).toEqual([
      ["/Users/me/charts/before.png", "The old chart"],
      ["/Users/me/charts/after.png", "After"],
      ["/Users/me/My Pictures/space.png", "Spaced"],
      ["/tmp/gone&lost.png", "x"],
    ]);
  });

  it("shows each named picture from its new address, leaves out a gone one and keeps the rest", () => {
    const rebound = rebindMarkdownImages(
      reply,
      new Map([
        ["/Users/me/charts/before.png", "nodex://copy/before"],
        ["/Users/me/charts/after.png", "nodex://copy/after"],
        ["/Users/me/My Pictures/space.png", "nodex://copy/space"],
        ["/tmp/gone&lost.png", null],
      ]),
    );
    expect(markdownImages(rebound).map(({ url, alt }) => [url, alt])).toEqual([
      ["nodex://copy/before", "The old chart"],
      ["nodex://copy/after", "After"],
      ["nodex://copy/space", "Spaced"],
    ]);
    expect(rebound).toContain("Before: ![The old chart](<nodex://copy/before>) and after:");
    expect(rebound).toContain("and a gone one .");
    // Links, code and fenced examples are text, not pictures, and stay as written.
    expect(rebound).toContain("A [link](/Users/me/notes.md), `![code](/Users/me/code.png)`");
    expect(rebound).toContain("![fenced](/Users/me/fenced.png)");
    expect(rebindMarkdownImages(reply, new Map())).toBe(reply);
  });

  it("keeps an alt text that Markdown would otherwise read differently", () => {
    const rebound = rebindMarkdownImages(
      "![a [bracketed] alt](/p.png)",
      new Map([["/p.png", "nodex://copy/p"]]),
    );
    expect(markdownImages(rebound).map(({ url, alt }) => [url, alt])).toEqual([
      ["nodex://copy/p", "a [bracketed] alt"],
    ]);
  });
});
