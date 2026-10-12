import { describe, expect, test } from "vite-plus/test";
import { stripCodexRemarkDirectiveLines } from "./codex-remark-directives";

describe("codex remark directives", () => {
  test("strips standalone directive lines and normalizes spacing", () => {
    const value = [
      "Summary complete.",
      "",
      '::inbox-item{title="Ready" summary="Review it"}',
      "",
      "",
      "::archive-thread{}",
      "Next step is clear.",
    ].join("\n");

    expect(stripCodexRemarkDirectiveLines(value)).toBe("Summary complete.\n\nNext step is clear.");
  });

  test("keeps inline directive-looking text visible", () => {
    expect(stripCodexRemarkDirectiveLines('Done. ::inbox-item{title="Inline"}')).toBe(
      'Done. ::inbox-item{title="Inline"}',
    );
  });

  test("excludes executable indented directives while preserving indented code", () => {
    for (const indentation of ["", " ", "  ", "   "]) {
      expect(
        stripCodexRemarkDirectiveLines(
          `${indentation}::codex-inline-vis{file=plot.html}\nActual response`,
        ),
      ).toBe("Actual response");
    }
    expect(
      stripCodexRemarkDirectiveLines("    ::codex-inline-vis{file=literal.html}\nActual response"),
    ).toBe("    ::codex-inline-vis{file=literal.html}\nActual response");
  });
});
