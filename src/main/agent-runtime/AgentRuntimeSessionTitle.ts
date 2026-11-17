import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  economicalUtilityModel,
  lightUtilityModelSelection,
} from "../../shared/agent-runtime-utility-model";
import { isModelOn, spendsNodexCredit, type ModelPolicy } from "../../shared/model-policy";
import type { AgentRuntimeOperations, AgentSnapshot } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { AgentRuntimeTitleModel } from "../../shared/agent-runtime-settings";
import {
  buildSessionTitlePrompt,
  parseGeneratedSessionTitle,
  SESSION_TITLE_OUTPUT_SCHEMA,
  SESSION_TITLE_TIMEOUT_MS,
} from "./session-title-prompt";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

type ModelSelection = AgentRuntimeLaunch["modelSelection"];
type Providers = AgentRuntimeOperations["providers.read"]["output"];

/**
 * The Profile's title model, or else a light model on the chat's own Agent, so its first message
 * goes nowhere new. Credit is spent only on a model the person chose, so a credit chat keeps its own.
 */
const titleModelSelection = (
  input: {
    readonly modelSelection: ModelSelection;
    readonly titleModel: AgentRuntimeTitleModel | null;
    readonly modelPolicy: ModelPolicy;
  },
  providers: Providers,
): ModelSelection => {
  if (input.titleModel) return input.titleModel;
  const provider = providers.find(
    (candidate) => candidate.instanceId === input.modelSelection.instanceId,
  );
  if (!provider || spendsNodexCredit(provider)) return input.modelSelection;
  const light = economicalUtilityModel({
    driver: provider.driver,
    models: provider.models.filter((model) => isModelOn(input.modelPolicy, provider, model.slug)),
  });
  return light ? { instanceId: provider.instanceId, model: light.slug } : input.modelSelection;
};

/**
 * Titles a chat with structured generation or, for an Agent without that utility, its own title.
 * The Runtime refuses an explicit model that cannot run, and nothing replaces it.
 */
export const generateSessionTitle = Effect.fn("AgentRuntimeSessionTitle.generate")(function* (
  connection: Pick<AgentRuntimeApplicationConnection, "request">,
  input: {
    readonly prompt: string;
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly titleModel: AgentRuntimeTitleModel | null;
    readonly modelPolicy: ModelPolicy;
    readonly nativeTitle?: Effect.Effect<string | null, unknown>;
  },
) {
  const providers = yield* connection.request("providers.read", {});
  const selection = titleModelSelection(input, providers);
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider?.supportsTextGeneration === false)
    return !input.titleModel && input.nativeTitle ? yield* input.nativeTitle : null;
  const prompt = buildSessionTitlePrompt(input.prompt);
  if (!prompt) return null;
  const output = yield* connection.request("text.generate-structured", {
    cwd: input.cwd,
    prompt,
    modelSelection: lightUtilityModelSelection(selection, providers),
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
