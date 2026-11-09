import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopNotificationPayload, ThreadNotificationTurnMode } from "../../shared/types";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";

  mode: ThreadNotificationTurnMode,
  foreground: boolean,
): DesktopNotificationPayload | null => {
    return null;
  return {
    kind: "nodex",
    actions: [{ id: "open", title: "Open", actionType: "open" }],
  };
};
