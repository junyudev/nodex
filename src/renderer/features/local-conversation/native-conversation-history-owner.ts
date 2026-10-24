import type { AgentConversationSnapshot } from "../../../shared/agent-conversation";
import { projectAgentConversation } from "../../../shared/agent-conversation-presentation";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  readCurrentCodexHistoryBoundary,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryBoundaryRef,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import type {
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexThreadSummary,
} from "../../../shared/types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";

export interface NativeConversationHistorySnapshot {
  readonly view: CodexConversationSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
}

type ReadHistory = (input: {
  readonly threadId: string;
  readonly before?: string;
  readonly limit?: number;
}) => Promise<AgentConversationSnapshot>;

type HistoryPageResult = "applied" | "stale";
type HistoryRequest = {
  readonly epoch: number;
  readonly generation: number;
  readonly boundary: CodexHistoryBoundaryRef | null;
  readonly promise: Promise<HistoryPageResult>;
};

const empty = (): NativeConversationHistorySnapshot => ({
  view: null,
  loading: false,
  error: null,
});

/** A retained native history source offers only bounded reads, never execution or subscriptions. */
export class NativeConversationHistoryOwner {
  #summary: CodexThreadSummary;
  #state = empty();
  #leases = 0;
  #epoch = 0;
  #generation = 0;
  #mutationRevision = 0;
  #request: HistoryRequest | null = null;
  #topology: CodexCanonicalHistoryTopology<CodexConversationTurn> | null = null;
  #seenCursors = new Set<string>();
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
          hasUnreadTurn: summary.hasUnreadTurn,
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
      this.#leases -= 1;
      if (this.#leases !== 0) return;
      this.#epoch += 1;
      this.#request = null;
      this.#topology = null;
      this.#seenCursors.clear();
      this.#publish(empty());
    };
  };
  readonly refresh = (): Promise<void> =>
    (this.#request?.promise ?? this.#load(null)).then(() => {});

  readonly loadBoundary = (boundary: CodexHistoryBoundaryRef): Promise<HistoryPageResult> => {
    if (!this.#isCurrentBoundary(boundary)) return Promise.resolve("stale");
    if (this.#request) {
      return this.#request.boundary && this.#isCurrentBoundary(this.#request.boundary)
        ? this.#request.promise
        : Promise.resolve("stale");
    }
    return this.#load(boundary);
  };

  #isCurrentBoundary(boundary: CodexHistoryBoundaryRef): boolean {
    if (!this.#topology || boundary.edge !== "older") return false;
    const current = readCurrentCodexHistoryBoundary(this.#topology, boundary);
    return (
      current !== null && current.handle.oldestLoadedTurnId === boundary.handle.oldestLoadedTurnId
    );
  }

  #isCurrentRequest(request: HistoryRequest): boolean {
    return this.#leases > 0 && this.#epoch === request.epoch && this.#request === request;
  }

  #load(boundary: CodexHistoryBoundaryRef | null): Promise<HistoryPageResult> {
    if (this.#leases === 0) return Promise.resolve("stale");
    const request: HistoryRequest = {
      epoch: this.#epoch,
      generation: boundary?.generation ?? ++this.#generation,
      boundary,
      // Admission happens before I/O; a lease released in this turn never starts a stale read.
      promise: Promise.resolve().then(() => this.#readPage(request)),
    };
    this.#request = request;
    this.#publish({ ...this.#state, loading: true, error: null });
    return request.promise;
  }

  async #readPage(request: HistoryRequest): Promise<HistoryPageResult> {
    const { boundary } = request;
    try {
      if (!this.#isCurrentRequest(request)) return "stale";
      const snapshot = await this.read({
        threadId: this.#summary.threadId,
        ...(boundary ? { before: boundary.handle.cursor } : {}),
        // Main also bounds native records and reply bytes independently for every physical page.
        limit: 50,
      });
      if (!this.#isCurrentRequest(request)) return "stale";
      if (boundary && !this.#isCurrentBoundary(boundary)) return "stale";
      if (snapshot.threadId !== this.#summary.threadId)
        throw new Error("Native history returned another Thread");
      const cursor = snapshot.history?.hasOlder ? snapshot.history.cursor : null;
      if (snapshot.history?.hasOlder && !cursor?.trim())
        throw new Error("Native history cursor is unavailable");
      if (boundary && cursor && this.#seenCursors.has(cursor))
        throw new Error("Native history cursor did not advance");
      const projected = projectAgentConversation({ snapshot }, this.#summary);
      const turns = boundary
        ? [
            ...new Map([
              ...projected.turns.map((turn) => [turn.turnId, turn] as const),
              ...(this.#state.view?.turns ?? []).map((turn) => [turn.turnId, turn] as const),
            ]).values(),
          ]
        : projected.turns;
      const entities = turns.map((turn) => {
        if (turn.turnId === null || turn.turnId.trim().length === 0)
          throw new Error("Native history Turn identity is unavailable");
        return { key: turn.turnId, turn };
      });
      const islandId = `native-history:${this.#summary.threadId}`;
      // Hidden native records may advance the cursor without projecting any visible Turns.
      const result = createCodexHistoryIslandTopology({
        generation: request.generation,
        islandId,
        entries: entities.map(({ key }) => ({ key, value: key })),
        entities,
        olderBoundary: cursor
          ? availableCodexHistoryBoundary(`${islandId}:older`, {
              cursor,
              oldestLoadedTurnId: entities[0]?.key ?? null,
            })
          : exhaustedCodexHistoryBoundary(`${islandId}:older`),
        newerBoundary: exhaustedCodexHistoryBoundary(`${islandId}:newer`),
      });
      if (!result.ok) throw new Error(result.error.message);
      this.#topology = result.topology;
      if (!boundary) this.#seenCursors.clear();
      if (cursor) this.#seenCursors.add(cursor);
      this.#mutationRevision += 1;
      this.#publish({
        view: {
          ...projected,
          turns,
          historyRows: flattenCodexHistoryTopology(result.topology),
          historyTopologyGeneration: result.topology.generation,
          historyMutationRevision: this.#mutationRevision,
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
      });
      return "applied";
    } catch (cause: unknown) {
      if (!this.#isCurrentRequest(request)) return "stale";
      const error = cause instanceof Error ? cause : new Error("Native history is unavailable");
      this.#publish({ ...this.#state, loading: false, error: boundary ? null : error.message });
      // The viewport owns retry for this gap; readable history remains attached.
      if (boundary) throw error;
      return "stale";
    } finally {
      if (this.#request === request) this.#request = null;
    }
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
