import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  readManagedWorktreeAvailability,
  restoreManagedWorktree,
} from "@/lib/managed-worktree-runtime";
import type { ManagedWorktreeAvailability } from "@/lib/types";

export const managedWorktreeAvailabilityQueryKey = (threadId: string) =>
  ["managed-worktree-availability", threadId] as const;

export function useManagedWorktreeAvailability(threadId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: managedWorktreeAvailabilityQueryKey(threadId ?? ""),
    queryFn: async () => await readManagedWorktreeAvailability(threadId ?? ""),
    enabled: enabled && Boolean(threadId),
    staleTime: 0,
    retry: false,
  });
}

export function ManagedWorktreeRestoreBanner({
  availability,
  restoring = false,
  onRestore,
  onRetry,
}: {
  readonly availability: ManagedWorktreeAvailability;
  readonly restoring?: boolean;
  readonly onRestore?: () => void;
  readonly onRetry?: () => void;
}) {
  if (availability.state === "not-managed" || availability.state === "available") return null;

  const content =
    availability.state === "restorable"
      ? {
          title: "Worktree cleaned up",
          body: "This chat's worktree was removed to save disk space",
          action: "Restore worktree",
          onAction: onRestore,
        }
      : availability.state === "gone"
        ? {
            title: "Current working directory missing",
            body: "This chat's working directory no longer exists",
            action: null,
            onAction: undefined,
          }
        : {
            title: "Couldn’t check worktree status",
            body: "Retry to verify this chat's working directory",
            action: "Retry",
            onAction: onRetry,
          };

  return (
    <div
      className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-xl border border-token-border-subtle bg-token-bg-secondary px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-semibold text-token-foreground">
          {content.title}
        </span>
        <span className="hidden min-w-0 truncate text-token-description-foreground sm:inline">
          {content.body}
        </span>
      </span>
      {content.action && content.onAction ? (
        <NodexButton
          size="sm"
          variant={availability.state === "restorable" ? "primary" : "secondary"}
          disabled={restoring}
          aria-busy={restoring}
          onClick={content.onAction}
        >
          {content.action}
        </NodexButton>
      ) : null}
    </div>
  );
}

export function ManagedWorktreeRestoreBannerContainer({ threadId }: { readonly threadId: string }) {
  const queryClient = useQueryClient();
  const availability = useManagedWorktreeAvailability(threadId, true);
  const [restoring, setRestoring] = useState(false);
  const resolvedAvailability: ManagedWorktreeAvailability = availability.isError
    ? {
        state: "unavailable",
        reason: "inspection-failed",
        message:
          availability.error instanceof Error
            ? availability.error.message
            : "Could not inspect the managed worktree",
      }
    : (availability.data ?? { state: "available" });

  return (
    <ManagedWorktreeRestoreBanner
      availability={resolvedAvailability}
      restoring={restoring}
      onRetry={() => void availability.refetch()}
      onRestore={() => {
        if (restoring) return;
        setRestoring(true);
        void restoreManagedWorktree(threadId)
          .then((result) => {
            queryClient.setQueryData(
              managedWorktreeAvailabilityQueryKey(threadId),
              result.availability,
            );
            toast.success("Worktree restored");
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : "Unknown error";
            toast.danger(`Failed to restore worktree: ${message}`);
            await availability.refetch();
          })
          .finally(() => setRestoring(false));
      }}
    />
  );
}
