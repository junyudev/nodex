import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useState } from "react";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexCheckbox } from "@/components/ui/settings";
import type { ModalCloseProps } from "@/lib/modal-registry";

export function SideChatCloseDialog({
  onClose,
  onConfirm,
}: ModalCloseProps & {
  readonly onConfirm: (skipConfirmation: boolean) => void;
}) {
  const intl = useIntl();
  const [skipConfirmation, setSkipConfirmation] = useState(false);
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
            onConfirm(skipConfirmation);
            onClose();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>
              <FormattedMessage
                id="workbench.sideChatCloseDialog.title"
                defaultMessage="Close side chat?"
              />
            </NodexDialogTitle>
            <NodexDialogDescription>
              <FormattedMessage
                id="workbench.sideChatCloseDialog.description"
                defaultMessage="This side chat will be gone and can’t be recovered."
              />
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <label className="flex cursor-interaction items-center gap-2 text-sm">
              <NodexCheckbox
                checked={skipConfirmation}
                onCheckedChange={setSkipConfirmation}
                ariaLabel={intl.formatMessage({
                  id: "workbench.sideChatCloseDialog.skipConfirmation",
                  defaultMessage: "Don’t ask again",
                })}
              />
              <FormattedMessage
                id="workbench.sideChatCloseDialog.skipConfirmation"
                defaultMessage="Don’t ask again"
              />
            </label>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>
              <FormattedMessage id="workbench.sideChatCloseDialog.cancel" defaultMessage="Cancel" />
            </NodexDialogAction>
            <NodexDialogAction tone="danger" type="submit">
              <FormattedMessage
                id="workbench.sideChatCloseDialog.close"
                defaultMessage="Close side chat"
              />
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
