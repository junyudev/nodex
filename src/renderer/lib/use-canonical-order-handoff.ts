import { useCallback, useState } from "react";

interface PendingCanonicalOrder {
  readonly operationId: symbol;
  readonly previousIds: readonly string[];
  readonly nextIds: readonly string[];
  readonly phase: "submitting" | "acknowledged";
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameUniqueStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== left.length) return false;
  return right.every((value) => leftSet.has(value));
}

function resolveDisplayedOrder(
  canonicalIds: readonly string[],
  pending: PendingCanonicalOrder | null,
): readonly string[] {
  if (!pending) return canonicalIds;
  if (!sameUniqueStringSet(canonicalIds, pending.nextIds)) return canonicalIds;
  if (!sameStringOrder(canonicalIds, pending.previousIds)) return canonicalIds;
  return pending.nextIds;
}

/**
 * Keeps a local order overlay until the canonical props rendered by React have
 * changed. A fulfilled persistence Promise is only an acknowledgement; an
 * external-store cache write may notify its React observers in a later batch.
 */
export function useCanonicalOrderHandoff({
  canonicalIds,
  reportError,
}: {
  canonicalIds: readonly string[];
  reportError: (error: unknown) => void;
}): {
  displayedIds: readonly string[];
  submit: (nextIds: readonly string[], request: () => Promise<unknown> | unknown) => void;
} {
  const [pending, setPending] = useState<PendingCanonicalOrder | null>(null);
  const displayedIds = resolveDisplayedOrder(canonicalIds, pending);

  if (pending?.phase === "acknowledged" && !sameStringOrder(canonicalIds, pending.previousIds)) {
    setPending(null);
  }

  const submit = useCallback(
    (nextIds: readonly string[], request: () => Promise<unknown> | unknown) => {
      const operation: PendingCanonicalOrder = {
        operationId: Symbol("canonical-order-handoff"),
        previousIds: [...displayedIds],
        nextIds: [...nextIds],
        phase: "submitting",
      };
      setPending(operation);

      void Promise.resolve()
        .then(request)
        .then(() => {
          setPending((current) =>
            current?.operationId === operation.operationId
              ? { ...current, phase: "acknowledged" }
              : current,
          );
        })
        .catch((error: unknown) => {
          setPending((current) =>
            current?.operationId === operation.operationId ? null : current,
          );
          reportError(error);
        });
    },
    [displayedIds, reportError],
  );

  return { displayedIds, submit };
}
