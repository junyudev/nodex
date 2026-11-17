import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ElectronIpc } from "../platform/electron/ElectronIpc";
import {
  findHitKey,
  findPhaseSchema,
  findRequestSchema,
  type makeFindService,
} from "./FindService";

export const registerFindRequests = (
  ipc: ElectronIpc["Service"],
  search: ReturnType<typeof makeFindService<never>>,
  authorize: (event: IpcMainInvokeEvent) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const pending = new Map<string, Deferred.Deferred<void>>();
    const instantOrder = new Map<string, { input: string; ids: readonly string[] }>();
    const requestKey = (event: IpcMainInvokeEvent, requestId: string) =>
      `${event.sender.id}:${requestId}`;

    yield* ipc.handleQuery("find:search", (event, input, phase, requestId) =>
      Effect.gen(function* () {
        yield* authorize(event);
        const [request, parsedPhase] = yield* Effect.try(
          () => [findRequestSchema.parse(input), findPhaseSchema.parse(phase)] as const,
        );
        if (requestId === undefined) return yield* search(request, parsedPhase);
        if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128)
          return yield* Effect.fail(new Error("Invalid Find request identity"));
        const key = requestKey(event, requestId);
        if (pending.has(key))
          return yield* Effect.fail(new Error("Find request is already active"));
        const cancel = Deferred.makeUnsafe<void>();
        pending.set(key, cancel);
        const inputKey = JSON.stringify(request);
        const previous = instantOrder.get(key);
        instantOrder.delete(key);
        const response = yield* search(
          request,
          parsedPhase,
          parsedPhase === "complete" && previous?.input === inputKey ? previous.ids : undefined,
        ).pipe(
          Effect.raceFirst(
            Deferred.await(cancel).pipe(Effect.andThen(Effect.fail(new Error("Find cancelled")))),
          ),
          Effect.ensuring(Effect.sync(() => pending.delete(key))),
        );
        if (parsedPhase === "instant") {
          if (instantOrder.size >= 256) {
            const oldest = instantOrder.keys().next();
            if (!oldest.done) instantOrder.delete(oldest.value);
          }
          instantOrder.set(key, { input: inputKey, ids: response.hits.map(findHitKey) });
        }
        return response;
      }),
    );
    yield* ipc.handleControl("find:cancel", (event, requestId) =>
      authorize(event).pipe(
        Effect.flatMap(() => {
          const key = requestKey(event, requestId);
          instantOrder.delete(key);
          const cancel = pending.get(key);
          return cancel ? Deferred.succeed(cancel, undefined) : Effect.succeed(false);
        }),
      ),
    );
  });
