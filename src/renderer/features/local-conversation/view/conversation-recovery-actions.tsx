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
  "onContinueAfterFailure" | "onManageFailedProvider"
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
  onManageFailedProvider,
  children,
}: RecoveryCommands & { children: ReactNode }) {
  const [continuationState, setContinuationState] = useState<ContinuationState | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const continueAfterFailure = useCallback(
    async (turnId: string) => {
      if (!onContinueAfterFailure) return;
      if (inFlight.current) return inFlight.current;
      setContinuationState({ turnId, pending: true, error: null });
      const operation = Promise.resolve()
        .then(() => onContinueAfterFailure(turnId))
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
    [onContinueAfterFailure],
  );
  const value = useMemo(
    () => ({
      onContinueAfterFailure: onContinueAfterFailure ? continueAfterFailure : undefined,
      onManageFailedProvider,
      continuationState,
    }),
    [onContinueAfterFailure, continueAfterFailure, onManageFailedProvider, continuationState],
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
