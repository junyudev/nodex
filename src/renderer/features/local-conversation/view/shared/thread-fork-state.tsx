import { createContext, useContext } from "react";

/** Submission belongs to the conversation owner, including forks confirmed in a dialog. */
export const ThreadForkSubmissionContext = createContext<string | null>(null);

export function useThreadForkSubmission(turnId: string | null) {
  const submittingTurnId = useContext(ThreadForkSubmissionContext);
  return {
    isForking: turnId !== null && submittingTurnId === turnId,
    forkDisabled: submittingTurnId !== null,
  };
}
