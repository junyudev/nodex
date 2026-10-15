import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentBackendHistoryReadInput } from "../../../shared/agent-backend-api";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { AgentBackendIpcError, live } from "./AgentBackendIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  value: unknown,
) => Effect.Effect<unknown, AgentBackendIpcError>;
it.effect(
  "bounded native history IPC verifies the owning renderer and rejects malformed pages",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const reads: AgentBackendHistoryReadInput[] = [];
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      const application = {
        readAgentHistory: (input: AgentBackendHistoryReadInput) =>
          Effect.sync(() => {
            reads.push(input);
            return { sessionId: "native", status: "closed", turns: [] };
          }),
      } as unknown as AgentBackendApplication["Service"];
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AgentBackendApplication, application),
              Layer.succeed(ElectronIpc, ipc),
              mainConfigLayer(),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 77,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );
      const frame = { url: "app://-/index.html" };
      const sender = Object.assign(new EventEmitter(), {
        id: 77,
        getType: () => "window",
        isDestroyed: () => false,
        mainFrame: frame,
      });
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
      const read = handlers.get("agent-backend:session:history")!;
      const input = { threadId: "attached", before: "older", limit: 50 };
      assert.deepEqual(yield* read(event, input), {
        sessionId: "native",
        status: "closed",
        turns: [],
      });
      assert.deepEqual(reads, [input]);
      for (const invalid of [
        { ...input, limit: 0 },
        { ...input, limit: 51 },
        { ...input, limit: 2.5 },
        { ...input, before: "" },
        { ...input, before: "x".repeat(8193) },
        { ...input, cwd: "/forged" },
        { ...input, sessionId: "foreign" },
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(read(event, invalid))));
      const childFrame = { url: frame.url };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            read({ ...event, senderFrame: childFrame } as IpcMainInvokeEvent, input),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            read(
              {
                ...event,
                sender: Object.assign(new EventEmitter(), {
                  id: 99,
                  mainFrame: frame,
                  getType: () => "window",
                  isDestroyed: () => false,
                }),
              } as IpcMainInvokeEvent,
              input,
            ),
          ),
        ),
      );
      assert.lengthOf(reads, 1);
      yield* Scope.close(scope, Exit.void);
      assert.equal(handlers.size, 0);
    }),
);
