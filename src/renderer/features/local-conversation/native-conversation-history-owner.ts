import type { AgentConversationSnapshot } from "../../../shared/agent-conversation";
import { projectAgentConversation } from "../../../shared/agent-conversation-presentation";
import type { CodexConversationSnapshot, CodexThreadSummary } from "../../../shared/types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";

export interface NativeConversationHistorySnapshot {
  readonly view: CodexConversationSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly cursor: string | null;
  readonly hasOlder: boolean;
  readonly windowFull: boolean;
}

type ReadHistory = (input: {
  readonly threadId: string;
  readonly before?: string;
  readonly limit?: number;
}) => Promise<AgentConversationSnapshot>;

const empty = (): NativeConversationHistorySnapshot => ({
  view: null,
  loading: false,
  error: null,
  cursor: null,
  hasOlder: false,
  windowFull: false,
});

const HISTORY_TURN_LIMIT = 200;
const HISTORY_ITEM_LIMIT = 500;
const HISTORY_BYTE_LIMIT = 1024 * 1024;

const exceedsWindow = (turns: CodexConversationSnapshot["turns"]) =>
  turns.length > HISTORY_TURN_LIMIT ||
  turns.reduce((total, turn) => total + turn.items.length, 0) > HISTORY_ITEM_LIMIT ||
  new TextEncoder().encode(JSON.stringify(turns)).byteLength > HISTORY_BYTE_LIMIT;

/** A retained native history source offers only bounded reads, never execution or subscriptions. */
export class NativeConversationHistoryOwner {
  #summary: CodexThreadSummary;
  #state = empty();
  #leases = 0;
  #request: Promise<void> | null = null;
  #listeners = new Set<() => void>();
  constructor(
    summary: CodexThreadSummary,
    readonly read: ReadHistory = agentBackendRuntime.history,
  ) {
    this.#summary = summary;
  }
  readonly updateSummary = (summary: CodexThreadSummary): void => {
    if (summary.threadId !== this.#summary.threadId)
      throw new Error("Native history identity changed");
    if (summary === this.#summary) return;
    this.#summary = summary;
    const view = this.#state.view;
    if (view)
      this.#publish({
        ...this.#state,
        view: {
          ...view,
          projectId: summary.projectId,
          threadName: summary.threadName,
          cwd: summary.cwd,
          archived: summary.archived,
        },
      });
  };
  readonly getSnapshot = (): NativeConversationHistorySnapshot => this.#state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly retain = (): (() => void) => {
    this.#leases += 1;
    if (!this.#state.view) void this.refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#leases = Math.max(0, this.#leases - 1);
      if (this.#leases === 0) this.#publish(empty());
    };
  };
  readonly refresh = (): Promise<void> => this.#load(false);
  readonly loadOlder = (): Promise<void> => {
    if (!this.#state.hasOlder || !this.#state.cursor || this.#state.windowFull)
      return Promise.resolve();
    return this.#load(true);
  };
  #load(older: boolean): Promise<void> {
    if (this.#request) return this.#request;
    if (this.#leases === 0) return Promise.resolve();
    const before = older ? this.#state.cursor : null;
    this.#publish({ ...this.#state, loading: true, error: null });
    this.#request = this.read({
      threadId: this.#summary.threadId,
      ...(before ? { before } : {}),
      limit: 50,
    })
      .then((snapshot) => {
        if (this.#leases === 0) return;
        if (snapshot.threadId !== this.#summary.threadId)
          throw new Error("Native history returned another Thread");
        const projected = projectAgentConversation({ snapshot }, this.#summary);
        const turns = older
          ? [
              ...new Map([
                ...projected.turns.map((turn) => [turn.turnId, turn] as const),
                ...(this.#state.view?.turns ?? []).map((turn) => [turn.turnId, turn] as const),
              ]).values(),
            ]
          : projected.turns;
        if (exceedsWindow(turns)) {
          if (!older) throw new Error("Native history page exceeds the conversation window");
          this.#publish({ ...this.#state, loading: false, windowFull: true });
          return;
        }
        this.#publish({
          view: {
            ...projected,
            turns,
            requests: [],
            canonicalRequests: [],
            capabilityFlags: {
              ...projected.capabilityFlags,
              canEditUserTurns: false,
              canForkFromTurn: false,
            },
          },
          loading: false,
          error: null,
          cursor: snapshot.history?.cursor ?? null,
          hasOlder: snapshot.history?.hasOlder === true,
          windowFull:
            turns.length >= HISTORY_TURN_LIMIT ||
            turns.reduce((total, turn) => total + turn.items.length, 0) >= HISTORY_ITEM_LIMIT,
        });
      })
      .catch((cause: unknown) => {
        if (this.#leases === 0) return;
        this.#publish({
          ...this.#state,
          loading: false,
          error: cause instanceof Error ? cause.message : "Native history is unavailable",
        });
      })
      .finally(() => {
        this.#request = null;
      });
    return this.#request;
  }
  #publish(state: NativeConversationHistorySnapshot): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

type NativeHistoryLease = {
  readonly owner: NativeConversationHistoryOwner;
  readonly retain: () => () => void;
};
const owners = new Map<string, NativeHistoryLease>();

export function acquireNativeConversationHistoryOwner(
  sessionId: string,
  summary: CodexThreadSummary,
): NativeHistoryLease {
  const key = `${sessionId}\0${summary.threadId}`;
  const previous = owners.get(key);
  if (previous) return previous;
  const owner = new NativeConversationHistoryOwner(summary);
  let leases = 0;
  const entry: NativeHistoryLease = {
    owner,
    retain: () => {
      leases += 1;
      if (!owners.has(key)) owners.set(key, entry);
      const release = owner.retain();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        leases -= 1;
        if (leases === 0 && owners.get(key) === entry) owners.delete(key);
      };
    },
  };
  owners.set(key, entry);
  return entry;
}
