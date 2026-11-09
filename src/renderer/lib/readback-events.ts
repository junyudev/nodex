import type { ReadbackEvent } from "../../shared/readback";
import { resolveRendererTransport } from "./renderer-transport";

/** The window owns Readback presentation and its dismissal timer. */
export const subscribeReadbackEvents = (listener: (event: ReadbackEvent) => void): (() => void) =>
  resolveRendererTransport().subscribeReadbackEvents(listener);
