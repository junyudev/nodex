import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { AcpInputSchemas } from "../../../shared/schemas/acp-api";
import { AcpAgents, AcpAgentsError } from "../../acp-agents/AcpAgents";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import type { AcpOperations, AcpResult } from "../../../shared/acp-api";
import { AgentRuntimeProcessError } from "../../platform/node/AgentRuntimeProcess";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* AcpAgents;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const callbacks = yield* ScopedCallbackRuntime;
    const observedCompletions = new Set<string>();
    const changed = Effect.sync(() =>
      safeBroadcastToWindows(windows.all(), "agent-settings-changed", [undefined]),
    );
    const completed = (id: string, phase: string) =>
      Effect.gen(function* () {
        if (phase !== "succeeded" || observedCompletions.has(id)) return;
        if (observedCompletions.size >= 256) observedCompletions.clear();
        observedCompletions.add(id);
        yield* changed;
      });
    const operationCompleted = (
      event: IpcMainInvokeEvent,
      result: AcpResult<AcpOperations["acp.operation.read"]["output"]>,
    ) =>
      result.ok
        ? completed(`operation:${event.sender.id}:${result.value.operationId}`, result.value.phase)
        : Effect.void;
    const authenticationCompleted = (
      result: AcpResult<AcpOperations["acp.auth.read"]["output"]>,
    ) =>
      result.ok
        ? completed(`auth:${result.value.instanceId}:${result.value.flowId}`, result.value.phase)
        : Effect.void;
    const owners = new Map<
      number,
      {
        readonly id: string;
        readonly sender: IpcMainInvokeEvent["sender"];
        readonly dispose: () => void;
      }
    >();
    const owner = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          )
            throw new Error("ACP management requires an active Nodex window.");
          const existing = owners.get(event.sender.id);
          if (existing) return existing.id;
          const id = randomUUID();
          const dispose = () => {
            owners.delete(event.sender.id);
            event.sender.removeListener("destroyed", dispose);
            event.sender.removeListener("render-process-gone", dispose);
            callbacks.fork(agents.releaseOwner(id));
          };
          owners.set(event.sender.id, { id, sender: event.sender, dispose });
          event.sender.once("destroyed", dispose);
          event.sender.once("render-process-gone", dispose);
          return id;
        },
        catch: () =>
          new AcpAgentsError({ message: "ACP management requires an active Nodex window." }),
      });
    const handle = <Input, Output>(
      event: IpcMainInvokeEvent,
      schema: z.ZodType<Input>,
      value: unknown,
      execute: (ownerId: string, input: Input) => Effect.Effect<Output, unknown>,
    ) =>
      Effect.gen(function* () {
        const ownerId = yield* owner(event);
        const input = yield* Effect.try({
          try: () => schema.parse(value),
          catch: () => new AcpAgentsError({ message: "Invalid ACP management input." }),
        });
        return yield* execute(ownerId, input);
      }).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((cause) =>
          agents
            .presentFailure(
              cause instanceof AgentRuntimeProcessError && cause.acp
                ? cause.acp
                : cause instanceof AcpAgentsError
                  ? { reason: cause.reason ?? "invalid_request", message: cause.message }
                  : {
                      reason: "invalid_request",
                      message: "The Agent operation could not be completed.",
                    },
            )
            .pipe(Effect.map((error) => ({ ok: false as const, error }))),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...owners.values()],
        (entry) =>
          Effect.gen(function* () {
            entry.sender.removeListener("destroyed", entry.dispose);
            entry.sender.removeListener("render-process-gone", entry.dispose);
            yield* agents.releaseOwner(entry.id);
          }),
        { discard: true },
      ),
    );
    yield* ipc.handleQuery("acp:registry:search", (event, input) =>
      handle(event, AcpInputSchemas["acp.registry.search"], input, agents["acp.registry.search"]),
    );
    yield* ipc.handleQuery("acp:inspect", (event, input) =>
      handle(event, AcpInputSchemas["acp.inspect"], input, agents["acp.inspect"]),
    );
    yield* ipc.handleQuery("acp:install:preview", (event, input) =>
      handle(event, AcpInputSchemas["acp.install.preview"], input, agents["acp.install.preview"]),
    );
    yield* ipc.handleQuery("acp:operation:read", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.operation.read"],
        input,
        agents["acp.operation.read"],
      ).pipe(Effect.tap((result) => operationCompleted(event, result))),
    );
    yield* ipc.handleQuery("acp:auth:read", (event, input) =>
      handle(event, AcpInputSchemas["acp.auth.read"], input, agents["acp.auth.read"]).pipe(
        Effect.tap(authenticationCompleted),
      ),
    );
    yield* ipc.handleQuery("acp:sessions:list", (event, input) =>
      handle(event, AcpInputSchemas["acp.sessions.list"], input, agents["acp.sessions.list"]),
    );
    yield* ipc.handleQuery("acp:modelProviders:list", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.modelProviders.list"],
        input,
        agents["acp.modelProviders.list"],
      ),
    );
    yield* ipc.handlePlainCommand("acp:install:start", (event, input) =>
      handle(event, AcpInputSchemas["acp.install.start"], input, agents["acp.install.start"]).pipe(
        Effect.tap((result) => operationCompleted(event, result)),
      ),
    );
    yield* ipc.handlePlainCommand("acp:registry:uninstall", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.registry.uninstall"],
        input,
        agents["acp.registry.uninstall"],
      ).pipe(Effect.tap((result) => (result.ok ? changed : Effect.void))),
    );
    yield* ipc.handlePlainCommand("acp:connection:start", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.connection.start"],
        input,
        agents["acp.connection.start"],
      ).pipe(Effect.tap((result) => operationCompleted(event, result))),
    );
    yield* ipc.handlePlainCommand("acp:operation:cancel", (event, input) =>
      handle(event, AcpInputSchemas["acp.operation.cancel"], input, agents["acp.operation.cancel"]),
    );
    yield* ipc.handlePlainCommand("acp:auth:start", (event, input) =>
      handle(event, AcpInputSchemas["acp.auth.start"], input, agents["acp.auth.start"]).pipe(
        Effect.tap(authenticationCompleted),
      ),
    );
    yield* ipc.handlePlainCommand("acp:auth:respond", (event, input) =>
      handle(event, AcpInputSchemas["acp.auth.respond"], input, agents["acp.auth.respond"]).pipe(
        Effect.tap(authenticationCompleted),
      ),
    );
    yield* ipc.handlePlainCommand("acp:auth:complete", (event, input) =>
      handle(event, AcpInputSchemas["acp.auth.complete"], input, agents["acp.auth.complete"]).pipe(
        Effect.tap(authenticationCompleted),
      ),
    );
    yield* ipc.handlePlainCommand("acp:auth:cancel", (event, input) =>
      handle(event, AcpInputSchemas["acp.auth.cancel"], input, agents["acp.auth.cancel"]),
    );
    yield* ipc.handlePlainCommand("acp:auth:logout", (event, input) =>
      handle(event, AcpInputSchemas["acp.auth.logout"], input, agents["acp.auth.logout"]).pipe(
        Effect.tap((result) => (result.ok ? changed : Effect.void)),
      ),
    );
    yield* ipc.handlePlainCommand("acp:urlAuth:accept", (event, input) =>
      handle(event, AcpInputSchemas["acp.urlAuth.accept"], input, agents["acp.urlAuth.accept"]),
    );
    yield* ipc.handlePlainCommand("acp:sessions:delete", (event, input) =>
      handle(event, AcpInputSchemas["acp.sessions.delete"], input, agents["acp.sessions.delete"]),
    );
    yield* ipc.handlePlainCommand("acp:modelProviders:set", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.modelProviders.set"],
        input,
        agents["acp.modelProviders.set"],
      ).pipe(Effect.tap((result) => (result.ok ? changed : Effect.void))),
    );
    yield* ipc.handlePlainCommand("acp:modelProviders:disable", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.modelProviders.disable"],
        input,
        agents["acp.modelProviders.disable"],
      ).pipe(Effect.tap((result) => (result.ok ? changed : Effect.void))),
    );
    yield* ipc.handleQuery("acp:sessions:prepareImport", (event, input) =>
      handle(
        event,
        AcpInputSchemas["acp.sessions.prepareImport"],
        input,
        agents["acp.sessions.prepareImport"],
      ),
    );
    yield* ipc.handlePlainCommand("acp:sessions:import", (event, input) =>
      handle(event, AcpInputSchemas["acp.sessions.import"], input, agents["acp.sessions.import"]),
    );
  }),
);
