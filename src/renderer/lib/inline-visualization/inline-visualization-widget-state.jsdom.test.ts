import { describe, expect, test, vi } from "vite-plus/test";
import {
  createInlineVisualizationStateUpdateHandler,
  resolveInlineVisualizationStateIdentity,
} from "./inline-visualization-widget-state";
import type { InlineVisualizationWidgetStateOwner } from "./inline-visualization-widget-state";

const identity = { hostId: "local", threadId: "display", path: "/raw/plot.html" };
const owner = (): InlineVisualizationWidgetStateOwner => ({
  identity,
  read: vi.fn(async () => null),
  write: vi.fn<InlineVisualizationWidgetStateOwner["write"]>(async (value) => ({
    ok: true,
    revision: 1,
    value,
  })),
});

describe("file widget state admission", () => {
  test("keeps absolute attributes as the API path and uses resolved paths only for bare files", () => {
    expect(
      resolveInlineVisualizationStateIdentity({
        ...identity,
        file: "/var/plot.html",
        resolvedPath: "/private/var/plot.html",
      }),
    ).toEqual({ ...identity, path: "/var/plot.html" });
    expect(
      resolveInlineVisualizationStateIdentity({
        ...identity,
        file: "plot.html",
        resolvedPath: "/owned/plot.html",
      }),
    ).toEqual({ ...identity, path: "/owned/plot.html" });
    expect(
      resolveInlineVisualizationStateIdentity({
        ...identity,
        file: "plot.html",
        resolvedPath: null,
      }),
    ).toBeNull();
  });
  test("admits only the fixed widget and normalizes legal state before the semantic write", async () => {
    const stateOwner = owner();
    const controller = new AbortController();
    const handler = createInlineVisualizationStateUpdateHandler({
      owner: stateOwner,
      widgetId: identity.path,
      signal: controller.signal,
    });
    expect(await handler("forged", { selected: 3 })).toEqual({ ok: false, retryable: false });
    expect(await handler(identity.path, { imageIds: ["unsupported"] })).toMatchObject({
      ok: false,
      code: "images_unsupported",
    });
    expect(stateOwner.write).not.toHaveBeenCalled();
    expect(await handler(identity.path, { selected: 3 })).toBeUndefined();
    expect(stateOwner.write).toHaveBeenCalledWith({
      modelContent: null,
      privateContent: null,
      selected: 3,
    });
    controller.abort();
    expect(await handler(identity.path, { selected: 4 })).toEqual({ ok: false, retryable: false });
    expect(stateOwner.write).toHaveBeenCalledOnce();
  });
  test("returns explicit persistence failure and rejects disabled interactions", async () => {
    const stateOwner = owner();
    vi.mocked(stateOwner.write).mockRejectedValueOnce(new Error("Storage unavailable"));
    let enabled = true;
    const handler = createInlineVisualizationStateUpdateHandler({
      owner: stateOwner,
      widgetId: identity.path,
      signal: new AbortController().signal,
      allowInteractions: () => enabled,
    });
    expect(await handler(identity.path, {})).toEqual({
      ok: false,
      code: "storage_unavailable",
      retryable: false,
    });
    enabled = false;
    expect(await handler(identity.path, {})).toEqual({ ok: false, retryable: false });
    expect(stateOwner.write).toHaveBeenCalledOnce();
  });
});
