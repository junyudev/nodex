import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "../../shared/inbox";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { makeSpaceIpcCollector } from "./SpaceIpcCollector";
import { live } from "./RemoteMemberAttentionIpc";

/** The host's own Inbox settings, which differ from every default a desktop might show. */
const luna = {
  instanceId: "codex",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  serviceTier: null,
} as const;
const hostInbox: InboxSettings = {
  ...DEFAULT_INBOX_SETTINGS,
  dispatchMode: "act_on_requests",
  suggestions: "on_request",
  suggestionAgent: luna,
  chatAgent: luna,
  suggestionsChooseModels: false,
  useModelGuide: false,
};
/** The Space's execution owner, reached through Core's relay with the Member's authority. */
const host = (calls: string[] = []) =>
  Layer.succeed(
    CoreSessionAccess,
    CoreSessionAccess.of({
      handshake: Effect.die("No handshake is needed"),
      use: (_operation, run) =>
        Effect.promise((signal) =>
          run(
            {
              hostCall: async ({ operation }: { operation: string }) => {
                calls.push(operation);
                return { status: "ok", value: hostInbox };
              },
            } as never,
            signal,
          ),
        ),
    }),
  );

it.effect("reads the host's Inbox settings and keeps only the Member's consent in Core", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const collector = makeSpaceIpcCollector({ routes: () => true });
      let consent: boolean | null = null;
      const writes: unknown[] = [];
      const hostCalls: string[] = [];
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
          Layer.provide(host(hostCalls)),
          Layer.provide(
            Layer.succeed(CoreModules, {
              workspace: {
                read: () =>
                  Effect.succeed({
                    value: { kind: "inbox_routing_consent", start_my_requests: consent },
                  }),
                apply: (input: { intent: { start_my_requests: boolean } }) =>
                  Effect.sync(() => {
                    writes.push(input.intent);
                    consent = input.intent.start_my_requests;
                  }),
              },
            } as never),
          ),
          Layer.provide(Layer.succeed(ProjectWorkspace, {} as never)),
        ),
      );
      const event = {} as IpcMainInvokeEvent;
      // Everything the Inbox runs on is the host's; the Member has not consented yet.
      expect(yield* collector.invoke("settings:inbox:get", event, [])).toEqual({
        ...hostInbox,
        dispatchMode: "suggest",
      });
      expect(hostCalls).toEqual(["inbox_settings"]);
      expect(writes).toEqual([
        { kind: "set_inbox_routing_consent", start_my_requests: false, initialize_only: true },
      ]);
      expect(
        yield* collector.invoke("settings:inbox:update", event, [
          { dispatchMode: "act_on_requests" },
        ]),
      ).toMatchObject({ dispatchMode: "act_on_requests" });
      expect(consent).toBe(true);
      expect(yield* collector.invoke("settings:inbox:get", event, [])).toMatchObject({
        dispatchMode: "act_on_requests",
      });
      const denied = yield* collector
        .invoke("settings:inbox:update", event, [{ suggestions: "off" }])
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      expect(consent).toBe(true);
      expect(writes).toHaveLength(2);
    }),
  ),
);

it.effect("keeps a Member's pins, pin order and reminders in the Space's Core, as their own", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const collector = makeSpaceIpcCollector({ routes: () => true });
      const calls: [string, unknown][] = [];
      const apply = { status: "no_op", observed: { store_epoch: "epoch", commit_seq: 4 } };
      const record = (method: string) => (command: unknown) =>
        Effect.sync(() => {
          calls.push([method, command]);
          return { value: { id: "chat" }, apply };
        });
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
          Layer.provide(host()),
          Layer.provide(Layer.succeed(CoreModules, {} as never)),
          Layer.provide(
            Layer.succeed(ProjectWorkspace, {
              markProjectSessionUnread: record("unread"),
              setProjectSessionPinned: record("pin"),
              setPinnedProjectSessionOrder: record("order"),
              setProjectSessionReminder: record("reminder"),
              ensureDefaultDraftProjectSession: record("draft"),
            } as never),
          ),
        ),
      );
      const event = {} as IpcMainInvokeEvent;
      const operationId = createBoundedOperationId("test.attention");
      const pin = { operationId, payload: { sessionId: "chat", pinned: true } };
      const order = { operationId, payload: { projectId: "p", sessionIds: [] } };
      const reminder = {
        operationId,
        payload: { sessionId: "chat", remindAt: "2026-11-09T09:00:00.000Z" },
      };
      // A New chat opens the Member's own default draft in the Space's Core.
      const draft = { operationId, payload: { projectId: null, candidateSessionId: "draft" } };
      for (const [channel, command] of [
        ["project-sessions:set-pinned", pin],
        ["project-sessions:set-pinned-order", order],
        ["project-sessions:set-reminder", reminder],
        ["project-sessions:ensure-default-draft", draft],
      ] as const)
        expect(yield* collector.invoke(channel, event, [command])).toMatchObject({
          ok: true,
          value: { id: "chat" },
        });
      expect(calls).toEqual([
        ["pin", pin],
        ["order", order],
        ["reminder", reminder],
        ["draft", draft],
      ]);
      const malformed = yield* collector
        .invoke("project-sessions:set-pinned", event, [{ ...pin, operationId: "" }])
        .pipe(Effect.result);
      expect(malformed._tag).toBe("Failure");
      expect(calls).toHaveLength(4);
    }),
  ),
);
