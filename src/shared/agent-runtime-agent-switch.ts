import type {
  AgentRuntimeOperations,
  AgentSnapshot,
  AgentWire,
  ModelSelection,
} from "@nodex/agent-runtime/contracts";
import { agentRuntimeModelSelectionsEqual } from "./agent-runtime-provider";

type AgentRuntimeProvider = AgentRuntimeOperations["providers.read"]["output"][number];
type Projection = Pick<
  AgentSnapshot["projection"],
  "thread" | "runs" | "providerThreads" | "providerSessions"
>;
type Selection = AgentWire<ModelSelection>;

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const isLiveSession = (session: Projection["providerSessions"][number]) =>
  session.status !== "stopped" && session.status !== "error";
const UNSUPPORTED =
  "This chat can't continue on another Agent. Start a new chat to use this model.";

/** The provider session serving the chat's current work: its active Run's, then its own. */
function conversationProviderSession(projection: Projection) {
  const activeRun = projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const providerThread =
    projection.providerThreads.find((thread) => thread.id === providerThreadId) ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    );
  const sessionId = providerThread?.providerSessionId ?? null;
  return sessionId === null
    ? (projection.providerSessions.findLast(isLiveSession) ?? null)
    : (projection.providerSessions.find((session) => session.id === sessionId) ?? null);
}

/**
 * Why a started chat cannot hand its conversation to another Agent now, or null when it can.
 * Its provider session answers from its capability. Without one, a Run that is still starting
 * cannot hand over yet; a chat with no Runs can; a finished chat can while its Agent keeps the
 * native conversation the handoff reads from, even after that Agent's process detached.
 */
export function agentRuntimeAgentSwitchRefusal(projection: Projection): string | null {
  const session = conversationProviderSession(projection);
  if (session)
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff ? null : UNSUPPORTED;
  if (projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)))
    return "Wait for the current reply to start, then choose another Agent.";
  if (projection.runs.length === 0) return null;
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId &&
      thread.nativeThreadRef !== null,
  )
    ? null
    : UNSUPPORTED;
}

/** Why a started chat's next message cannot use this Agent and model, or null when it can. */
export function agentRuntimeSelectionRefusal(input: {
  readonly current: Pick<Selection, "instanceId" | "model">;
  readonly next: Pick<Selection, "instanceId" | "model">;
  /** {@link agentRuntimeAgentSwitchRefusal} for the chat. */
  readonly agentSwitchRefusal: string | null;
  readonly providers: readonly Pick<
    AgentRuntimeProvider,
    "instanceId" | "requiresNewThreadForModelChange"
  >[];
}): string | null {
  const { current, next } = input;
  if (current.instanceId !== next.instanceId) return input.agentSwitchRefusal;
  if (current.model === next.model) return null;
  return input.providers.some(
    (provider) =>
      provider.instanceId === current.instanceId && provider.requiresNewThreadForModelChange,
  )
    ? "This Agent keeps its model for the whole chat. Start a new chat to use this model."
    : null;
}

/**
 * The choice a started chat's next message carries: the person's pending choice while it
 * differs from what the chat last ran, otherwise none, so the chat's own selection applies.
 */
export function agentRuntimePendingSelection(
  observed: Selection,
  pending: Selection | undefined,
): Selection | null {
  return pending && !agentRuntimeModelSelectionsEqual(observed, pending) ? pending : null;
}
