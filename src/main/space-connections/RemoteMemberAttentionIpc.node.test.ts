import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { CoreModules } from "../core-runtime/CoreModules";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { makeSpaceIpcCollector } from "./SpaceIpcCollector";
import { live } from "./RemoteMemberAttentionIpc";

  Effect.scoped(
    Effect.gen(function* () {
      let consent: boolean | null = null;
      const writes: unknown[] = [];
      yield* Layer.build(
        live.pipe(
          Layer.provide(Layer.succeed(ElectronIpc, collector.ipc)),
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
        dispatchMode: "suggest",
      });
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
          Layer.provide(Layer.succeed(CoreModules, {} as never)),
          Layer.provide(
            Layer.succeed(ProjectWorkspace, {
              markProjectSessionUnread: record("unread"),
              setProjectSessionPinned: record("pin"),
              setPinnedProjectSessionOrder: record("order"),
              setProjectSessionReminder: record("reminder"),
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
      for (const [channel, command] of [
        ["project-sessions:set-pinned", pin],
        ["project-sessions:set-pinned-order", order],
        ["project-sessions:set-reminder", reminder],
      ] as const)
        expect(yield* collector.invoke(channel, event, [command])).toMatchObject({
          ok: true,
          value: { id: "chat" },
        });
      expect(calls).toEqual([
        ["pin", pin],
        ["order", order],
        ["reminder", reminder],
      ]);
      const malformed = yield* collector
        .invoke("project-sessions:set-pinned", event, [{ ...pin, operationId: "" }])
        .pipe(Effect.result);
      expect(malformed._tag).toBe("Failure");
    }),
  ),
);
