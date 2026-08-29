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
  readonly title: string;
  readonly description: string;
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
                toast.danger(error instanceof Error ? error.message : "Couldn’t save section");
              })
              .finally(() => setSaving(false));
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>{title}</NodexDialogTitle>
            <NodexDialogDescription>{description}</NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <input
              autoFocus
              aria-label="Section name"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              className="w-full rounded-xl border border-token-border bg-token-main-surface-primary px-3 py-2 text-base text-token-input-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-token-focus"
              placeholder="Section name"
            />
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              type="submit"
              disabled={(!normalized && !allowEmpty) || saving}
            >
              {saving ? "Saving…" : "Save"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
