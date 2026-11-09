import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  effectiveHoldQuery,
  executionHoldsQuery,
  setExecutionHold,
} from "@/lib/execution-holds-runtime";
import type { ComposerNotice } from "../../thread-stage-types";

/**
 * What a send from this Composer would run in. A chat that has not started has no Session in Core
 * yet; only its Space and Project can hold it.
 */
export type ComposerHoldTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "new_chat"; readonly projectId: string | null };

/** Sending never clears policy. A separate, named person action resumes exactly one scope. */
export function useComposerExecutionHold(target: ComposerHoldTarget | null) {
  const client = useQueryClient();
  const session = useQuery({
    ...effectiveHoldQuery({
      kind: "session",
      session_id: target?.kind === "session" ? target.sessionId : "",
    }),
    enabled: target?.kind === "session",
  });
  const all = useQuery({ ...executionHoldsQuery(), enabled: target?.kind === "new_chat" });
  const holds =
    target?.kind === "new_chat"
      ? all.data?.filter(
          (h) =>
            h.scope.kind === "space" ||
            (h.scope.kind === "project" && h.scope.project_id === target.projectId),
        )
      : session.data;
  const hold =
    holds?.find((h) => h.scope.kind === "space") ??
    holds?.find((h) => h.scope.kind === "project") ??
    holds?.[0];
  if (!hold) return { held: false, notice: null };
  const label =
    hold.scope.kind === "space"
      ? "Resume all Agent work"
      : hold.scope.kind === "project"
        ? "Resume Project"
        : "Resume to send";
  const notice: ComposerNotice = {
    key: "execution-hold",
    tone: "warning",
    title: "Work paused",
    actions: [
      {
        label,
        run: async () => {
          await setExecutionHold(hold.scope, false);
          await Promise.all([
            client.invalidateQueries({ queryKey: ["executionHolds"] }),
            client.invalidateQueries({ queryKey: ["effectiveExecutionHold"] }),
          ]);
        },
      },
    ],
  };
  return { held: true, notice };
}
