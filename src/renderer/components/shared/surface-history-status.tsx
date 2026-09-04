import { useCallback, useSyncExternalStore } from "react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import type { SurfaceHistoryControls } from "@/lib/surface-history/controls";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";

function ResetSurfaceHistoryDialog({
  controls,
  ownerId,
  generation,
  onClose,
}: {
  readonly controls: SurfaceHistoryControls;
  readonly ownerId: string;
  readonly generation: number;
  readonly onClose: () => void;
}) {
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="compact">
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            const current = controls.snapshot();
            if (current.ownerId === ownerId && current.generation === generation) controls.reset();
            onClose();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>Reset this surface’s history?</NodexDialogTitle>
            <NodexDialogDescription>
              Current content will not change. Earlier edits in this surface can no longer be undone
              or redone. Any submitted action will still finish being confirmed.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction type="submit" tone="danger">
              Reset history
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/** Recovery is local to the affected surface; the notice owns no command state. */
export function SurfaceHistoryStatus({ controls }: { readonly controls: SurfaceHistoryControls }) {
  const appHandle = useScopeHandle(appScope);
  const subscribe = useCallback((listener: () => void) => controls.subscribe(listener), [controls]);
  const read = useCallback(() => controls.snapshot(), [controls]);
  const snapshot = useSyncExternalStore(subscribe, read);
  const directions = [snapshot.undo, snapshot.redo];
  const capability =
    directions.find((item) => item.status === "waiting") ??
    directions.find((item) => item.status === "blocked");
  if (!capability) return null;
  return (
    <div
      className="flex min-w-0 items-center gap-1 border-b border-token-border/50 px-2 py-1 text-xs text-token-text-secondary"
      contentEditable={false}
    >
      <NodexTooltip tooltipContent={capability.reason ?? "History is not ready."}>
        <span role="status" className="min-w-0 flex-1 truncate">
          {capability.label ? `${capability.label} · ` : ""}
          {capability.reason}
        </span>
      </NodexTooltip>
      {capability.recoveryActions.includes("retry") ? (
        <NodexButton
          variant="ghost"
          size="xs"
          onClick={() => {
            controls.recover();
          }}
        >
          {capability.status === "waiting" ? "Check again" : "Retry"}
        </NodexButton>
      ) : null}
      {capability.recoveryActions.includes("reset") ? (
        <NodexButton
          variant="ghost"
          size="xs"
          onClick={() =>
            openModal(appHandle, ResetSurfaceHistoryDialog, {
              controls,
              ownerId: snapshot.ownerId,
              generation: snapshot.generation,
            })
          }
        >
          Reset history
        </NodexButton>
      ) : null}
    </div>
  );
}
