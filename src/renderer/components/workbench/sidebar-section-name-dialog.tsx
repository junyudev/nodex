import { FormattedMessage, useIntl, getIntl, type MessageDescriptor } from "@/lib/i18n";
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
import { toast } from "@/components/ui/toast";

export interface SidebarSectionNameDialogProps {
  readonly initialValue?: string;
  readonly title: string | MessageDescriptor;
  readonly description: string | MessageDescriptor;
  readonly onClose: () => void;
  readonly onSave: (name: string) => void | Promise<void>;
  readonly allowEmpty?: boolean;
}

export function SidebarSectionNameDialog({
  initialValue = "",
  title,
  description,
  onClose,
  onSave,
  allowEmpty = false,
}: SidebarSectionNameDialogProps) {
  const intl = useIntl();
  const [name, setName] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const normalized = name.trim();

  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent size="narrow">
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            if ((!normalized && !allowEmpty) || saving) return;
            setSaving(true);
            void Promise.resolve(onSave(normalized || "New section"))
              .then(onClose)
              .catch((error: unknown) => {
                toast.danger(
                  error instanceof Error
                    ? error.message
                    : getIntl().formatMessage({
                        id: "workbench.sidebarSectionNameDialog.saveFailed",
                        defaultMessage: "Couldn’t save section",
                      }),
                );
              })
              .finally(() => setSaving(false));
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>
              {typeof title === "string" ? title : intl.formatMessage(title)}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {typeof description === "string" ? description : intl.formatMessage(description)}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <input
              autoFocus
              aria-label={intl.formatMessage({
                id: "workbench.sidebarSectionNameDialog.name",
                defaultMessage: "Section name",
              })}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              className="w-full rounded-xl border border-token-border bg-token-main-surface-primary px-3 py-2 text-base text-token-input-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
              placeholder={intl.formatMessage({
                id: "workbench.sidebarSectionNameDialog.name",
                defaultMessage: "Section name",
              })}
            />
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>
              <FormattedMessage
                id="workbench.sidebarSectionNameDialog.cancel"
                defaultMessage="Cancel"
              />
            </NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              type="submit"
              disabled={(!normalized && !allowEmpty) || saving}
            >
              {saving
                ? intl.formatMessage({
                    id: "workbench.sidebarSectionNameDialog.saving",
                    defaultMessage: "Saving…",
                  })
                : intl.formatMessage({
                    id: "workbench.sidebarSectionNameDialog.save",
                    defaultMessage: "Save",
                  })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
