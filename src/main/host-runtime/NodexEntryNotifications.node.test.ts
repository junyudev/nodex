import { CoreAuthority } from "../core-runtime/CoreAuthority";
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
  spaceId: "personal",
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
  expect(turnNotification(occurrence, "always", true, false)?.id).toBe(
    JSON.stringify(["turn", "personal", "member", "page", "episode"]),
  );
  expect(turnNotification({ ...occurrence, spaceId: "team" }, "always", true, false)?.id).not.toBe(
    turnNotification(occurrence, "always", true, false)?.id,
  );
});
it.effect("claims Turn and Later intents once and opens each Inbox message on click", () =>
  Effect.gen(function* () {
    let episode = "one";
    const claimed = new Set<string>();
    const later = {
      id: "returned",
      member_id: "member",
      page_id: "later-page",
      title: "Renew the certificate",
      returned_at: "2026-11-12T09:00:00Z",
    };
    const shown: unknown[] = [];
    const clicks: unknown[] = [];
    const clickHandlers: ((action: unknown) => void)[] = [];
    const service = yield* make.pipe(
      Effect.provideService(CoreAuthority, {
        identity: { libraryId: "personal" },
      } as CoreAuthority["Service"]),
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: { kind: string }) =>
            Effect.succeed({
              value:
                input.kind === "inbox_later_notifications"
                  ? { kind: input.kind, intents: [later] }
                  : input.kind === "inbox_turn_notifications"
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
          apply: (input: { intent: { kind: string } }) =>
            Effect.sync(() => {
              const id =
                input.intent.kind === "claim_inbox_later_notification" ? later.id : episode;
              const duplicate = claimed.has(id);
              claimed.add(id);
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
        show: (payload: unknown, _target: unknown, handler: (action: unknown) => void) => {
          shown.push(payload);
          clickHandlers.push(handler);
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
    assert.lengthOf(shown, 2);
    expect(shown[0]).toMatchObject({
      title: later.title,
      body: "Back in your Inbox",
    });
    episode = "two";
    yield* service.drain;
    assert.lengthOf(shown, 3);
    clickHandlers[0]?.({ actionType: "open" });
    expect(clicks[0]).toMatchObject({
      spaceId: "personal",
      inboxEntry: { pageId: later.page_id, scope: { kind: "all" } },
    });
    expect(clicks[0]).not.toHaveProperty("inboxEntry.turnEpisode");
    clickHandlers[2]?.({ actionType: "open" });
    expect(clicks[1]).toMatchObject({
      spaceId: "personal",
      inboxEntry: { pageId: "page", scope: { kind: "all" } },
    });
  }),
);
