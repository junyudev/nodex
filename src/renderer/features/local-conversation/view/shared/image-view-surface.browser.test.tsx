import { act, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../../../../globals.css";
import type { WorkspaceFileBinaryReadResult, WorkspaceFileRequest } from "@/lib/types";
import { installMotionPreferenceForTest, installWindowApi } from "@/test/browser-globals";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { ConversationImageAssetProvider } from "../conversation-image-asset-context";
import { ImageViewSurface } from "./image-view-surface";

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
            <ConversationImageAssetProvider conversationId={`images-${theme}`} hostId="local">
              <ImageViewSurface imagePaths={imagePaths} />
            </ConversationImageAssetProvider>
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
          let preview = within(dialog).getByRole<HTMLImageElement>("img");
          await decoded(preview, 1, 1);
          expect(preview.src).toBe(firstSrc);
          await press("{ArrowRight}");
          await waitFor(() => {
            dialog = view.getByRole("dialog", { name: "Image preview" });
            preview = within(dialog).getByRole<HTMLImageElement>("img");
            expect(preview.src).toBe(secondSrc);
          });
          await decoded(preview, 160, 90);
          await press("{ArrowLeft}");
          await waitFor(() => {
            dialog = view.getByRole("dialog", { name: "Image preview" });
            expect(within(dialog).getByRole<HTMLImageElement>("img").src).toBe(firstSrc);
          });
          await press("{Escape}");
          await waitFor(() => {
            expect(view.queryByRole("dialog", { name: "Image preview" })).toBeNull();
            expect(document.activeElement).toBe(triggers[0]);
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
