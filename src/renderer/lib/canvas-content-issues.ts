import {
  contentAccessIdentityKey,
  type ContentAccessIdentity,
} from "../../shared/content-access-context";
import type { CanvasSceneProvider } from "./canvas-scene-provider";
import {
  contentEditIssues,
  contentRecoveryIssueId,
  type ContentEditIssue,
} from "./content-edit-issues";

export async function exportCanvasRecovery(
  provider: Pick<CanvasSceneProvider, "exportRecovery">,
): Promise<void> {
  const data = await provider.exportRecovery();
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "nodex-canvas-recovery.json";
  link.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Observe the shared Canvas provider, so repeated surfaces do not create duplicate problems. */
export function observeCanvasContentIssues(
  provider: CanvasSceneProvider,
  scope: ContentAccessIdentity & {
    readonly documentId: string;
    readonly ownerBlockId: string;
    readonly storeEpoch: string;
    readonly generation: number;
  },
): () => void {
  let pendingSince: number | null = null;
  let failedMutationId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let issues: readonly ContentEditIssue[] = [];
  let signature = "";
  const listeners = new Set<() => void>();
  const update = () => {
    clearTimeout(timer);
    timer = undefined;
    const status = provider.getStatus();
    const now = Date.now();
    if (status.pendingMutationCount === 0) pendingSince = null;
    else pendingSince ??= now;
    const terminal = status.phase === "error" || status.phase === "reset-required";
    // Quarantining clears the provider’s in-flight slot; retain that exact draft identity.
    failedMutationId = terminal ? (status.inFlightMutationId ?? failedMutationId) : undefined;
    const mutationId = failedMutationId ?? status.inFlightMutationId;
    const delayed = pendingSince !== null && now - pendingSince >= 8000;
    const actionable =
      status.phase !== "closed" && status.phase !== "closing" && (terminal || delayed);
    const nextSignature = actionable
      ? JSON.stringify([status.phase, status.error, terminal, mutationId])
      : "";
    if (signature !== nextSignature) {
      signature = nextSignature;
      issues = actionable
        ? [
            {
              kind: "save",
              id: mutationId
                ? contentRecoveryIssueId(
                    scope,
                    scope.storeEpoch,
                    `canvas:${scope.documentId}:${mutationId}`,
                  )
                : `${contentAccessIdentityKey(scope)}\0${scope.storeEpoch}\0canvas:${scope.documentId}:${scope.generation}`,
              scope,
              location: {
                target: { kind: "canvas", canvasId: scope.ownerBlockId },
                label: "Canvas",
              },
              title: terminal ? "Canvas changes need attention" : "Still saving Canvas changes",
              detail:
                status.error?.message ??
                "The save is taking longer than expected. Its result is not yet confirmed.",
              actions: terminal
                ? [
                    {
                      kind: "review",
                      label: "Review edits",
                      scope,
                      documentId: scope.documentId,
                      prepare: provider.checkpointRecovery,
                      exportLocal: () => exportCanvasRecovery(provider),
                    },
                    {
                      kind: "run",
                      label: "Export recovery",
                      run: () => exportCanvasRecovery(provider),
                    },
                  ]
                : [{ kind: "run", label: "Retry save", run: () => provider.connect() }],
            },
          ]
        : [];
      listeners.forEach((listener) => listener());
    }
    if (
      !actionable &&
      pendingSince !== null &&
      status.phase !== "closed" &&
      status.phase !== "closing"
    )
      timer = setTimeout(update, 1000);
  };
  const unregister = contentEditIssues.register({
    getIssues: () => issues,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const unsubscribe = provider.subscribeStatus(update);
  update();
  return () => {
    clearTimeout(timer);
    unsubscribe();
    unregister();
  };
}
