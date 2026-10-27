import { registerAppCloseFlushHandler } from "@/lib/app-close-flush";
import { toast } from "@/components/ui/toast";
import { getPersistedAtomTransport, type PersistedAtomTransport } from "@/lib/persisted-atom-store";

interface StoredQuestionDraft {
  readonly version: 1;
  readonly signature: string;
  readonly value: unknown;
}

export interface QuestionDraftStore {
  read(key: string, signature: string): unknown;
  watch(key: string, listener: () => void): () => void;
  write(key: string, signature: string, value: unknown): void;
  remove(key: string): void;
  flush(keys?: readonly string[]): Promise<void>;
}

const PREFIX = "conversation-question-draft-v1:";
const decode = (value: unknown): StoredQuestionDraft | undefined => {
  if (typeof value !== "object" || value === null || !("version" in value)) return;
  if (value.version !== 1 || !("signature" in value) || typeof value.signature !== "string") return;
  return "value" in value
    ? { version: 1, signature: value.signature, value: value.value }
    : undefined;
};

/** Authored question drafts use the Profile's revisioned, cross-window preference store. */
export function createQuestionDraftStore(
  transport: PersistedAtomTransport = getPersistedAtomTransport(),
  options: {
    readonly onError?: (error: unknown) => void;
    readonly registerFlush?: (flush: () => Promise<void>) => void;
  } = {},
): QuestionDraftStore {
  const values = new Map<string, StoredQuestionDraft>();
  const listeners = new Map<string, Set<() => void>>();
  const localVersions = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  const failures = new Map<string, unknown>();
  const latestMutations = new Map<string, string>();
  const mutationPrefix = `${crypto.randomUUID()}:`;
  let mutationSequence = 0;
  let flushRegistered = false;
  const flush = async (keys?: readonly string[]) => {
    if (loading) await loading;
    while (pending.size) await Promise.all([...pending]);
    const failure = [...failures].find(([key]) => keys === undefined || keys.includes(key));
    if (failure) throw new Error("Could not save question drafts", { cause: failure[1] });
  };
  let loading: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  const notify = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const apply = (key: string, value: unknown) => {
    const next = decode(value);
    if (JSON.stringify(values.get(key)) === JSON.stringify(next)) return;
    if (next) values.set(key, next);
    else values.delete(key);
    notify(key);
  };
  const start = () => {
    if (!flushRegistered && options.registerFlush) {
      options.registerFlush(flush);
      flushRegistered = true;
    }
    if (!unsubscribe)
      unsubscribe = transport.subscribe((event) => {
        if (!event.key.startsWith(PREFIX)) return;
        const key = event.key.slice(PREFIX.length);
        localVersions.set(key, (localVersions.get(key) ?? 0) + 1);
        // Earlier local acknowledgements must not rewind text authored while they were in flight.
        if (
          event.mutationId.startsWith(mutationPrefix) &&
          latestMutations.get(key) !== event.mutationId
        )
          return;
        apply(key, event.value);
      });
    if (loading) return;
    const versions = new Map(localVersions);
    loading = transport.readSnapshot().then((snapshot) => {
      for (const [storageKey, value] of Object.entries(snapshot.values)) {
        if (!storageKey.startsWith(PREFIX)) continue;
        const key = storageKey.slice(PREFIX.length);
        if (localVersions.get(key) !== versions.get(key)) continue;
        apply(key, value);
      }
    });
    void loading.catch((error: unknown) => {
      loading = undefined;
      options.onError?.(error);
    });
  };
  const persist = (key: string, value: StoredQuestionDraft | undefined) => {
    localVersions.set(key, (localVersions.get(key) ?? 0) + 1);
    apply(key, value);
    const mutationId = `${mutationPrefix}${++mutationSequence}`;
    latestMutations.set(key, mutationId);
    const request = transport
      .mutate({ key: `${PREFIX}${key}`, value, mutationId })
      .then(() => {
        if (latestMutations.get(key) === mutationId) failures.delete(key);
      })
      .catch((error: unknown) => {
        if (latestMutations.get(key) !== mutationId) return;
        failures.set(key, error);
        options.onError?.(error);
      })
      .finally(() => {
        pending.delete(request);
      });
    pending.add(request);
  };
  return {
    flush,
    read(key, signature) {
      start();
      const entry = values.get(key);
      return entry?.signature === signature ? entry.value : undefined;
    },
    watch(key, listener) {
      start();
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      subscribers.add(listener);
      listeners.set(key, subscribers);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(key);
      };
    },
    write(key, signature, value) {
      start();
      persist(key, { version: 1, signature, value });
    },
    remove(key) {
      start();
      persist(key, undefined);
    },
  };
}

export const questionDraftStore = createQuestionDraftStore(getPersistedAtomTransport(), {
  registerFlush: (flush) => {
    registerAppCloseFlushHandler(flush);
  },
  onError: () => {
    toast.danger("Couldn’t save question draft", { id: "question-draft-save" });
  },
});
