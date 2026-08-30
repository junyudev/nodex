import type { AppRuntimeCapabilities } from "../../shared/runtime-capabilities";
import type { WindowSessionBootstrap } from "../lib/types";
import {
  invokeRendererControlThrough,
  invokeRendererQueryThrough,
  type RendererQueryControlPort,
} from "../lib/renderer-query-control";

/** Typed early-startup transport for the interval before RendererTransport is installed. */
export const startupOperations = {
  acknowledgeCloseFlush: async (
    bridge: RendererQueryControlPort,
    webContentsId: number,
  ): Promise<void> =>
    await invokeRendererControlThrough(bridge, "app:flush-before-close:done", webContentsId),

  readWindowSession: async (bridge: RendererQueryControlPort): Promise<WindowSessionBootstrap> =>
    await invokeRendererQueryThrough(bridge, "window-sessions:bootstrap"),

  readRuntimeCapabilities: async (
    bridge: RendererQueryControlPort,
  ): Promise<AppRuntimeCapabilities> =>
    await invokeRendererQueryThrough(bridge, "app:runtime-capabilities:get"),
};
