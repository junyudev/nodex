import { act, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import "@/globals.css";
import { NfmDocument } from "@/components/board/nfm-renderer";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { contrastRatio, getPaintedBackground, parseComputedColor } from "@/test/color-contrast";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";

installRendererThemeFixture();

// Whitespace and `&&` take the theme's ordinary foreground, which is the first token to vanish
// when a light color is painted on the dark surface.
const source = "```bash\nbrew install --cask qlvideo && qlmanage -r cache\n```";

const surfaces = {
  "assistant thread": () => <MarkdownRenderer content={source} dialect="conversation" />,
  "user message": () => <NfmDocument blocks={readMarkdown(source)} density="message" />,
};

describe.each(["light", "dark"] as const)("read-only code in the %s scheme", (theme) => {
  test.each(Object.keys(surfaces) as (keyof typeof surfaces)[])(
    "keeps every %s token legible against the composited surface",
    async (surface) => {
      applyRendererThemeForTest(theme);
      const Subject = surfaces[surface];
      const view = render(
        <div style={{ background: "var(--background)" }}>
          <Subject />
        </div>,
      );
      try {
        const block = view.container.querySelector<HTMLElement>("[data-readonly-code-block]")!;
        const tokens = await waitFor(() => {
          const rendered = [...block.querySelectorAll<HTMLElement>("code > span > span")];
          if (rendered.length < 2) throw new Error("Shiki tokens did not render");
          return rendered;
        });
        const background = getPaintedBackground(block);
        const ratios = tokens.map((token) => ({
          text: token.textContent,
          ratio: contrastRatio(parseComputedColor(getComputedStyle(token).color), background),
        }));

        expect(
          Math.min(...ratios.map(({ ratio }) => ratio)),
          `${theme} ${surface} contrast: ${JSON.stringify(ratios)}`,
        ).toBeGreaterThanOrEqual(4.5);
      } finally {
        view.unmount();
      }
    },
  );
});

test.each(["light", "dark"] as const)(
  "conversation code reads in the shared %s Code palette",
  async (theme) => {
    applyRendererThemeForTest(theme);
    const view = render(
      <MarkdownRenderer
        content={'```json\n{ "name": "nodex", "count": 2 }\n```'}
        dialect="conversation"
      />,
    );
    try {
      const color = (text: string) => {
        const token = [
          ...view.container.querySelectorAll<HTMLElement>(
            "[data-readonly-code-block] code span span",
          ),
        ].find((candidate) => candidate.textContent?.includes(text));
        if (!token) throw new Error(`No token for ${text}`);
        return getComputedStyle(token).color;
      };
      await waitFor(() => {
        expect(color("name")).toBe(readRendererThemeColor("--color-codex-syntax-attribute"));
        expect(color("nodex")).toBe(readRendererThemeColor("--color-codex-syntax-string"));
        expect(color("2")).toBe(readRendererThemeColor("--color-codex-syntax-literal"));
      });
    } finally {
      view.unmount();
    }
  },
);

test("one Wrap toggle rewraps every read-only code block without changing its source", async () => {
  const line = `const values = [${Array.from({ length: 40 }, (_, index) => index).join(", ")}];`;
  const fence = (value: string) => `\`\`\`ts\n${value}\n\`\`\``;
  const view = render(
    <div style={{ width: 360 }}>
      <MarkdownRenderer content={`${fence(line)}\n\n${fence(`${line} // second`)}`} />
    </div>,
  );
  const blocks = () => [
    ...view.container.querySelectorAll<HTMLElement>("[data-readonly-code-block]"),
  ];
  const overflows = (block: HTMLElement) => {
    const pre = block.querySelector("pre")!;
    return pre.scrollWidth > pre.clientWidth;
  };
  const toggle = async () => {
    const button = blocks()[0]!.querySelector<HTMLButtonElement>(
      '[data-code-block-action="wrap"]',
    )!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  };
  try {
    await waitFor(() => expect(blocks()).toHaveLength(2));
    expect(blocks().every(overflows)).toBe(true);
    const sources = blocks().map((block) => block.querySelector("code")!.textContent);

    await toggle();
    await waitFor(() => expect(blocks().some(overflows)).toBe(false));
    for (const block of blocks()) {
      const wrap = block.querySelector('[data-code-block-action="wrap"]')!;
      expect(wrap.getAttribute("aria-pressed")).toBe("true");
      expect(wrap.getAttribute("aria-label")).toBe("Disable word wrap");
    }
    expect(blocks().map((block) => block.querySelector("code")!.textContent)).toEqual(sources);

    await toggle();
    await waitFor(() => expect(blocks().every(overflows)).toBe(true));
  } finally {
    view.unmount();
  }
});
