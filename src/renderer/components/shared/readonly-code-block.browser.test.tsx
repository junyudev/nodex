import { render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import "@/globals.css";
import { NfmDocument } from "@/components/board/nfm-renderer";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { parseNfm } from "@/lib/nfm/parser";
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
  "user message": () => <NfmDocument blocks={parseNfm(source)} density="message" />,
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
