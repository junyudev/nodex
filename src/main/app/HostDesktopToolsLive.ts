import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostDesktopTools } from "../../host/HostDesktopTools";
import { make } from "../agent-runtime/AgentRuntimeDesktopTools";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";

export const live = Layer.effect(
  HostDesktopTools,
  Effect.gen(function* () {
    return make({
      pip: yield* RemoteHostedPipRuntime,
      tools: yield* DesktopToolRuntime,
      browserUse: yield* BrowserUseRuntime,
      windows: yield* WindowRuntime,
      presentation: yield* CodexTurnPresentation,
    });
  }),
);
