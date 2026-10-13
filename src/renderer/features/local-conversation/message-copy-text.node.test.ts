import { describe, expect, test } from "vite-plus/test";
import { normalizeMessageCopyText } from "./message-copy-text";

const visualizationCases = [
  {
    source: 'A\n\n::codex-inline-vis{file="chart.html"}\n\nB',
    expected: "A\n\nB",
  },
  {
    source: 'A\n\n\n\n::codex-inline-vis{file="chart.html"}\n\n\n\nB',
    expected: "A\n\n\n\nB",
  },
  {
    source: '::codex-inline-vis{file="chart.html"}\n\nB',
    expected: "B",
  },
  {
    source: 'A\n\n::codex-inline-vis{file="chart.html"}',
    expected: "A",
  },
  {
    source: 'A\n::codex-inline-vis{file="chart.html"}\nB',
    expected: "A\nB",
  },
  {
    source: '::codex-inline-vis{file="chart.html"}',
    expected: "",
  },
  {
    source: "A\n\n::unknown{x=y}\n\nB",
    expected: "A\n\n::unknown{x=y}\n\nB",
  },
  {
    source: '> ::codex-inline-vis{file="chart.html"}',
    expected: '> ::codex-inline-vis{file="chart.html"}',
  },
  {
    source: '- ::codex-inline-vis{file="chart.html"}',
    expected: '- ::codex-inline-vis{file="chart.html"}',
  },
  {
    source: '    ::codex-inline-vis{file="chart.html"}',
    expected: "",
  },
  {
    source: '`::codex-inline-vis{file="chart.html"}`',
    expected: "``",
  },
  {
    source: '```text\n::codex-inline-vis{file="chart.html"}\n```',
    expected: '```text\n::codex-inline-vis{file="chart.html"}\n```',
  },
  {
    source: "::codex-inline-vis{}\n\nB",
    expected: "B",
  },
  {
    source: "::codex-inline-vis{invalid",
    expected: "{invalid",
  },
  {
    source: 'A\n\n::codex-inline-vis{file="chart.html"}\n\n::codex-live-vis{}\n\nB',
    expected: "A\n\nB",
  },
  {
    source: 'A\n\n::codex-inline-vis{file="chart.html"}\n\nB\n',
    expected: "A\n\nB",
  },
  {
    source: 'A\n\n::codex-inline-vis{file="chart.html"}\nB\n',
    expected: "A\n\nB",
  },
  {
    source: 'before ::codex-inline-vis{file="chart.html"} after',
    expected: 'before ::codex-inline-vis{file="chart.html"} after',
  },
  {
    source: '   ::codex-inline-vis{file="chart.html"}',
    expected: "",
  },
  {
    source: '# ::codex-inline-vis{file="chart.html"}',
    expected: '# ::codex-inline-vis{file="chart.html"}',
  },
  {
    source: '::codex-inline-vis{file="chart.html"} suffix',
    expected: " suffix",
  },
  {
    source: "::codex-inline-vis-unknown{}",
    expected: "::codex-inline-vis-unknown{}",
  },
  {
    source: ':::writing{id="x"}\n::codex-inline-vis{}\n:::',
    expected: "::codex-inline-vis{}",
  },
  {
    source: "**::codex-inline-vis{}**",
    expected: "**::codex-inline-vis{}**",
  },
  {
    source: '::codex-inline-vis[title]{file="chart.html"}',
    expected: "",
  },
  {
    source: ':codex-inline-vis{file="chart.html"}',
    expected: ':codex-inline-vis{file="chart.html"}',
  },
  {
    source: '\\::codex-inline-vis{file="chart.html"}',
    expected: "\\",
  },
  {
    source: '::codex-inline-vis{file="chart.html"}\n\n\n\nB',
    expected: "B",
  },
  {
    source: "A\r\n\r\n::codex-inline-vis{}\r\n\r\nB",
    expected: "A\n\nB",
  },
  {
    source: "A\r\n\r\n> ::codex-inline-vis{}\r\n\r\nB",
    expected: "A\r\n\r\n> ::codex-inline-vis{}\r\n\r\nB",
  },
  {
    source: "A | B\n--- | ---\n::codex-inline-vis{} | C",
    expected: "A | B\n--- | ---\n::codex-inline-vis{} | C",
  },
  {
    source: "::codex-inline-vis{} | B\n--- | ---\nA | C",
    expected: " | B\n--- | ---\nA | C",
  },
  {
    source: "<div>\n::codex-inline-vis{}\n</div>",
    expected: "<div>\n::codex-inline-vis{}\n</div>",
  },
  {
    source: "<!--\n::codex-inline-vis{}\n-->",
    expected: "<!--\n::codex-inline-vis{}\n-->",
  },
  {
    source: "[title\n::codex-inline-vis{}\nmore](https://example.com)",
    expected: "[title\nmore](https://example.com)",
  },
  {
    source: ":::unknown\n::codex-inline-vis{}\n:::",
    expected: ":::unknown\n::codex-inline-vis{}\n:::",
  },
  {
    source: "prefix\n\\::codex-inline-vis{}\nsuffix",
    expected: "prefix\n\\::codex-inline-vis{}\nsuffix",
  },
  {
    source: "prefix\n  ::codex-inline-vis{}\nsuffix",
    expected: "prefix\n  suffix",
  },
  {
    source: "prefix\n`::codex-inline-vis{}`\nsuffix",
    expected: "prefix\n`::codex-inline-vis{}`\nsuffix",
  },
  {
    source: "prefix\n\n\\::codex-inline-vis{}\nsuffix",
    expected: "prefix\n\n\\suffix",
  },
];

describe("whole assistant Markdown Copy", () => {
  test.each(visualizationCases)(
    "preserves authored root tokens around $source",
    ({ source, expected }) => {
      expect(normalizeMessageCopyText(source)).toBe(expected);
    },
  );
  test.each([
    ["  First\n\n\n\nSecond  ", "First\n\n\n\nSecond"],
    ["```text\nAciteB\n```", "```text\nAB\n```"],
    ["`【F:src/a%20b.ts†L02-L4】`", "`src/a b.ts:2-4`"],
    ["【./src/a.ts†L2】", "【./src/a.ts†L2】"],
    ["【F:src/a%ZZ.ts†L1】", "src/a%ZZ.ts"],
    ["【//server/share/a.ts†L2-L02】", "//server/share/a.ts:2"],
    ['A :codex-annotation{index="1"} B', 'A :codex-annotation{index="1"} B'],
    [':codex-followup[**Go**]{prompt="run"}', "**Go**"],
    ['` :codex-followup[Go]{prompt="run"}`', '` :codex-followup[Go]{prompt="run"}`'],
    [':::writing{id="block"}\nOriginal\n\n\n\nTail\n:::', "Original\n\n\n\nTail"],
    [
      '```text\n:::writing{id="block"}\nOriginal\n:::writing\n```',
      '```text\n:::writing{id="block"}\nOriginal\n:::writing\n```',
    ],
    [
      ':::writing{id="block"}\n```text\n:::writing{id="literal"}\nOriginal\n:::\n```\n:::',
      '```text\n:::writing{id="literal"}\nOriginal\n:::\n```',
    ],
  ])("applies stage-specific source rules for %s", (source, expected) => {
    expect(normalizeMessageCopyText(source)).toBe(expected);
  });
  test.each([
    {
      source: ':codex-followup[Go]{prompt="run"}',
      expected: "Go",
    },
    {
      source: ':codex-followup[**Go**]{prompt="run"}',
      expected: "**Go**",
    },
    {
      source: ':codex-followup[A [B] C]{prompt="run"}',
      expected: 'A [B C]{prompt="run"}',
    },
    {
      source: '` :codex-followup[Go]{prompt="run"}`',
      expected: '` :codex-followup[Go]{prompt="run"}`',
    },
    {
      source: '```text\n:codex-followup[Go]{prompt="run"}\n```',
      expected: '```text\n:codex-followup[Go]{prompt="run"}\n```',
    },
    {
      source: ":codex-followup[Go]",
      expected: "Go",
    },
    {
      source: ":codex-followup[Go]{bad",
      expected: "Go{bad",
    },
    {
      source: ':codex-followup[Outer :codex-followup[Inner]{prompt="run"}]{prompt="outer"}',
      expected: 'Outer :codex-followup[Inner]{prompt="outer"}',
    },
    {
      source: '::codex-followup[Go]{prompt="run"}',
      expected: "Go",
    },
    {
      source: 'A ::codex-followup[Go]{prompt="run"}',
      expected: "A Go",
    },
    {
      source: '> ::codex-followup[Go]{prompt="run"}',
      expected: "> Go",
    },
    {
      source: '# ::codex-followup[Go]{prompt="run"}',
      expected: "# :Go",
    },
    {
      source: ':codex-followup[A]{prompt="[x]"}',
      expected: "A",
    },
    {
      source: ':codex-followup[A][B]{prompt="run"}',
      expected: "A][B",
    },
    {
      source: '\\:codex-followup[Go]{prompt="run"}',
      expected: '\\:codex-followup[Go]{prompt="run"}',
    },
    {
      source: '\\\\:codex-followup[Go]{prompt="run"}',
      expected: "\\\\Go",
    },
    {
      source: 'A :codex-followup[**Go**]{prompt="run"} B',
      expected: "A **Go** B",
    },
    {
      source: '- ::codex-followup[Go]{prompt="run"}',
      expected: "- Go",
    },
    {
      source: '$$ :codex-followup[Go]{prompt="run"} $$',
      expected: '$$ :codex-followup[Go]{prompt="run"} $$',
    },
    {
      source: '\\(:codex-followup[Go]{prompt="run"}\\)',
      expected: '\\(:codex-followup[Go]{prompt="run"}\\)',
    },
    {
      source: '$$\n:codex-followup[Go]{prompt="run"}\n$$',
      expected: '$$\n:codex-followup[Go]{prompt="run"}\n$$',
    },
    {
      source: '<span data-x=":codex-followup[Go]{prompt="run"}">x</span>',
      expected: '<span data-x="Go">x</span>',
    },
    {
      source: '[Link](https://x/:codex-followup[Go]{prompt="run"})',
      expected: '[Link](https://x/:codex-followup[Go]{prompt="run"})',
    },
    {
      source: "![Image](https://example.com/:codex-followup[Go]{prompt=x})",
      expected: "![Image](https://example.com/:codex-followup[Go]{prompt=x})",
    },
    {
      source: "![Image](assets/:codex-followup[Go]{prompt=x}.png)",
      expected: "![Image](assets/:codex-followup[Go]{prompt=x}.png)",
    },
    {
      source: "[ref]: https://example.com/:codex-followup[Go]{prompt=x}\n\n![Image][ref]",
      expected: "[ref]: https://example.com/:codex-followup[Go]{prompt=x}\n\n![Image][ref]",
    },
    {
      source: '![image :codex-followup[Go]{prompt="run"}](x.png)',
      expected: "![image Go](x.png)",
    },
  ])("replays authored follow-up labels $source", ({ source, expected }) => {
    expect(normalizeMessageCopyText(source)).toBe(expected);
  });
  test("converts visualization markers before the global private-marker stage", () => {
    expect(normalizeMessageCopyText("A\n\nvisualizechart.html\n\nB")).toBe("A\n\nB");
    expect(normalizeMessageCopyText("```text\nvisualizechart.html\n```")).toBe("```text\n\n```");
    expect(normalizeMessageCopyText("$$\n::codex-inline-vis{}\n$$")).toBe(
      "$$\n::codex-inline-vis{}\n$$",
    );
    expect(normalizeMessageCopyText("```text\n$$\n```\n:codex-followup[Go]")).toBe(
      "```text\n$$\n```\nGo",
    );
    expect(normalizeMessageCopyText("$$\nopaque\n$$\n:codex-followup[Go]")).toBe(
      "$$\nopaque\n$$\nGo",
    );
  });
  test("filters citations only under the actual output scope", () => {
    const source =
      "Keep 【F:out/a.ts†L1】 / drop 【F:src/private.ts†L2】 / literal 【./src/private.ts†L2】";
    expect(
      normalizeMessageCopyText(source, {
        cwd: "/workspace",
        projectlessOutputDirectory: "/workspace/out",
      }),
    ).toBe("Keep out/a.ts / drop  / literal 【./src/private.ts†L2】");
    expect(normalizeMessageCopyText(source)).toBe(
      "Keep out/a.ts / drop src/private.ts:2 / literal 【./src/private.ts†L2】",
    );
  });
});
