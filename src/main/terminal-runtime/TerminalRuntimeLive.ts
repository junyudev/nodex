import * as Layer from "effect/Layer";
import * as TerminalEnvironment from "../platform/node/TerminalEnvironment";
import * as TerminalProcessMetrics from "../platform/node/TerminalProcessMetrics";
import * as TerminalPty from "../platform/node/TerminalPty";
import * as TerminalRuntimeMap from "./TerminalRuntimeMap";
import * as TerminalSessions from "./TerminalSessions";

const runtimeMap = TerminalRuntimeMap.live.pipe(Layer.provide(TerminalPty.live));

/**
 * Complete process-scoped Terminal graph. ACP client callbacks and desktop Terminal sessions share
 * one RuntimeMap, so a child process cannot outlive the same process-scoped owner used by the UI.
 */
export const live: Layer.Layer<
  TerminalSessions.TerminalSessions | TerminalRuntimeMap.TerminalRuntimeMap
> = TerminalSessions.live.pipe(
  Layer.provideMerge(
    Layer.mergeAll(TerminalEnvironment.live, TerminalProcessMetrics.live, runtimeMap),
  ),
);
