import { describe, expect, it } from "vitest";

import { flattenNodexMarkdown, plainMarkdownText, previewMarkdown } from "./parse";

describe("flattenNodexMarkdown", () => {
  it("turns a File attachment into a link a phone can open", () => {
    expect(
      flattenNodexMarkdown(':attachment{kind="file" source="nodex://files/a1" name="notes.txt"}'),
    ).toBe("[notes.txt](nodex://files/a1)");
  });

  it("names mentions instead of showing their URLs", () => {
    expect(flattenNodexMarkdown("See <nodex://pages/p1> and <nodex://sessions/s1>")).toBe(
      "See [Page](nodex://pages/p1) and [Chat](nodex://sessions/s1)",
    );
  });

  it("keeps a Page a message mentions as a link that reads as the Page's name", () => {
    const sent =
      "Quote the Page [Launch Codeword](nodex://pages/2f25fb11?spaceId=library-59bb) exactly";
    expect(flattenNodexMarkdown(sent)).toBe(sent);
  });

  it("shows a date's text and drops Agent settings", () => {
    expect(flattenNodexMarkdown(':date{start="2026-10-28"} ok')).toBe("2026-10-28 ok");
    expect(flattenNodexMarkdown(':date{start="2026-10-28" end="2026-10-30"}')).toBe(
      "2026-10-28 – 2026-10-30",
    );
    expect(flattenNodexMarkdown(':agent-config{mode="plan"}x')).toBe("x");
  });

  it("keeps a container's title and dedents its body", () => {
    expect(flattenNodexMarkdown(":::toggle[Details]\n  Body\n:::\nAfter")).toBe(
      "**Details**\n\nBody\nAfter",
    );
  });

  it("leaves code untouched, even when it looks like a directive", () => {
    const code = '```\n:date{start="x"}\n:::toggle[a]\n```';
    expect(flattenNodexMarkdown(code)).toBe(code);
  });

  it("makes a picture on a line of its own a paragraph of its own", () => {
    // A picture right under a sentence would otherwise sit in the sentence's line as a glyph.
    expect(flattenNodexMarkdown("The star.\n![Luna star](nodex://files/a1)\nIt reads LUNA.")).toBe(
      "The star.\n\n![Luna star](nodex://files/a1)\n\nIt reads LUNA.",
    );
    expect(flattenNodexMarkdown('![a](nodex://files/a) ![b](https://x.test/b.png "B")')).toBe(
      '![a](nodex://files/a)\n\n![b](https://x.test/b.png "B")',
    );
    expect(flattenNodexMarkdown("Before\n\n![a](nodex://files/a)\n\nAfter")).toBe(
      "Before\n\n![a](nodex://files/a)\n\nAfter",
    );
  });

  it("leaves a picture in running text, in a list or in code where it is", () => {
    for (const text of [
      "See ![a](nodex://files/a) here",
      "- ![a](nodex://files/a)",
      "```\n![a](nodex://files/a)\n```",
      "Text\n\n    ![a](nodex://files/a)",
    ])
      expect(flattenNodexMarkdown(text)).toBe(text);
  });

  it("leaves text with no markup literal", () => {
    const text = "a < b, [draft, snake_case";
    expect(flattenNodexMarkdown(text)).toBe(text);
  });
});

describe("dollars", () => {
  // The renderer reads math between single dollars too; an escaped dollar is shown as itself.
  it("shows a captured shell command as written, as its chat does", () => {
    expect(
      flattenNodexMarkdown('for i in $(seq 1 40); do echo "inbox-tick $i $(date +%H:%M:%S)"; done'),
    ).toBe('for i in \\$(seq 1 40); do echo "inbox-tick \\$i \\$(date +%H:%M:%S)"; done');
    expect(flattenNodexMarkdown("It costs $5, or $10 with $HOME set")).toBe(
      "It costs \\$5, or \\$10 with \\$HOME set",
    );
  });

  it("keeps math written between double dollars", () => {
    expect(flattenNodexMarkdown("Energy is $$E = mc^2$$.")).toBe("Energy is $$E = mc^2$$.");
    expect(flattenNodexMarkdown("$$\n\\frac{a}{b}\n$$")).toBe("$$\n\\frac{a}{b}\n$$");
  });

  it("leaves code, links and escaped dollars exactly as written", () => {
    for (const text of [
      "Run `echo $HOME` first",
      "Run ``echo `$i` ``",
      "A span `that wraps\nonto $PATH` still is code",
      "```sh\necho $i\n```",
      "Before:\n\n    echo $i\n    echo $j",
      "See <https://example.com/?a=$b> or https://example.com/$c",
      "Already \\$5",
    ])
      expect(flattenNodexMarkdown(text)).toBe(text);
  });

  it("still escapes after a backtick that opens nothing", () => {
    expect(flattenNodexMarkdown("A ` mark, then $i")).toBe("A ` mark, then \\$i");
  });

  it("does not take an indented line inside a paragraph for code", () => {
    expect(flattenNodexMarkdown("Total:\n    $5")).toBe("Total:\n    \\$5");
  });

  it("escapes a container's title and body", () => {
    expect(flattenNodexMarkdown(":::toggle[Cost $5]\n  Pay $i\n:::")).toBe(
      "**Cost \\$5**\n\nPay \\$i",
    );
  });
});

describe("previewMarkdown", () => {
  it("keeps a short body whole", () => {
    expect(previewMarkdown("short")).toEqual({ text: "short", cut: false });
  });

  it("cuts a long body at a line", () => {
    const body = `${"a".repeat(400)}\n${"b".repeat(400)}`;
    expect(previewMarkdown(body)).toEqual({ text: "a".repeat(400), cut: true });
  });

  it("closes a code fence the cut left open", () => {
    const body = `\`\`\`\n${"x\n".repeat(400)}`;
    const preview = previewMarkdown(body, 100);
    expect(preview.cut).toBe(true);
    expect(preview.text.endsWith("\n```")).toBe(true);
    expect(preview.text.match(/^```/gmu)).toHaveLength(2);
  });
});

describe("plainMarkdownText", () => {
  it("reads Markdown as the words it shows", () => {
    expect(plainMarkdownText("**Bold**, *em*, _em_, ~~gone~~ and `a*b*c`")).toBe(
      "Bold, em, em, gone and a*b*c",
    );
    expect(
      plainMarkdownText("# Title\n> - [x] [Docs](https://x.test) ![Star](nodex://files/a)"),
    ).toBe("Title Docs Star");
    expect(plainMarkdownText("<b>Hi</b> <https://x.test> \\*literal\\*")).toBe(
      "Hi https://x.test *literal*",
    );
  });

  it("leaves words that only look like marks", () => {
    expect(plainMarkdownText("snake_case_name, 2 * 3 * 4 and $HOME")).toBe(
      "snake_case_name, 2 * 3 * 4 and $HOME",
    );
  });
});

it("flattens skill mentions while preserving literal directives and dollars", () => {
  expect(
    flattenNodexMarkdown(
      'Use(:skill{name="tools:review"}). $5 and $HOME ` :skill{name="code"} ` $$:skill{name="math"}$$ \\:skill{name="literal"}',
    ),
  ).toBe(
    'Use( \\$tools:review ). \\$5 and \\$HOME ` :skill{name="code"} ` $$:skill{name="math"}$$ \\:skill{name="literal"}',
  );
});
