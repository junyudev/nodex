import { useEffect, useMemo, useRef, useState } from "react";
import { Info, MessageSquareText, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ThreadSectionSendDialogState {
  sectionTitle: string;
  plainTextPreview: string;
  threadLabel: string;
  sendActionLabel: string;
  autoCreateSection: boolean;
}

interface ThreadSectionSendDialogProps {
  open: boolean;
  state: ThreadSectionSendDialogState | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { doNotAskAgain: boolean }) => void;
}

const textCountFormatter = new Intl.NumberFormat("en-US");

function summarizePlainTextPreview(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      preview: "No plain-text content.",
      summary: "0 characters",
    };
  }

  const lineCount = normalized.split("\n").length;
  return {
    preview: normalized,
    summary: `${textCountFormatter.format(normalized.length)} characters • ${textCountFormatter.format(lineCount)} ${lineCount === 1 ? "line" : "lines"}`,
  };
}

export function ThreadSectionSendDialog({
  open,
  state,
  onOpenChange,
  onConfirm,
}: ThreadSectionSendDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const [doNotAskAgain, setDoNotAskAgain] = useState(false);
  const preview = useMemo(
    () => summarizePlainTextPreview(state?.plainTextPreview ?? ""),
    [state?.plainTextPreview],
  );

  useEffect(() => {
    if (!open) return;
    setDoNotAskAgain(false);
  }, [open, state]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl gap-3 border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-[color-mix(in_srgb,var(--background)_94%,transparent)] p-4 shadow-2xl backdrop-blur-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmButtonRef.current?.focus();
        }}
      >
        <DialogHeader className="gap-1">
          <DialogTitle className="text-base font-medium">Send this thread section?</DialogTitle>
          <DialogDescription className="text-sm text-[color-mix(in_srgb,var(--foreground)_58%,transparent)]">
            Review the plain-text preview before sending it to Codex.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-3 py-2 shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--foreground)_9%,transparent)]">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-[color-mix(in_srgb,var(--foreground)_45%,transparent)]">
              <MessageSquareText className="size-3.5" />
              Section
            </div>
            <div className="mt-1 text-sm text-(--foreground)">{state?.sectionTitle ?? "Untitled section"}</div>
          </div>

          <div className="rounded-xl bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-3 py-2 shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--foreground)_9%,transparent)]">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-[color-mix(in_srgb,var(--foreground)_45%,transparent)]">
              <Workflow className="size-3.5" />
              Send target
            </div>
            <div className="mt-1 text-sm text-(--foreground)">{state?.sendActionLabel ?? "Start a new thread"}</div>
            <div className="mt-0.5 text-xs text-(--foreground-secondary)">{state?.threadLabel ?? "No existing thread"}</div>
          </div>
        </div>

        {state?.autoCreateSection && (
          <div className="flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--accent-blue)_22%,transparent)] bg-[color-mix(in_srgb,var(--accent-blue)_8%,transparent)] px-3 py-2 text-sm text-(--foreground)">
            <Info className="mt-0.5 size-4 shrink-0 text-(--accent-blue)" />
            <div>A new `threadSection` block will be inserted before the current block when you send.</div>
          </div>
        )}

        <div className="overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--foreground)_9%,transparent)]">
          <div className="flex items-center justify-between border-b border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-3 py-2">
            <div className="text-sm font-medium text-(--foreground)">Plain-text preview</div>
            <div className="text-xs text-(--foreground-secondary)">{preview.summary}</div>
          </div>
          <pre
            className={cn(
              "scrollbar-token max-h-120 overflow-auto whitespace-pre-wrap break-words px-3 py-3",
              "font-mono text-[13px] leading-5 text-(--foreground)",
            )}
          >
            {preview.preview}
          </pre>
        </div>

        <label className="flex items-center gap-2 text-sm text-(--foreground-secondary)">
          <input
            type="checkbox"
            checked={doNotAskAgain}
            onChange={(event) => setDoNotAskAgain(event.target.checked)}
            className="size-4 rounded border border-(--border) bg-(--background)"
          />
          <span>
            Do not ask again
            <span className="text-(--foreground-tertiary)"> (revertible in Settings)</span>
          </span>
        </label>

        <DialogFooter className="mt-1 flex-row items-center justify-end gap-2 sm:flex-row">
          <Button
            type="button"
            variant="ghost"
            className="rounded-full text-[color-mix(in_srgb,var(--foreground)_64%,transparent)]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            ref={confirmButtonRef}
            className="rounded-full bg-[var(--foreground)] text-[var(--background)] hover:bg-[color-mix(in_srgb,var(--foreground)_88%,transparent)]"
            onClick={() => onConfirm({ doNotAskAgain })}
          >
            Send section
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
