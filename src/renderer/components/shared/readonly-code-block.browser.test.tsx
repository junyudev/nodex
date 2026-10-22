import { render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import "@/globals.css";
import { NfmDocument } from "@/components/board/nfm-renderer";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { parseNfm } from "@/lib/nfm/parser";
import { contrastRatio, getPaintedBackground, parseComputedColor } from "@/test/color-contrast";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";

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
