import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopNotificationPayload, ThreadNotificationTurnMode } from "../../shared/types";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";

export const turnNotification = (
  input: {
    memberId: string;
    pageId: string;
    episode: string;
    title: string;
    body: string;
    blocking: boolean;
  },
  mode: ThreadNotificationTurnMode,
  requestEnabled: boolean,
  foreground: boolean,
): DesktopNotificationPayload | null => {
  if (
    input.blocking
      ? !requestEnabled || foreground
      : mode === "off" || (mode === "unfocused" && foreground)
  )
    return null;
  return {
    kind: "nodex",
    title: input.title,
    body: input.body,
    actions: [{ id: "open", title: "Open", actionType: "open" }],
  };
};
            {
              pageId: intent.page_id,
            },
  }),
);
