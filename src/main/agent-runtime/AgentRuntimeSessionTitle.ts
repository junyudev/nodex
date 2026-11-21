import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { selectWritingModel } from "../../shared/agent-runtime-utility-model";
import type { ModelPolicy } from "../../shared/model-policy";
import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { AgentRuntimeWritingModel } from "../../shared/agent-runtime-settings";
import {
  buildSessionTitlePrompt,
  parseGeneratedSessionTitle,
  SESSION_TITLE_OUTPUT_SCHEMA,
  SESSION_TITLE_TIMEOUT_MS,
} from "./session-title-prompt";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

type ModelSelection = AgentRuntimeLaunch["modelSelection"];
export const generateSessionTitle = Effect.fn("AgentRuntimeSessionTitle.generate")(function* (
  connection: Pick<AgentRuntimeApplicationConnection, "request">,
  input: {
    readonly prompt: string;
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly writingModel: AgentRuntimeWritingModel | null;
    readonly modelPolicy: ModelPolicy;
    readonly nativeTitle?: Effect.Effect<string | null, unknown>;
  },
) {
  const prompt = buildSessionTitlePrompt(input.prompt);
  if (!prompt) return null;
  const providers = yield* connection.request("providers.read", {});
  const selection = selectWritingModel(
    providers,
    input.modelPolicy,
    input.writingModel,
    input.modelSelection,
  );
  if (!selection) return input.nativeTitle ? yield* input.nativeTitle : null;
  const output = yield* connection.request("text.generate-structured", {
    cwd: input.cwd,
    prompt,
    modelSelection: selection,
    outputSchema: SESSION_TITLE_OUTPUT_SCHEMA,
    timeoutMs: SESSION_TITLE_TIMEOUT_MS,
  });
  return parseGeneratedSessionTitle(output);
});

/** Observe the opening Run on the same Runtime connection that admitted it. */
export const readNativeSessionTitle = Effect.fn("AgentRuntimeSessionTitle.readNative")(
  function* (connection: AgentRuntimeApplicationConnection, threadId: string, messageId: string) {
    const outcome = yield* connection.request("run.outcome", { threadId, messageId });
    if (!outcome) return null;
    const runId = outcome.runId;
    const snapshot = yield* connection.request("thread.control", { threadId, runId });
    const openingRun = snapshot.projection.runs.find((run) => run.id === runId);
    if (!openingRun) return null;

    const readTitle = (thread: AgentSnapshot["projection"]["providerThreads"][number]) => {
      if (
        thread.appThreadId !== threadId ||
        thread.ownerNodeId !== null ||
        thread.lastRunOrdinal !== openingRun.ordinal
      )
        return undefined;
      return thread.nativeMetadata?.title?.trim() || undefined;
    };
    const boundThread = snapshot.projection.providerThreads.find(
      (thread) => thread.id === openingRun.providerThreadId,
    );
    const existing = boundThread && readTitle(boundThread);
    if (existing) return existing;
    if (openingRun.completedAt || !connection.subscribeNotifications) return null;

    // The stream replays updates after the snapshot watermark, including during subscription.
    const notifications = yield* connection.subscribeNotifications;
    const { subscriptionId } = yield* Effect.acquireRelease(
      connection
        .request("events.observe", {
          threadId,
          afterSequence: snapshot.snapshotSequence,
          eventTypes: ["provider-thread.updated"],
        })
        .pipe(Effect.interruptible),
      ({ subscriptionId }) =>
        connection
          .request("events.unobserve", { subscriptionId })
          .pipe(Effect.timeout("2 seconds"), Effect.ignoreCause),
    );
    const title = yield* notifications.pipe(
      Stream.mapEffect(
        Effect.fnUntraced(function* ({ notification }) {
          if (notification.type !== "event" && notification.type !== "event.error")
            return undefined;
          if (notification.subscriptionId !== subscriptionId) return undefined;
          if (notification.type === "event.error") return null;
          const { event } = notification.event;
          if (event.type !== "provider-thread.updated") return undefined;
          const title = readTitle(event.payload);
          if (!title) return undefined;
          // The opening Run may have acquired its native thread since the initial snapshot.
          const current = yield* connection.request("thread.control", { threadId, runId });
          const bound = current.projection.runs.find((run) => run.id === runId);
          return bound?.providerThreadId === event.payload.id ? title : undefined;
        }),
      ),
      Stream.filter((title) => title !== undefined),
      Stream.runHead,
    );
    return Option.getOrNull(title);
  },
  Effect.scoped,
  Effect.timeoutOption("2 minutes"),
  Effect.map(Option.getOrNull),
);
