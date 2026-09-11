import {
  applyPatches,
  enablePatches,
  isDraft,
  original,
  produceWithPatches,
  type Draft,
  type Patch,
} from "immer";
import type {
  CodexConversationPatchPathSegment,
  CodexConversationSnapshot,
  CodexConversationStateUpdate,
} from "./types";

enablePatches();

const KEEP_DRAFT_VALUE = Symbol("keep-draft-value");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (typeof value === "undefined") {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePath(path: readonly (string | number)[]): CodexConversationPatchPathSegment[] {
  return path.map((segment) => {
    if (typeof segment === "string" || typeof segment === "number") {
      return segment;
    }

    return String(segment);
  });
}

function toCodexConversationStateUpdate(patch: Patch): CodexConversationStateUpdate {
  if (patch.op === "remove") {
    return {
      op: "remove",
      path: normalizePath(patch.path),
    };
  }

  return {
    op: patch.op,
    path: normalizePath(patch.path),
    value: cloneValue(patch.value),
  };
}

function toImmerPatch(patch: CodexConversationStateUpdate): Patch {
  if (patch.op === "remove") {
    return {
      op: "remove",
      path: patch.path,
    };
  }

  return {
    op: patch.op,
    path: patch.path,
    value: cloneValue(patch.value),
  };
}

function reconcileDraftValue(
  currentValue: unknown,
  nextValue: unknown,
): typeof KEEP_DRAFT_VALUE | unknown {
  if (
    Object.is(currentValue, nextValue) ||
    (isDraft(currentValue) && Object.is(original(currentValue as Draft<object>), nextValue))
  ) {
    return KEEP_DRAFT_VALUE;
  }

  if (Array.isArray(nextValue)) {
    if (!Array.isArray(currentValue)) {
      return cloneValue(nextValue);
    }

    const targetArray = currentValue as Draft<unknown[]>;
    const sharedLength = Math.min(targetArray.length, nextValue.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const reconciledValue = reconcileDraftValue(targetArray[index], nextValue[index]);
      if (reconciledValue !== KEEP_DRAFT_VALUE) {
        targetArray[index] = reconciledValue;
      }
    }

    if (targetArray.length > nextValue.length) {
      targetArray.splice(nextValue.length);
    }

    for (let index = sharedLength; index < nextValue.length; index += 1) {
      targetArray.push(cloneValue(nextValue[index]));
    }

    return KEEP_DRAFT_VALUE;
  }

  if (isPlainObject(nextValue)) {
    if (!isPlainObject(currentValue)) {
      return cloneValue(nextValue);
    }

    const targetObject = currentValue as Draft<Record<string, unknown>>;
    for (const key of Object.keys(targetObject)) {
      if (!(key in nextValue)) {
        delete targetObject[key];
      }
    }

    for (const [key, nestedValue] of Object.entries(nextValue)) {
      const reconciledValue = reconcileDraftValue(targetObject[key], nestedValue);
      if (reconciledValue !== KEEP_DRAFT_VALUE) {
        targetObject[key] = reconciledValue;
      }
    }

    return KEEP_DRAFT_VALUE;
  }

  return cloneValue(nextValue);
}

export function convertImmerPatchesToCodexConversationStateUpdates(
  patches: readonly Patch[],
): CodexConversationStateUpdate[] {
  return patches.map(toCodexConversationStateUpdate);
}

export function buildCodexConversationStateUpdates(
  previous: CodexConversationSnapshot,
  next: CodexConversationSnapshot,
): CodexConversationStateUpdate[] {
  const [, patches] = produceWithPatches(
    previous as unknown as Record<string, unknown>,
    (draft) => {
      const reconciledRoot = reconcileDraftValue(draft, next as unknown as Record<string, unknown>);
      if (reconciledRoot !== KEEP_DRAFT_VALUE) {
        return reconciledRoot as Record<string, unknown>;
      }
      return undefined;
    },
  );

  return convertImmerPatchesToCodexConversationStateUpdates(patches);
}

export function applyCodexConversationStateUpdates(
  conversation: CodexConversationSnapshot,
  patches: readonly CodexConversationStateUpdate[],
): CodexConversationSnapshot {
  return applyPatches(conversation, patches.map(toImmerPatch));
}
