import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
  NodexDialogFooter,
  NodexDialogAction,
} from "@/components/ui/dialog";
import type { ModalCloseProps } from "@/lib/modal-registry";
export function BrowserAnnotationDiscardDialog({
  onClose,
  onDiscard,
}: ModalCloseProps & { onDiscard: () => void }) {
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="narrow">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Discard all annotations?</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction
              tone="danger"
              onClick={() => {
                onDiscard();
                onClose();
              }}
            >
              Discard
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
