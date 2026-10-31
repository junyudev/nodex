import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ThreadStageActions } from "../thread-stage-types";

type RecoveryCommands = Pick<
  ThreadStageActions,
  "onContinueAfterFailure" | "onCompactAndRetry" | "onManageFailedProvider"
>;

interface ContinuationState {
  readonly turnId: string;
  readonly pending: boolean;
  readonly error: string | null;
}

type RecoveryActions = RecoveryCommands & { readonly continuationState?: ContinuationState | null };

const ConversationRecoveryActionsContext = createContext<RecoveryActions>({});

/** Continuation feedback survives transcript folding and optimistic Turn replacement. */
export function ConversationRecoveryActionsProvider({
  onContinueAfterFailure,
  onCompactAndRetry,
  onManageFailedProvider,
  children,
}: RecoveryCommands & { children: ReactNode }) {
  const [continuationState, setContinuationState] = useState<ContinuationState | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const continueAfterFailure = useCallback(
    async (turnId: string, compact = false) => {
      const action = compact ? onCompactAndRetry : onContinueAfterFailure;
      if (!action) return;
      if (inFlight.current) return inFlight.current;
      setContinuationState({ turnId, pending: true, error: null });
      const operation = Promise.resolve()
        .then(() => action(turnId))
        .then(
          () => setContinuationState(null),
          (cause: unknown) =>
            setContinuationState({
              turnId,
              pending: false,
              error: cause instanceof Error ? cause.message : "Could not continue this reply.",
            }),
        )
        .finally(() => {
          inFlight.current = null;
        });
      inFlight.current = operation;
      return operation;
    },
    [onContinueAfterFailure, onCompactAndRetry],
  );
  const value = useMemo(
    () => ({
      onContinueAfterFailure: onContinueAfterFailure ? continueAfterFailure : undefined,
      onCompactAndRetry: onCompactAndRetry
        ? (turnId: string) => continueAfterFailure(turnId, true)
        : undefined,
      onManageFailedProvider,
      continuationState,
    }),
    [
      onContinueAfterFailure,
      onCompactAndRetry,
      continueAfterFailure,
      onManageFailedProvider,
      continuationState,
    ],
  );
  return (
    <ConversationRecoveryActionsContext value={value}>
      {children}
    </ConversationRecoveryActionsContext>
  );
}

export function useConversationRecoveryActions(): RecoveryActions {
  return useContext(ConversationRecoveryActionsContext);
}
