import { describe, expect, test } from "bun:test";
import { resolveRendererManualChunk } from "./renderer-manual-chunks";

describe("resolveRendererManualChunk", () => {
  test("isolates streamdown entry packages", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/@streamdown/code/dist/index.js",
      ),
    ).toBe("vendor-streamdown");
    expect(
      resolveRendererManualChunk(
        "C:\\repo\\nodex\\node_modules\\streamdown\\dist\\index.js",
      ),
    ).toBe("vendor-streamdown");
  });

  test("groups editor dependencies together", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/@blocknote/core/dist/index.js",
      ),
    ).toBe("vendor-blocknote");
  });

  test("groups canvas dependencies together", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/@excalidraw/excalidraw/dist/prod/index.js",
      ),
    ).toBe("vendor-excalidraw");
  });

  test("groups graph dependencies together", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/cytoscape/dist/cytoscape.esm.mjs",
      ),
    ).toBe("vendor-cytoscape");
  });

  test("keeps local application modules in the entry graph", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/src/renderer/components/workbench/stage-threads/markdown/markdown-core.tsx",
      ),
    ).toBe(undefined);
  });
});
