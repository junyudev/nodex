import type { IpcMainInvokeEvent } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  PageTextRewriteRequestIdSchema,
  PageTextRewriteStartSchema,
  type PageTextRewriteEvent,
  type PageTextRewriteStartResult,
} from "../../../shared/page-text-rewrite";
import { MainConfig } from "../../app/MainConfig";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { PageTextRewrite, PageTextRewriteError } from "../../page-text-rewrite/PageTextRewrite";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const destruction = yield* WebContentsDestructionSubscriptions;
    const rewrite = yield* PageTextRewrite;
    const tasks = yield* FiberMap.make<string, void>();
    const key = (event: IpcMainInvokeEvent, requestId: string) => `${event.sender.id}/${requestId}`;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Page text rewrite", config.rendererUrl);
          if (!windows.has(event.sender.id) || event.sender.isDestroyed())
            throw new Error("Inactive window");
        },
        catch: () =>
          new PageTextRewriteError({
            code: "unavailable",
            message: "Page text rewrite requires an active Nodex window",
          }),
      });

    yield* ipc.handlePlainCommand("page-text-rewrite:start", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.uninterruptible(
            Effect.gen(function* (): Effect.fn.Return<PageTextRewriteStartResult> {
              const parsed = PageTextRewriteStartSchema.safeParse(raw);
              if (!parsed.success)
                return {
                  ok: false,
                  error: {
                    code: "invalid_input",
                    message: "Select less text and enter a rewrite instruction",
                  },
                };
              const { requestId, input } = parsed.data;
              const taskKey = key(event, requestId);
              if ((yield* FiberMap.has(tasks, taskKey)) || (yield* FiberMap.size(tasks)) >= 16)
                return {
                  ok: false,
                  error: {
                    code: "busy",
                    message: "A rewrite is already running. Wait or cancel it",
                  },
                };
              const emit = (result: PageTextRewriteEvent) =>
                Effect.sync(() => {
                  safeSendToWebContents(event.sender, "page-text-rewrite:event", [result]);
                });
              const work = rewrite.generate(input).pipe(
                Effect.raceFirst(
                  destruction.wait(event.sender).pipe(Effect.andThen(Effect.interrupt)),
                ),
                Effect.onExit((exit) => {
                  if (Exit.isSuccess(exit))
                    return emit({ requestId, kind: "done", markdown: exit.value });
                  const cause = exit.cause;
                  if (Cause.hasInterruptsOnly(cause)) return emit({ requestId, kind: "cancelled" });
                  const error = Cause.findErrorOption(cause);
                  const failure =
                    error._tag === "Some" && Schema.is(PageTextRewriteError)(error.value)
                      ? { code: error.value.code, message: error.value.message }
                      : {
                          code: "generation_failed" as const,
                          message: "The rewrite failed. Try again",
                        };
                  return emit({ requestId, kind: "error", error: failure });
                }),
                Effect.catchCause(() => Effect.void),
                Effect.interruptible,
              );
              yield* FiberMap.run(tasks, taskKey, work, {
                startImmediately: true,
                onlyIfMissing: true,
              });
              return { ok: true };
            }),
          ),
        ),
      ),
    );
    yield* ipc.handleControl("page-text-rewrite:cancel", (event, raw) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const parsed = PageTextRewriteRequestIdSchema.safeParse(raw);
            if (!parsed.success) return;
            yield* FiberMap.remove(tasks, key(event, parsed.data));
          }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
