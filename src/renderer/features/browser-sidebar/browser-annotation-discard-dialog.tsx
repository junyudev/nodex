import { useIntl } from "@/lib/i18n";
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
  const intl = useIntl();
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
            <NodexDialogTitle>
              {intl.formatMessage({
                id: "browser.browserAnnotationDiscardDialog.title",
                defaultMessage: "Discard all annotations?",
              })}
            </NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>
              {intl.formatMessage({
                id: "browser.browserAnnotationDiscardDialog.cancel",
                defaultMessage: "Cancel",
              })}
            </NodexDialogAction>
            <NodexDialogAction
              tone="danger"
              onClick={() => {
                onDiscard();
                onClose();
              }}
            >
              {intl.formatMessage({
                id: "browser.browserAnnotationDiscardDialog.discard",
                defaultMessage: "Discard",
              })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
