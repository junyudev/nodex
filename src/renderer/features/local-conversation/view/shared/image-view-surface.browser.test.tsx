import { act, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent, cdp } from "vite-plus/test/browser";
import "../../../../globals.css";
import type { WorkspaceFileBinaryReadResult, WorkspaceFileRequest } from "@/lib/types";
import { installMotionPreferenceForTest, installWindowApi } from "@/test/browser-globals";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { ContentImageScopeProvider, THIS_COMPUTER_IMAGE_SCOPE } from "@/lib/content-image";
import { ImageViewSurface } from "./image-view-surface";
import type { ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { LoadingPlaceholder } from "@/components/ui/loading-placeholder";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { NodexLogoShimmer } from "@/components/ui/nodex-logo-shimmer";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { REDUCED_MOTION_STORAGE_KEY } from "@/lib/reduced-motion";
import { ReducedMotionProvider } from "@/lib/use-reduced-motion";
import { readLoadingAnimations } from "@/test/loading-motion";
import { BrowserTabFavicon } from "@/features/browser-sidebar/browser-tab-favicon";
import { SubagentAvatar } from "./subagent-avatar";
import { CodexShimmerText } from "./codex-shimmer-text";

describe("image view surface", () => {
  installRendererThemeFixture();

  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const svg = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#2876d8"/></svg>',
  );
  const imagePaths = ["/images/first.png", "/images/second.svg", "/images/missing.png"];

  afterEach(() => vi.restoreAllMocks());

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      await userEvent.click(element);
      await Promise.resolve();
    });
  }

  async function press(key: string): Promise<void> {
    await act(async () => {
      await userEvent.keyboard(key);
      await Promise.resolve();
    });
  }

  async function decoded(image: HTMLImageElement, width: number, height: number): Promise<void> {
    await image.decode();
    expect(image.naturalWidth).toBe(width);
    expect(image.naturalHeight).toBe(height);
  }

  describe("inspected images in Chromium", () => {
    test("shares decoded thumbnail bytes with navigation and preview after the source disappears", async () => {
      await page.viewport(900, 600);
      const restoreMotion = installMotionPreferenceForTest(true);
      try {
        for (const theme of ["light", "dark"] as const) {
          applyRendererThemeForTest(theme);
          let sourceExists = true;
          let releaseRead!: () => void;
          const readReady = new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
          const readFile = vi.fn(
            async (input: WorkspaceFileRequest): Promise<WorkspaceFileBinaryReadResult> => {
              await readReady;
              if (!sourceExists || input.path === imagePaths[2]) throw new Error("ENOENT");
              return {
                contentsBase64: input.path.endsWith(".svg") ? svg : png,
              };
            },
          );
          installWindowApi({
            invoke: async (channel: string, input: WorkspaceFileRequest) => {
              if (channel !== "read-file-binary") throw new Error(`Unexpected query: ${channel}`);
              return await readFile(input);
            },
            on: () => () => {},
          });
          const client = createTestQueryClient();
          const view = render(
            <TestQueryProvider client={client}>
              <ContentImageScopeProvider
                scope={{
                  ...THIS_COMPUTER_IMAGE_SCOPE,
                  conversationId: `images-${theme}`,
                  hostId: "local",
                }}
              >
                <ImageViewSurface imagePaths={imagePaths} />
              </ContentImageScopeProvider>
            </TestQueryProvider>,
          );
          try {
            const header = view.getByRole("button", { name: "Viewed 3 images" });
            expect(header.getAttribute("aria-expanded")).toBe("false");
            expect(readFile).not.toHaveBeenCalled();

            await click(header);
            const loading = await view.findAllByRole("status", { name: "Loading inspected image" });
            expect(loading).toHaveLength(3);
            for (const tile of loading) {
              expect(tile.getBoundingClientRect().width).toBe(80);
              expect(tile.getBoundingClientRect().height).toBe(80);
              expect(getComputedStyle(tile).borderTopColor).toBe(
                readRendererThemeColor("--color-border-strong"),
              );
            }
            await act(async () => {
              releaseRead();
              await readReady;
            });
            await view.findByRole("img", { name: "Image failed to load" });
            await waitFor(() => {
              expect(view.getAllByRole("button", { name: "Inspected image" })).toHaveLength(2);
            });
            const triggers = view.getAllByRole("button", { name: "Inspected image" });
            const first = within(triggers[0]).getByRole<HTMLImageElement>("img");
            const second = within(triggers[1]).getByRole<HTMLImageElement>("img");
            await decoded(first, 1, 1);
            await decoded(second, 160, 90);
            for (const trigger of triggers) {
              expect(trigger.getBoundingClientRect().width).toBe(80);
              expect(trigger.getBoundingClientRect().height).toBe(80);
              expect(getComputedStyle(trigger).borderTopColor).toBe(
                readRendererThemeColor("--color-border-strong"),
              );
            }
            expect(getComputedStyle(first).objectFit).toBe("cover");
            const failed = view.getByRole("img", { name: "Image failed to load" });
            expect(failed.getBoundingClientRect().width).toBe(64);
            expect(failed.getBoundingClientRect().height).toBe(64);
            expect(getComputedStyle(failed).color).toBe(
              readRendererThemeColor("--color-text-danger"),
            );
            expect(failed.textContent).toBe("Failed");
            expect(view.queryByRole("button", { name: /retry/i })).toBeNull();
            expect(readFile.mock.calls.map(([input]) => input)).toEqual(
              imagePaths.map((path) => ({ hostId: "local", path })),
            );

            sourceExists = false;
            const firstSrc = first.src;
            const secondSrc = second.src;
            await click(triggers[0]);
            let dialog = await view.findByRole("dialog", { name: "Image preview" });
            const previewDialog = dialog;
            let preview = within(dialog).getByRole<HTMLImageElement>("img");
            await decoded(preview, 1, 1);
            expect(preview.src).toBe(firstSrc);
            await press("{ArrowRight}");
            await waitFor(() => {
              dialog = view.getByRole("dialog", { name: "Image preview" });
              expect(dialog).toBe(previewDialog);
              preview = within(dialog).getByRole<HTMLImageElement>("img");
              expect(preview.src).toBe(secondSrc);
            });
            await decoded(preview, 160, 90);
            expect(within(dialog).queryByRole("button", { name: "Next image" })).toBeNull();
            await press("{ArrowLeft}");
            await waitFor(() => {
              dialog = view.getByRole("dialog", { name: "Image preview" });
              expect(dialog).toBe(previewDialog);
              expect(within(dialog).getByRole<HTMLImageElement>("img").src).toBe(firstSrc);
            });
            await press("{ArrowRight}");
            await waitFor(() => {
              dialog = view.getByRole("dialog", { name: "Image preview" });
              expect(dialog).toBe(previewDialog);
              expect(within(dialog).getByRole<HTMLImageElement>("img").src).toBe(secondSrc);
            });
            await press("{Escape}");
            await waitFor(() => {
              expect(view.queryByRole("dialog", { name: "Image preview" })).toBeNull();
              expect(document.activeElement).toBe(triggers[1]);
            });
            expect(readFile).toHaveBeenCalledTimes(3);
          } finally {
            releaseRead();
            view.unmount();
            client.clear();
          }
        }
      } finally {
        restoreMotion();
      }
    });
  });
});

describe("loading motion parity", () => {
  interface ChromiumMediaEmulationSession {
    send(
      method: "Emulation.setEmulatedMedia",
      params: {
        features: Array<{
          name: "prefers-reduced-motion";
          value: "no-preference" | "reduce";
        }>;
      },
    ): Promise<unknown>;
  }

  function renderWithMotionPreference(
    children: ReactNode,
    preference: "system" | "on" | "off" = "off",
  ) {
    localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, preference);
    const store = createMaitaiStore();
    const view = render(
      <MaitaiProvider store={store}>
        <ReducedMotionProvider>{children}</ReducedMotionProvider>
      </MaitaiProvider>,
    );
    return {
      ...view,
      rerenderWithPreference: (nextChildren: ReactNode) => {
        view.rerender(
          <MaitaiProvider store={store}>
            <ReducedMotionProvider>{nextChildren}</ReducedMotionProvider>
          </MaitaiProvider>,
        );
      },
      dispose: () => {
        view.unmount();
        disposeMaitaiStore(store);
        localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
      },
    };
  }

  describe("loading motion parity in Chromium", () => {
    test("keeps static Subagent identity free of loading timelines", () => {
      const view = renderWithMotionPreference(
        <div data-testid="avatar-root">
          <SubagentAvatar seed="researcher" />
        </div>,
      );

      try {
        expect(readLoadingAnimations(view.getByTestId("avatar-root"))).toEqual([]);
      } finally {
        view.dispose();
      }
    });

    test("runs the cadenced two-transform burst and tears it down between bursts", async () => {
      const view = render(
        <CodexShimmerText data-testid="cadenced">Running checks</CodexShimmerText>,
      );
      const root = view.getByTestId("cadenced");
      expect(readLoadingAnimations(root)).toEqual([]);

      await act(async () => {
        // oxlint-disable-next-line nodex/no-real-time-wait-in-tests -- Observe the native animation during the product cadence.
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      const burst = readLoadingAnimations(root);
      expect(burst).toHaveLength(2);
      expect(burst.every((animation) => animation.durationMs === 1_000)).toBe(true);
      expect(burst.every((animation) => animation.iterationCount === 1)).toBe(true);
      expect(
        burst.every((animation) => animation.animatedProperties.join(",") === "transform"),
      ).toBe(true);

      await act(async () => {
        // oxlint-disable-next-line nodex/no-real-time-wait-in-tests -- Observe native animation teardown between product cadence bursts.
        await new Promise((resolve) => setTimeout(resolve, 1_050));
      });
      expect(readLoadingAnimations(root)).toEqual([]);
    });

    test("retains one approved classic background-position shimmer", async () => {
      const view = render(
        <CodexShimmerText data-testid="classic" variant="classic">
          Browser is working
        </CodexShimmerText>,
      );
      const root = view.getByTestId("classic");

      await waitFor(() => expect(readLoadingAnimations(root)).toHaveLength(1));
      const animation = readLoadingAnimations(root)[0];
      expect(animation?.animatedProperties).toEqual(["backgroundPositionX", "backgroundPositionY"]);
      expect(animation?.durationMs).toBe(2_000);
      expect(animation?.iterationCount).toBe(Number.POSITIVE_INFINITY);
    });

    test("uses one contained transform spinner and honors the app override", async () => {
      const active = renderWithMotionPreference(
        <div data-testid="spinner-root" role="status" aria-label="Loading">
          <ActivitySpinnerIcon />
        </div>,
        "off",
      );
      try {
        await waitFor(() => {
          expect(readLoadingAnimations(active.getByTestId("spinner-root"))).toHaveLength(1);
        });
        const animation = readLoadingAnimations(active.getByTestId("spinner-root"))[0];
        expect(animation?.animatedProperties).toEqual(["transform"]);
        expect(animation?.iterationCount).toBe(Number.POSITIVE_INFINITY);
        expect(animation?.hiddenByAncestor).toBe(false);
      } finally {
        active.dispose();
      }

      const reduced = renderWithMotionPreference(
        <div data-testid="reduced-spinner-root" role="status" aria-label="Loading">
          <ActivitySpinnerIcon />
        </div>,
        "on",
      );
      try {
        expect(readLoadingAnimations(reduced.getByTestId("reduced-spinner-root"))).toEqual([]);
      } finally {
        reduced.dispose();
      }
    });

    test("bounds text, placeholder, and startup identity timelines", async () => {
      const view = render(
        <div data-testid="loading-primitives">
          <LoadingResultsShimmer lines={3} />
          <LoadingPlaceholder className="h-20" />
          <NodexLogoShimmer />
        </div>,
      );
      const root = view.getByTestId("loading-primitives");

      await waitFor(() => expect(readLoadingAnimations(root)).toHaveLength(5));
      const animations = readLoadingAnimations(root);
      expect(
        animations.filter((animation) => animation.animatedProperties.join(",") === "transform"),
      ).toHaveLength(4);
      expect(
        animations.filter((animation) => animation.animatedProperties.join(",") === "opacity"),
      ).toHaveLength(1);
    });

    test("unmounts the Browser throbber after its completion transition", async () => {
      const view = renderWithMotionPreference(
        <div data-testid="browser-icon" className="size-4">
          <BrowserTabFavicon
            faviconUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
            isLoading
            isWaitingForResponse={false}
          />
        </div>,
      );
      const root = view.getByTestId("browser-icon");
      try {
        await waitFor(() => expect(readLoadingAnimations(root)).toHaveLength(3));
        expect(root.querySelector("[data-browser-tab-throbber='true']")).not.toBeNull();

        view.rerenderWithPreference(
          <div data-testid="browser-icon" className="size-4">
            <BrowserTabFavicon
              faviconUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
              isLoading={false}
              isWaitingForResponse={false}
            />
          </div>,
        );
        await waitFor(() => {
          expect(
            view.getByTestId("browser-icon").querySelector("[data-browser-tab-throbber='true']"),
          ).toBeNull();
          expect(readLoadingAnimations(view.getByTestId("browser-icon"))).toEqual([]);
        });
      } finally {
        view.dispose();
      }
    });

    test("stops OS-governed CSS loaders under reduced motion", async () => {
      const session = cdp() as unknown as ChromiumMediaEmulationSession;
      const setReducedMotion = async (value: "no-preference" | "reduce") => {
        await act(async () => {
          await session.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value }],
          });
          await Promise.resolve();
        });
      };

      try {
        await setReducedMotion("reduce");
        const view = render(
          <div data-testid="os-reduced-loaders">
            <CodexShimmerText variant="classic">Working</CodexShimmerText>
            <LoadingResultsShimmer lines={3} />
            <LoadingPlaceholder className="h-10" />
            <NodexLogoShimmer />
          </div>,
        );
        try {
          expect(readLoadingAnimations(view.getByTestId("os-reduced-loaders"))).toEqual([]);
        } finally {
          view.unmount();
        }
      } finally {
        await setReducedMotion("no-preference");
      }
    });
  });
});
