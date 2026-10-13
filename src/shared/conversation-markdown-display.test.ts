import { describe, expect, test } from "vite-plus/test";
import { prepareConversationMarkdownDisplay as prepare } from "./conversation-markdown-display";

const options = { streaming: true, inlineVisualizations: true } as const;

describe("assistant display preparation", () => {
  test.each([
    ['::codex-inline-vis{file="/chart.html" mode="wide"}', true],
    ['::codex-inline-vis{path="/chart.html" title="" expandable="false"}', true],
    ['::codex-inline-vis{file="/chart.html"\ttitle="A } ] title"}', true],
    ['::codex-inline-vis{mode="wide" file="/chart.html"}', false],
    ["::codex-inline-vis{file=/chart.html}", false],
    ['::codex-inline-vis{file=""}', false],
    ['::codex-inline-vis{file="/chart.html" title="unterminated}', false],
    ['::codex-inline-vis{file="/chart.html" unknown="true"}', false],
    ['::codex-inline-vis{file="/chart.html" mode="narrow"}', false],
  ] as const)("guards only the final visualization header: %s", (header, admitted) => {
    const canonical = "Complete prefix\n" + header;
    for (const streaming of [true, false]) {
      expect(prepare(canonical, { ...options, streaming }).source).toBe(
        admitted ? canonical : "Complete prefix\n",
      );
      // An empty final line and an explicit gate-off are separate caller contracts.
      expect(prepare(canonical + "\n", { ...options, streaming }).source).toBe(canonical + "\n");
      if (!streaming)
        expect(prepare(canonical, { streaming, inlineVisualizations: false }).source).toBe(
          canonical,
        );
    }
  });

  test("keeps an unknown declaration while removing only streaming hidden metadata", () => {
    expect(prepare('Before\n::unknown{file="unclosed', options).source).toBe(
      'Before\n::unknown{file="unclosed',
    );
    expect(prepare('Before\n::created-thread{threadId="id"}\nAfter', options).source).toBe(
      "Before\nAfter",
    );
    expect(prepare("Before\n::cre", options).source).toBe("Before");
    expect(
      prepare('Before\n::created-thread{threadId="id"}', { ...options, streaming: false }).source,
    ).toBe('Before\n::created-thread{threadId="id"}');
  });

  test.each([
    ["Hello [world", "Hello "],
    ["Hello [world](https://example.com", "Hello "],
    ["![image](https://example.com/x", ""],
    ["before **partial", "before **partial**"],
    ["before ***", "before ***"],
    ["before **partial*", "before **partial**"],
    ["before `partial", "before `partial"],
    ["- [ ]", "- [ ]"],
    ["before :codex-followup[pending", "before "],
    ['before :writing{title="unclosed', "before "],
    ['before :writing{title="Closed } ] title"}', 'before :writing{title="Closed } ] title"}'],
  ])("repairs only the displayed streaming tail: %j", (canonical, expected) => {
    expect(prepare(canonical, options).source).toBe(expected);
    expect(prepare(canonical, { ...options, streaming: false }).source).toBe(canonical);
  });

  test("preserves code payload, Unicode separators and open-fence state", () => {
    const payload =
      'alpha\n\n\n\nbeta\u2028gamma\u2029delta\u0085epsilon\n::unknown{file="literal"}';
    const source = `\`\`\`text\n${payload}\n\`\`\``;
    expect(prepare(source, options)).toEqual({ source, openCodeFence: false });
    expect(prepare(source, { ...options, streaming: false })).toEqual({
      source,
      openCodeFence: null,
    });
    const open = `\`\`\`text\n${payload}`;
    expect(prepare(open, options)).toEqual({ source: open, openCodeFence: true });
    expect(prepare(source.replaceAll("\n", "\r\n"), options).source).toBe(source);
  });

  test("separates real front metadata from setext without hiding its entries", () => {
    expect(prepare("---\ntitle: demo\n---\nbody", options).source).toBe(
      "---\ntitle: demo\n\n---\nbody",
    );
    for (const source of ["Name\n---", "---\nplain\n---\nbody", "---\ntitle: demo\nbody"])
      expect(prepare(source, options).source).toBe(source);
  });

  test("converts validated legacy declarations without touching a root code block", () => {
    const marker = "\uE200visualize\uE202chart.html\uE201";
    expect(prepare(marker, { ...options, streaming: false }).source).toBe(
      '::codex-inline-vis{file="chart.html"}',
    );
    const code = `\`\`\`text\n${marker}\n\`\`\``;
    expect(prepare(code, { ...options, streaming: false }).source).toBe(code);
    const invalid = "\uE200visualize\uE202../chart.html\uE201";
    expect(prepare(invalid, { ...options, streaming: false }).source).toBe(invalid);
  });
});
