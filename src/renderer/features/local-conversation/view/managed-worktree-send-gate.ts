import { getIntl, useIntl } from "@/lib/i18n";
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { toastFailure } from "@/lib/failure-toast";
import {
  readManagedWorktreeAvailability,
  restoreManagedWorktree,
} from "@/lib/managed-worktree-runtime";
import type { ManagedWorktreeAvailability } from "@/lib/types";
import type { ComposerSendGate } from "../thread-stage-types";

export const managedWorktreeAvailabilityQueryKey = (threadId: string) =>
  ["managed-worktree-availability", threadId] as const;

/** What Nodex knows about the worktree a chat runs in. */
export type ManagedWorktreeCheck =
  | { readonly status: "checking" }
  | { readonly status: "failed" }
  | { readonly status: "checked"; readonly availability: ManagedWorktreeAvailability };

export interface ManagedWorktreeFixes {
  readonly restore: () => Promise<void>;
  readonly checkAgain: () => Promise<void>;
}

/**
 * What a chat's worktree keeps it from sending, said beside the composer with the fix. A native
 * Thread resumes only into a checked worktree, so it waits for the check; Agent execution checks
 * its own location before running, so only a known loss holds an Agent chat.
 */
export function managedWorktreeSendGate(
  check: ManagedWorktreeCheck,
  requiresCheck: boolean,
  fixes: ManagedWorktreeFixes,
  intl = getIntl(),
): ComposerSendGate | null {
  const uncheckable: ComposerSendGate = {
    unsentReason: intl.formatMessage({
      id: "conversation.managedWorktreeSendGate.worktreeCheckFailedReason",
      defaultMessage: "Nodex couldn’t check this chat’s worktree",
    }),
    notice: {
      key: "worktree:unavailable",
      tone: "warning",
      title: intl.formatMessage({
        id: "conversation.managedWorktreeSendGate.worktreeCheckFailed",
        defaultMessage: "Couldn’t check worktree status",
      }),
      actions: [
        {
          label: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.retry",
            defaultMessage: "Retry",
          }),
          pendingLabel: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.checking",
            defaultMessage: "Checking…",
          }),
          run: fixes.checkAgain,
        },
      ],
    },
  };
  if (check.status === "checking") {
    return requiresCheck
      ? {
          unsentReason: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.checkingReason",
            defaultMessage: "Still checking this chat’s worktree",
          }),
          notice: null,
        }
      : null;
  }
  if (check.status === "failed") return requiresCheck ? uncheckable : null;
  switch (check.availability.state) {
    case "available":
    case "not-managed":
      return null;
    case "restorable":
      return {
        unsentReason: intl.formatMessage({
          id: "conversation.managedWorktreeSendGate.restoreToSend",
          defaultMessage: "Restore this chat’s worktree to send",
        }),
        notice: {
          key: "worktree:restorable",
          tone: "warning",
          title: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.cleanedUp",
            defaultMessage: "Worktree cleaned up",
          }),
          detail: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.removedToSaveSpace",
            defaultMessage: "Removed to save disk space",
          }),
          actions: [
            {
              label: intl.formatMessage({
                id: "conversation.managedWorktreeSendGate.restore",
                defaultMessage: "Restore worktree",
              }),
              pendingLabel: intl.formatMessage({
                id: "conversation.managedWorktreeSendGate.restoring",
                defaultMessage: "Restoring…",
              }),
              run: fixes.restore,
            },
          ],
        },
      };
    case "gone":
      return {
        unsentReason: intl.formatMessage({
          id: "conversation.managedWorktreeSendGate.missingReason",
          defaultMessage: "This chat’s working directory no longer exists",
        }),
        notice: {
          key: "worktree:gone",
          tone: "danger",
          title: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.missing",
            defaultMessage: "Working directory missing",
          }),
          detail: intl.formatMessage({
            id: "conversation.managedWorktreeSendGate.missingReason",
            defaultMessage: "This chat’s working directory no longer exists",
          }),
        },
      };
    case "unavailable":
      return uncheckable;
  }
}

/** Checks a managed-worktree chat's worktree and offers the fix when it holds sending. */
export function useManagedWorktreeSendGate(
  threadId: string | null,
  options: { readonly managed: boolean; readonly requiresCheck: boolean },
): ComposerSendGate | null {
  const intl = useIntl();
  const { managed, requiresCheck } = options;
  const queryClient = useQueryClient();
  const { data, isError, refetch } = useQuery({
    queryKey: managedWorktreeAvailabilityQueryKey(threadId ?? ""),
    queryFn: async () => await readManagedWorktreeAvailability(threadId ?? ""),
    enabled: managed && Boolean(threadId),
    staleTime: 0,
    retry: false,
  });
  return useMemo(() => {
    if (!managed || !threadId) return null;
    const check: ManagedWorktreeCheck = data
      ? { status: "checked", availability: data }
      : isError
        ? { status: "failed" }
        : { status: "checking" };
    return managedWorktreeSendGate(
      check,
      requiresCheck,
      {
        checkAgain: async () => {
          await refetch();
        },
        restore: async () => {
          try {
            const result = await restoreManagedWorktree(threadId);
            queryClient.setQueryData(
              managedWorktreeAvailabilityQueryKey(threadId),
              result.availability,
            );
            toast.success(
              getIntl().formatMessage({
                id: "conversation.managedWorktreeSendGate.restored",
                defaultMessage: "Worktree restored",
              }),
            );
          } catch (cause) {
            toastFailure(
              getIntl().formatMessage({
                id: "conversation.managedWorktreeSendGate.restoreFailed",
                defaultMessage: "Couldn’t restore the worktree",
              }),
              cause,
            );
            await refetch();
          }
        },
      },
      intl,
    );
  }, [managed, threadId, data, isError, requiresCheck, refetch, queryClient, intl]);
}
