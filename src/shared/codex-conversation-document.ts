import type { CodexConversationSnapshot } from "./types";

const projectedByIdentity = new WeakMap<object, object>();

/** Optional application fields are absent in the shared document, including patch baselines. */
function projectDocumentValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new Error(`Conversation documents cannot contain ${typeof value} values`);
  }
  const cached = projectedByIdentity.get(value);
  if (cached) return cached;
  if (ancestors.has(value)) throw new Error("Conversation documents cannot contain cycles");

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    throw new Error("Conversation documents require plain JSON containers");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("Conversation documents cannot contain symbol fields");
  }

  ancestors.add(value);
  try {
    if (isArray) {
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new Error("Conversation documents require dense arrays without named fields");
      }
      const projected = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Conversation documents require dense arrays of JSON values");
        }
        return projectDocumentValue(descriptor.value, ancestors);
      });
      const result = projected.every((entry, index) => entry === value[index]) ? value : projected;
      projectedByIdentity.set(value, result);
      return result;
    }

    let changed = false;
    const entries = Object.getOwnPropertyNames(value).flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("Conversation documents cannot contain accessors or hidden fields");
      }
      if (descriptor.value === undefined) {
        changed = true;
        return [];
      }
      const projected = projectDocumentValue(descriptor.value, ancestors);
      if (projected !== descriptor.value) changed = true;
      return [[key, projected] as const];
    });
    const result = changed ? Object.fromEntries(entries) : value;
    projectedByIdentity.set(value, result);
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Projects immutable application state before checkpointing, diffing, or relaying it. Only absent
 * optional object members are omitted; invalid arrays and unsupported values remain errors.
 * Unchanged subtrees keep their identity so each publication visits only newly constructed state.
 */
export function projectCodexConversationDocument(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot {
  const requests = conversation.requests.filter(
    (request) => request.type !== "nodexAgentAuthorization",
  );
  const shared =
    requests.length === conversation.requests.length ? conversation : { ...conversation, requests };
  return projectDocumentValue(shared, new Set()) as CodexConversationSnapshot;
}
