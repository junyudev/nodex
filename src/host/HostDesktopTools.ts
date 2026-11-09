import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AgentRuntimeDesktopTools } from "../main/agent-runtime/AgentRuntimeDesktopTools";

/** Optional desktop capabilities; a headless host never advertises Browser or Computer Use. */
export class HostDesktopTools extends Context.Service<HostDesktopTools, AgentRuntimeDesktopTools>()(
  "nodex/host/HostDesktopTools",
) {}

export const headless = Layer.succeed(HostDesktopTools, {
  desktopTools: Effect.succeed(null),
  threadConfig: () => Effect.succeed({}),
  observeNativeTurn: () => Effect.void,
  releaseSession: () => Effect.void,
});
