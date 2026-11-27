import { act, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent, cdp } from "vite-plus/test/browser";
import "../../../../globals.css";
import type { WorkspaceFileBinaryReadResult, WorkspaceFileRequest } from "@/lib/types";
import { installMotionPreferenceForTest, installWindowApi } from "@/test/browser-globals";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
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
  /** A one-color SVG picture whose bytes differ by `index`, so a sequence can be told apart. */
  const solidPicture = (index: number, width: number, height: number) =>
    btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#2876d${index}"/></svg>`,
    );
  // Five pictures: three show, a count stands for the last two, and one cannot be read.
  const imagePaths = [
    "/images/first.png",
    "/images/missing.png",
    "/images/second.svg",
    "/images/third.svg",
    "/images/fourth.svg",
  ];

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
    test("shows a step's pictures on its row and moves through all of them from the viewer", async () => {
      await page.viewport(900, 600);
      const restoreMotion = installMotionPreferenceForTest(true);
      // The pointer rests away from where the strip renders, so it engages only when pointed at.
      const away = document.createElement("div");
      away.style.cssText = "position:fixed;right:0;bottom:0;width:4px;height:4px";
      document.body.append(away);
      try {
        for (const theme of ["light", "dark"] as const) {
          applyRendererThemeForTest(theme);
          await act(async () => {
            await userEvent.hover(away);
          });
          let sourceExists = true;
          let releaseRead!: () => void;
          const readReady = new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
          const readFile = vi.fn(
            async (input: WorkspaceFileRequest): Promise<WorkspaceFileBinaryReadResult> => {
              await readReady;
              if (!sourceExists || input.path === imagePaths[1]) throw new Error("ENOENT");
              // Each picture reads as its own bytes, so the viewer's sequence can be told apart.
              const index = imagePaths.indexOf(input.path);
              return {
                contentsBase64: index === 0 ? png : solidPicture(index, 160, 90),
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
                <ImageViewSurface
                  images={imagePaths.map((source) => ({
                    source,
                    name: source.split("/").at(-1)!,
                  }))}
                />
              </ContentImageScopeProvider>
            </TestQueryProvider>,
          );
          try {
            // The row has nothing to open: its pictures are already on it.
            const row = view.getByTestId("image-view-activity");
            expect(within(row).getByText("Viewed 5 images")).toBeTruthy();
            expect(row.querySelector("[aria-expanded]")).toBeNull();

            const loading = await view.findAllByRole("status", { name: /^Loading / });
            expect(loading).toHaveLength(3);
            for (const tile of loading) expect(tile.getBoundingClientRect().height).toBe(20);
            await act(async () => {
              releaseRead();
              await readReady;
            });
            const failed = await view.findByRole("img", { name: "Image failed to load" });
            expect(failed.getBoundingClientRect().height).toBe(20);
            await waitFor(() => {
              expect(view.getAllByRole("button", { name: /^Open / })).toHaveLength(2);
            });
            const [first, second] = view.getAllByRole("button", { name: /^Open / });
            expect(first!.getAttribute("aria-label")).toBe("Open first.png");
            const firstImage = within(first!).getByRole<HTMLImageElement>("img");
            await decoded(firstImage, 1, 1);
            await decoded(within(second!).getByRole<HTMLImageElement>("img"), 160, 90);
            for (const trigger of [first!, second!]) {
              const bounds = trigger.getBoundingClientRect();
              expect(bounds.height).toBe(20);
              expect(bounds.width).toBeLessThanOrEqual(36);
            }
            expect(getComputedStyle(firstImage).objectFit).toBe("cover");
            const more = view.getByRole("button", { name: "2 more images" });
            expect(more.textContent).toBe("+2");
            expect(more.getBoundingClientRect().height).toBe(20);
            expect(view.queryByRole("button", { name: /retry/i })).toBeNull();
            // Pictures behind the count wait until the strip is pointed at.
            expect(readFile.mock.calls.map(([input]) => input.path)).toEqual(
              imagePaths.slice(0, 3),
            );
            await act(async () => {
              await userEvent.hover(more);
            });
            await waitFor(() => expect(readFile).toHaveBeenCalledTimes(imagePaths.length));
            expect(readFile.mock.calls.map(([input]) => input)).toEqual(
              imagePaths.map((path) => ({ hostId: "local", path })),
            );

            // The viewer shows the bytes its thumbnails already read, through every picture.
            await act(async () => {
              await userEvent.unhover(more);
            });
            sourceExists = false;
            const sources: string[] = [];
            await click(first!);
            const dialog = await view.findByRole("dialog", { name: "Image preview" });
            const shown = () => within(dialog).getByRole<HTMLImageElement>("img").src;
            sources.push(shown());
            for (let step = 0; step < 3; step += 1) {
              await press("{ArrowRight}");
              await waitFor(() => expect(shown()).not.toBe(sources.at(-1)));
              sources.push(shown());
            }
            expect(sources[0]).toBe(firstImage.src);
            expect(new Set(sources).size).toBe(4);
            expect(within(dialog).queryByRole("button", { name: "Next image" })).toBeNull();
            // Closing on a picture past the shown ones returns to the count that stands for it.
            await press("{Escape}");
            await waitFor(() => {
              expect(view.queryByRole("dialog", { name: "Image preview" })).toBeNull();
              expect(document.activeElement).toBe(more);
            });
            expect(readFile).toHaveBeenCalledTimes(imagePaths.length);
          } finally {
            releaseRead();
            view.unmount();
            client.clear();
          }
        }
      } finally {
        away.remove();
        restoreMotion();
      }
    });

    test("opens the first readable picture behind the count when the next one cannot be read", async () => {
      const paths = ["/a.svg", "/b.svg", "/c.svg", "/gone.png", "/d.svg"];
      const picture = (index: number) => solidPicture(index, 40, 30);
      installWindowApi({
        invoke: async (channel: string, input: WorkspaceFileRequest) => {
          if (channel !== "read-file-binary") throw new Error(`Unexpected query: ${channel}`);
          if (input.path === "/gone.png") throw new Error("ENOENT");
          return { contentsBase64: picture(paths.indexOf(input.path)) };
        },
        on: () => () => {},
      });
      const client = createTestQueryClient();
      const view = render(
        <TestQueryProvider client={client}>
          <ContentImageScopeProvider
            scope={{ ...THIS_COMPUTER_IMAGE_SCOPE, conversationId: "count", hostId: "local" }}
          >
            <ImageViewSurface images={paths.map((source) => ({ source }))} />
          </ContentImageScopeProvider>
        </TestQueryProvider>,
      );
      try {
        // Activated before the pictures behind it have read, the count opens the first that does.
        await click(view.getByRole("button", { name: "2 more images" }));
        const dialog = await view.findByRole("dialog", { name: "Image preview" });
        await waitFor(() =>
          expect(within(dialog).getByRole<HTMLImageElement>("img").src).toBe(
            `data:image/svg+xml;base64,${picture(4)}`,
          ),
        );
      } finally {
        view.unmount();
        client.clear();
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
