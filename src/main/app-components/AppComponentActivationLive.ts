import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AppComponentId } from "../../shared/app-components";
import { AppComponentActivation, type AppComponentActivator } from "./AppComponentActivation";
import { claudeCodeActivator } from "./activation/claude-code";
import { codexActivator } from "./activation/codex";
import { documentToolsActivator } from "./activation/document-tools";
import { desktopToolsActivator } from "./activation/desktop-tools";

// Each offered definition owns an Effect that acquires its activator and any process-local
// state. Build the registry once in Main; feature owners control what counts as active.
export const live = Layer.effect(
  AppComponentActivation,
  Effect.gen(function* () {
    const activators: Record<AppComponentId, AppComponentActivator> = {
      "desktop-tools": yield* desktopToolsActivator,
      "claude-code": yield* claudeCodeActivator,
      codex: yield* codexActivator,
      "document-tools": yield* documentToolsActivator,
    };
    return AppComponentActivation.of({
      activate: (id) => activators[id].activate,
      isActive: (id) => activators[id].isActive,
    });
  }),
);
