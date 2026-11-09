import { assert, it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import { make, turnNotification } from "./NodexEntryNotifications";
import { CoreModules } from "../core-runtime/CoreModules";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
const occurrence = {
  memberId: "member",
  pageId: "page",
  episode: "episode",
  title: "Review the change",
  body: "Checks passed",
  blocking: false,
};
it("applies preferences to episode notifications", () => {
  expect(turnNotification(occurrence, "off", true, false)).toBeNull();
  expect(turnNotification(occurrence, "unfocused", true, true)).toBeNull();
  expect(turnNotification({ ...occurrence, blocking: true }, "always", false, false)).toBeNull();
});
it.effect("claims once per current episode and opens the Inbox on click", () =>
  Effect.gen(function* () {
    let episode = "one";
    const claimed = new Set<string>();
    const shown: unknown[] = [];
    const clicks: unknown[] = [];
    let click: ((action: unknown) => void) | undefined;
    const service = yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: { kind: string }) =>
            Effect.succeed({
              value:
                input.kind === "inbox_turn_notifications"
                  ? {
                      kind: input.kind,
                      intents: [{ member_id: "member", page_id: "page", episode }],
                    }
                  : {
                      kind: "inbox_entry",
                      item: {
                        page_id: "page",
                        title: "Review",
                        body: "Passed",
                        turn: { turn: { episode, reason: "review" } },
                      },
                    },
            }),
          apply: () =>
            Effect.sync(() => {
              const duplicate = claimed.has(episode);
              claimed.add(episode);
              return { receipt: { duplicate }, outcome: { inbox_write: { replay: duplicate } } };
            }),
        },
      } as never),
      Effect.provideService(ApplicationSettings, {
        snapshot: () =>
          Effect.succeed({ notifications: { turnMode: "always", questionsEnabled: true } }),
      } as never),
      Effect.provideService(CodexRendererPresentationRegistry, {
        hasForegroundClient: () => false,
      } as never),
      Effect.provideService(WindowRuntime, {
        getLastFocused: () => ({
          isDestroyed: () => false,
          isMinimized: () => false,
          show: () => {},
          focus: () => {},
          webContents: { id: 1 },
        }),
      } as never),
      Effect.provideService(DesktopNotificationRuntime, {
        show: (payload: unknown, _target: unknown, handler: typeof click) => {
          shown.push(payload);
          click = handler;
        },
      } as never),
      Effect.provideService(RendererClientRuntime, {
        getClientIdForWebContentsId: () => "client",
        sendToClient: (_id: unknown, _channel: unknown, payload: unknown) => {
          clicks.push(payload);
          return true;
        },
      } as never),
    );
    yield* service.drain;
    yield* service.drain;
    assert.lengthOf(shown, 1);
    episode = "two";
    yield* service.drain;
    assert.lengthOf(shown, 2);
    click?.({ actionType: "open" });
  }),
);
