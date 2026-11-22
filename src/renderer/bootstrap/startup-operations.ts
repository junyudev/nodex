import type { LanguageSettings } from "../../shared/i18n/locales";
import {
  invokeRendererControlThrough,
  invokeRendererQueryThrough,
  type RendererQueryControlPort,
} from "../lib/renderer-query-control";

/** Typed early-startup transport for the interval before RendererTransport is installed. */
export const startupOperations = {
  readLanguageSettings: async (bridge: RendererQueryControlPort): Promise<LanguageSettings> =>
    await invokeRendererQueryThrough(bridge, "settings:language:get"),

  acknowledgeCloseFlush: async (
    bridge: RendererQueryControlPort,
    webContentsId: number,
  ): Promise<void> =>
    await invokeRendererControlThrough(bridge, "app:flush-before-close:done", webContentsId),
};
