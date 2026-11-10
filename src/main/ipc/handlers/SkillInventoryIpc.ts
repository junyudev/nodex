import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import { skillInput, type SkillResult } from "../../../shared/skill-inventory";
import { MainConfig } from "../../app/MainConfig";
import { SkillInventory } from "../../host-runtime/SkillInventory";
import { safeSendToWebContents, safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { SkillFileError, skillFailure } from "../../platform/node/SkillFilesNode";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const skills = yield* SkillInventory;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const destruction = yield* WebContentsDestructionSubscriptions;
    const subscriptions = yield* FiberMap.make<string>();
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Skill inventory", config.rendererUrl);
          if (!windows.has(event.sender.id)) throw new Error("Unregistered window");
        },
        catch: () => new SkillFileError("unavailable", "Skills require a registered Nodex window."),
      });
    const handle =
      <Input, Result>(
        schema: ZodType<Input>,
        operation: (
          input: Input,
          event: IpcMainInvokeEvent,
        ) => Effect.Effect<Result, SkillFileError>,
      ) =>
      (event: IpcMainInvokeEvent, raw: unknown) =>
        authorize(event).pipe(
          Effect.andThen(
            Effect.try({
              try: () => schema.parse(raw),
              catch: () => new SkillFileError("invalid_input", "Invalid skill request."),
            }),
          ),
          Effect.flatMap((input) => operation(input, event)),
          Effect.catch((cause) => Effect.succeed(skillFailure(cause))),
        );

    yield* ipc.handleQuery("skills:inventory:list", handle(skillInput.list, skills.list));
    yield* ipc.handleQuery(
      "skills:document:read",
      handle(skillInput.readDocument, skills.readDocument),
    );
    yield* ipc.handlePlainCommand(
      "skills:document:write",
      handle(skillInput.writeDocument, skills.writeDocument),
    );
    yield* ipc.handlePlainCommand(
      "skills:create",
      handle(skillInput.createBlank, skills.createBlank),
    );
    yield* ipc.handlePlainCommand("skills:rename", handle(skillInput.rename, skills.rename));
    yield* ipc.handlePlainCommand("skills:transfer", handle(skillInput.transfer, skills.transfer));
    yield* ipc.handlePlainCommand("skills:trash", handle(skillInput.trash, skills.trash));
    yield* ipc.handlePlainCommand(
      "skills:set-enabled",
      handle(skillInput.setEnabled, skills.setEnabled),
    );
    yield* ipc.handleControl(
      "skills:watch:start",
      handle(skillInput.watchStart, (input, { sender }) =>
        Effect.gen(function* () {
          const subscriptionId = randomUUID();
          const ready = yield* Deferred.make<void, SkillFileError>();
          const lifecycle = skills.watch(input).pipe(
            Stream.runForEach((event) =>
              event === "ready"
                ? Deferred.succeed(ready, undefined)
                : Effect.sync(() =>
                    safeSendToWebContents(sender, "skills:changed", [{ subscriptionId }]),
                  ),
            ),
            Effect.raceFirst(destruction.wait(sender)),
            Effect.catch((cause) => Deferred.fail(ready, cause)),
            Effect.ensuring(
              Deferred.fail(ready, new SkillFileError("unavailable", "The skill watch closed.")),
            ),
          );
          yield* FiberMap.run(subscriptions, `${sender.id}:${subscriptionId}`, lifecycle, {
            startImmediately: true,
          });
          yield* Deferred.await(ready);
          return { status: "ok", value: { subscriptionId } } as const;
        }),
      ),
    );
    yield* ipc.handleControl(
      "skills:watch:stop",
      handle(skillInput.watchStop, ({ subscriptionId }, { sender }) =>
        FiberMap.remove(subscriptions, `${sender.id}:${subscriptionId}`).pipe(
          Effect.as({ status: "ok", value: undefined } satisfies SkillResult<void>),
        ),
      ),
    );
    yield* skills.composerChanges.pipe(
      Stream.runForEach((hostId) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "skills:composer-invalidated", [{ hostId }]),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
