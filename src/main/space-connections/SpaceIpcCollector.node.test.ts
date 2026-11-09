import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import { layer as callbacks } from "../app/ScopedCallbackRuntime";
import { CoreModules } from "../core-runtime/CoreModules";
import * as ChatMemberActionsIpc from "../ipc/handlers/ChatMemberActionsIpc";
import { ElectronIpc, ElectronSpaceIpc, live } from "../platform/electron/ElectronIpc";
import { makeSpaceIpcCollector } from "./SpaceIpcCollector";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const event = {
  sender: Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false }),
} as unknown as IpcMainInvokeEvent;

/** A Space's Core answering who may edit or stop each Run, and whom it answered. */
const spaceCore = (member: string) =>
  Layer.succeed(CoreModules, {
    workspace: {
      read: (request: { readonly kind: string; readonly run_ids: readonly string[] }) =>
        Effect.succeed({
          value: {
            kind: request.kind,
            actions: {
              runs: request.run_ids.map((run_id) => ({
                run_id,
                edit: member === "team" ? "available" : "unavailable",
                can_stop: true,
              })),
            },
          },
        }),
    },
  } as unknown as CoreModules["Service"]);

/** This process's Electron routes with Space dispatch: the team Space's calls reach its graph. */
const routedProcess = Effect.fn("routedProcess")(function* (scope: Scope.Scope) {
  const context = yield* Layer.buildWithScope(live.pipe(Layer.provide(callbacks)), scope);
  const process = Context.get(context, ElectronIpc);
  const routing = Context.get(context, ElectronSpaceIpc);
  const team = makeSpaceIpcCollector(routing);
  yield* routing
    .configure(({ channel, event, request, personal }) => {
      const { spaceId, args } = request as { spaceId: string; args: readonly unknown[] };
      return spaceId === "team" ? team.invoke(channel, event, args) : personal(args);
    })
    .pipe(Effect.provideService(Scope.Scope, scope));
  return { process, routing, team };
});

it.effect("a team window's chat actions reach its Space through the process route", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { process, team } = yield* routedProcess(scope);
    // The personal graph routes the channel for every window; the team graph serves its Space.
    yield* Layer.buildWithScope(
      ChatMemberActionsIpc.live.pipe(
        Layer.provide(Layer.succeed(ElectronIpc, process)),
        Layer.provide(spaceCore("personal")),
      ),
      scope,
    );
    yield* Layer.buildWithScope(
      ChatMemberActionsIpc.live.pipe(
        Layer.provide(Layer.succeed(ElectronIpc, team.ipc)),
        Layer.provide(spaceCore("team")),
      ),
      scope,
    );
    const route = handlers.get("agent-runtime:session:member-actions");
    expect(route).toBeDefined();
    const read = (spaceId: string) =>
      Effect.promise(() =>
        route!(event, { spaceId, args: [{ sessionId: "session", runIds: ["run"] }] }),
      );
    expect(yield* read("team")).toEqual({
      runs: [{ run_id: "run", edit: "available", can_stop: true }],
    });
    expect(yield* read("personal")).toEqual({
      runs: [{ run_id: "run", edit: "unavailable", can_stop: true }],
    });
    yield* Scope.close(scope, Exit.void);
    expect(handlers.has("agent-runtime:session:member-actions")).toBe(false);
  }),
);

it.effect("a Space cannot serve a channel no window can reach", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { routing, team } = yield* routedProcess(scope);
    expect(routing.routes("agent-runtime:session:member-actions")).toBe(false);
    const exit = yield* Layer.buildWithScope(
      ChatMemberActionsIpc.live.pipe(
        Layer.provide(Layer.succeed(ElectronIpc, team.ipc)),
        Layer.provide(spaceCore("team")),
      ),
      scope,
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "No window can reach agent-runtime:session:member-actions",
    );
    yield* Scope.close(scope, Exit.void);
  }),
);
