import { useRef, useState } from "react";
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

export interface RenameChatDialogProps {
  initialValue: string;
  requireNonEmpty?: boolean;
  onClose: () => void;
  onSave: (title: string) => void;
}

function RenameChatDialogContent({
  initialValue,
  requireNonEmpty = false,
  onClose,
  onSave,
}: RenameChatDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(initialValue);
  const saveDisabled = requireNonEmpty && title.trim().length === 0;

  const focusAndSelectInput = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  };
  const updateTitleFromInput = (value: string) => {
    setTitle(value);
  };

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent
        size="narrow"
        initialFocus={() => {
          window.requestAnimationFrame(focusAndSelectInput);
          return inputRef.current;
        }}
      >
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            if (saveDisabled) return;
            onSave(title);
            onClose();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>Rename chat</NodexDialogTitle>
            <NodexDialogDescription>Keep it short and recognizable</NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <input
              ref={inputRef}
              aria-label="Chat title"
              placeholder="Add a title…"
              className="w-full rounded-xl border border-token-border bg-token-main-surface-primary px-3 py-2 text-base text-token-input-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
              value={title}
              onChange={(event) => updateTitleFromInput(event.currentTarget.value)}
              onInput={(event) => updateTitleFromInput(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={saveDisabled}>
              Save
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function RenameChatDialog(props: RenameChatDialogProps) {
  return (
    <RenameChatDialogContent
      key={`${props.initialValue}:${String(props.requireNonEmpty ?? false)}`}
      {...props}
    />
  );
}
