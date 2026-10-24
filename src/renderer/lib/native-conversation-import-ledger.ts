import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
} from "../../shared/native-session-catalog";
import {
  acceptNativeConversationImport,
  type NativeConversationCandidate,
  type NativeConversationCopy,
  type NativeConversationImportSelection,
} from "./native-conversation-import-model";

/**
 * What this window knows about one source's import beyond the latest catalog read. `sending` and
 * `unsettled` hold an accepted request that has not been proven unadmitted, so the only way forward
 * is to send that exact request again. `imported` publishes a copy before catalogs catch up.
 */
export type NativeConversationImportEntry =
  | {
      readonly status: "sending";
      readonly candidate: NativeConversationCandidate;
      readonly request: NativeConversationImportInput;
    }
  | {
      readonly status: "unsettled";
      readonly candidate: NativeConversationCandidate;
      readonly request: NativeConversationImportInput;
      readonly message: string;
    }
  | {
      readonly status: "imported";
      readonly candidate: NativeConversationCandidate;
      readonly copy: NativeConversationCopy;
      /** Ledger time of settlement; a read observed later is authoritative instead. */
      readonly settledAt: number;
    };

export type NativeConversationImportSettlement =
  | { readonly kind: "imported"; readonly copy: NativeConversationCopy }
  | { readonly kind: "not_admitted"; readonly message: string }
  | { readonly kind: "unsettled"; readonly message: string };

export interface NativeConversationImportLedger {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ReadonlyMap<string, NativeConversationImportEntry>;
  /** Ledger time; stamp a catalog read before sending it so settlement order can be compared. */
  readonly now: () => number;
  /**
   * Sends one source's import; concurrent calls share the submission already in flight. An
   * unsettled attempt resends its own request and ignores `selection`, which only shapes a new one.
   * A copy settled after the caller's read is returned instead of importing again.
   */
  readonly submit: (
    candidate: NativeConversationCandidate,
    selection: NativeConversationImportSelection,
    send: (input: NativeConversationImportInput) => Promise<NativeConversationImportOutcome>,
  ) => Promise<NativeConversationImportSettlement>;
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function createNativeConversationImportLedger(): NativeConversationImportLedger {
  let entries: ReadonlyMap<string, NativeConversationImportEntry> = new Map();
  let clock = 0;
  const listeners = new Set<() => void>();
  const inFlight = new Map<string, Promise<NativeConversationImportSettlement>>();

  const write = (key: string, entry: NativeConversationImportEntry | null) => {
    const next = new Map(entries);
    if (entry) next.set(key, entry);
    else next.delete(key);
    entries = next;
    for (const listener of listeners) listener();
  };

  const settle = async (
    key: string,
    candidate: NativeConversationCandidate,
    request: NativeConversationImportInput,
    send: (input: NativeConversationImportInput) => Promise<NativeConversationImportOutcome>,
  ): Promise<NativeConversationImportSettlement> => {
    let settlement: NativeConversationImportSettlement;
    let entry: NativeConversationImportEntry | null;
    try {
      const outcome = await send(request);
      if (outcome.kind === "imported") {
        const copy = { threadId: outcome.threadId, sessionId: outcome.sessionId };
        settlement = { kind: "imported", copy };
        entry = { status: "imported", candidate, copy, settledAt: ++clock };
      } else {
        settlement = { kind: "not_admitted", message: outcome.message };
        entry = null;
      }
    } catch (cause) {
      settlement = { kind: "unsettled", message: errorMessage(cause) };
      entry = { status: "unsettled", candidate, request, message: settlement.message };
    }
    const current = entries.get(key);
    // Only the submission that owns this source's request may settle it.
    if (current?.status === "sending" && current.request.requestId === request.requestId)
      write(key, entry);
    return settlement;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => entries,
    now: () => ++clock,
    submit: (candidate, selection, send) => {
      const key = candidate.key;
      const running = inFlight.get(key);
      if (running) return running;
      const current = entries.get(key);
      const copy = nativeConversationImportedCopy(candidate, current);
      if (copy) return Promise.resolve({ kind: "imported", copy });
      const request =
        current?.status === "unsettled"
          ? current.request
          : acceptNativeConversationImport(selection);
      // The attempt keeps the conversation it was accepted for, even if the source disappears.
      const subject = current?.status === "unsettled" ? current.candidate : candidate;
      write(key, { status: "sending", candidate: subject, request });
      const submission = settle(key, subject, request, send).finally(() => inFlight.delete(key));
      inFlight.set(key, submission);
      return submission;
    },
  };
}

/**
 * The copy to offer for a source: the read's own, or one this window settled after that read. A
 * read sent after the settlement wins, so a copy deleted since then can be imported again.
 */
export function nativeConversationImportedCopy(
  candidate: NativeConversationCandidate,
  entry: NativeConversationImportEntry | undefined,
): NativeConversationCopy | null {
  if (candidate.imported) return candidate.imported;
  return entry?.status === "imported" && entry.settledAt > candidate.observedAt ? entry.copy : null;
}

/** One ledger per renderer window, so leaving Settings never loses an accepted request. */
export const nativeConversationImportLedger = createNativeConversationImportLedger();
