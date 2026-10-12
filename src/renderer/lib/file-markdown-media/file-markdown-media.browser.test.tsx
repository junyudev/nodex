import { describe, expect, test, vi } from "vite-plus/test";
import { render, waitFor } from "@testing-library/react";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { TestQueryProvider } from "@/test/query";
import { installWindowApi } from "@/test/browser-globals";
import { NodexTooltipProvider } from "@/components/ui/tooltip";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A 2x candidate needs two physical pixels for a one-pixel density-corrected intrinsic size.
const PNG_2X =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";

describe("file Markdown image decoding in Chromium", () => {
  test("decodes host-owned bytes and lets picture select only rewritten candidates", async () => {
    const calls: unknown[][] = [];
    const revoked = vi.spyOn(URL, "revokeObjectURL");
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push([channel, ...args]);
        if (channel === "read-file-metadata")
          return { isFile: true, sizeBytes: null, createdAtMs: null, mtimeMs: null };
        if (channel === "read-file-binary") {
          const input = args[0];
          const wide =
            typeof input === "object" &&
            input !== null &&
            "path" in input &&
            input.path === "/repo/wide.png";
          return { contentsBase64: wide ? PNG_2X : PNG, mimeType: "image/png" };
        }
        return null;
      },
    });
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <MarkdownRenderer
            fileMediaScope={{ hostId: "remote-images", sourceFilePath: "/repo/docs/README.md" }}
            content={`![Relative](./relative.png)

<picture><source srcset="app://fs/@fs/tmp/local-sentinel.png 1x, ../wide.png 2x"><img src="app://fs/@fs/tmp/blocked-fallback.png" alt="Picture"></picture>`}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    try {
      const relative = view.getByAltText("Relative") as HTMLImageElement;
      const picture = view.getByAltText("Picture") as HTMLImageElement;
      await waitFor(() => expect(relative.naturalWidth).toBe(1));
      const source = view.container.querySelector("source")!;
      await waitFor(() => expect(source.srcset).toMatch(/^blob:.+ 2x$/));
      await waitFor(() => expect(picture.currentSrc).toBe(source.srcset.slice(0, -3)));
      await picture.decode();
      const bitmap = await createImageBitmap(await (await fetch(picture.currentSrc)).blob());
      try {
        expect([bitmap.width, bitmap.height]).toEqual([2, 2]);
      } finally {
        bitmap.close();
      }
      expect(picture.isConnected).toBe(true);
      expect(picture).toBe(view.getByAltText("Picture"));
      expect(picture.complete).toBe(true);
      expect(revoked).not.toHaveBeenCalled();
      await waitFor(() => expect(picture.naturalWidth).toBe(1));
      expect(picture.naturalHeight).toBe(1);
      expect(calls.filter(([channel]) => channel === "read-file-binary")).toEqual(
        expect.arrayContaining([
          ["read-file-binary", { hostId: "remote-images", path: "/repo/docs/relative.png" }],
          ["read-file-binary", { hostId: "remote-images", path: "/repo/wide.png" }],
        ]),
      );
      expect(source.srcset).not.toContain("sentinel");
      expect(picture.getAttribute("src")).toBeNull();
    } finally {
      view.unmount();
      revoked.mockRestore();
    }
  });
});
