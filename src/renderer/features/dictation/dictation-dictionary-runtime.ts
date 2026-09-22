import type {
  DictationDictionarySnapshot,
  DictationDictionaryTarget,
} from "../../../shared/dictation-dictionary";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "@/lib/renderer-command";

const addCommand = defineRendererCommand({
  key: "dictation.dictionary.add",
  channel: "codex:dictation:dictionary:add",
  authority: "external",
  owner: "DictationDictionary",
  protocol: { kind: "returned_value" },
});
const removeCommand = defineRendererCommand({
  key: "dictation.dictionary.remove",
  channel: "codex:dictation:dictionary:remove",
  authority: "external",
  owner: "DictationDictionary",
  protocol: { kind: "returned_value" },
});
const importCommand = defineRendererCommand({
  key: "dictation.dictionary.import",
  channel: "codex:dictation:dictionary:import",
  authority: "external",
  owner: "DictationDictionary",
  protocol: { kind: "returned_value" },
});

/** One dialog owns a fixed account target and cancels its requests when dismissed. */
export function createDictationDictionarySession() {
  const id = crypto.randomUUID();
  const pending = new Set<string>();
  let target: DictationDictionaryTarget | undefined;
  let disposed = false;
  let generation = 0;
  const aborted = () => new DOMException("Voice dictionary closed", "AbortError");
  const requireTarget = () => {
    if (!target) throw new Error("Load the voice dictionary before editing it");
    return target;
  };
  const cancel = (operationId: string) => {
    void invokeRendererControl("codex:dictation:dictionary:cancel", operationId).catch(
      () => undefined,
    );
  };
  const run = async <T>(
    perform: (operationId: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (disposed || signal?.aborted) throw aborted();
    const startedGeneration = generation;
    const operationId = crypto.randomUUID();
    pending.add(operationId);
    const abort = () => cancel(operationId);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await perform(operationId);
      if (disposed || signal?.aborted || startedGeneration !== generation) throw aborted();
      return result;
    } catch (error) {
      if (disposed || signal?.aborted || startedGeneration !== generation) throw aborted();
      throw error;
    } finally {
      pending.delete(operationId);
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    id,
    activate: () => {
      disposed = false;
    },
    read: async (signal?: AbortSignal): Promise<DictationDictionarySnapshot> => {
      const snapshot = await run(
        (operationId) =>
          invokeRendererQuery("codex:dictation:dictionary:read", { operationId, target }),
        signal,
      );
      target ??= snapshot.target;
      return snapshot;
    },
    add: (text: string) =>
      run((operationId) =>
        invokePlainCommand(addCommand, { operationId, target: requireTarget(), text }),
      ),
    remove: (wordId: string) =>
      run((operationId) =>
        invokePlainCommand(removeCommand, { operationId, target: requireTarget(), wordId }),
      ),
    importWords: (words: readonly string[]) =>
      run((operationId) =>
        invokePlainCommand(importCommand, {
          operationId,
          target: requireTarget(),
          words: [...words],
        }),
      ),
    dispose: () => {
      disposed = true;
      generation++;
      for (const operationId of pending) cancel(operationId);
    },
  };
}
