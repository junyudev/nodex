import { describe, expect, test } from "vite-plus/test";
import { resolveComposerAdaptiveLayout } from "./composer-adaptive-footer";

const compactFloatingComposer = {
  isFloatingComposer: true,
  hasAttachments: false,
  hasExplicitLineBreak: false,
  promptIntrinsicWidthPx: 320,
  compactInputWidthPx: 400,
  hasNotice: false,
  isDictating: false,
} as const;

describe("resolveComposerAdaptiveLayout", () => {
  test("promotes a visually wrapped one-line draft to the shared multiline layout", () => {
    expect(
      resolveComposerAdaptiveLayout({
        ...compactFloatingComposer,
        promptIntrinsicWidthPx: 480,
      }),
    ).toBe("multiline");
  });

  test("keeps a fitting floating draft compact across subpixel rounding", () => {
    expect(
      resolveComposerAdaptiveLayout({
        ...compactFloatingComposer,
        promptIntrinsicWidthPx: 400.5,
      }),
    ).toBe("single-line");
  });

  test("uses the normal multiline layout for structural content and sessions", () => {
    expect(
      resolveComposerAdaptiveLayout({
        ...compactFloatingComposer,
        hasExplicitLineBreak: true,
      }),
    ).toBe("multiline");
    expect(
      resolveComposerAdaptiveLayout({
        ...compactFloatingComposer,
        hasAttachments: true,
      }),
    ).toBe("multiline");
    expect(
      resolveComposerAdaptiveLayout({
        ...compactFloatingComposer,
        isFloatingComposer: false,
      }),
    ).toBe("multiline");
  });

  test("opens a floating composer into its card while a notice heads it", () => {
    expect(
      resolveComposerAdaptiveLayout({
        ...compactFloatingComposer,
        hasNotice: true,
      }),
    ).toBe("multiline");
  });
});
