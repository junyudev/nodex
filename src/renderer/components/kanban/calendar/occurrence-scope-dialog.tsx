import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OccurrenceEditScope } from "@/lib/types";
import { resolveOccurrenceScopeOptions } from "./occurrence-scope-options";

interface OccurrenceScopeDialogProps {
  open: boolean;
  title: string;
  fromLabel: string;
  toLabel: string;
  thisAndFutureEquivalentToAll: boolean;
  busy: boolean;
  onCancel: () => void;
  onSelect: (scope: OccurrenceEditScope) => void | Promise<void>;
}

export function OccurrenceScopeDialog({
  open,
  title,
  fromLabel,
  toLabel,
  thisAndFutureEquivalentToAll,
  busy,
  onCancel,
  onSelect,
}: OccurrenceScopeDialogProps) {
  const options = resolveOccurrenceScopeOptions(thisAndFutureEquivalentToAll);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <DialogContent className="max-w-130 gap-3 overflow-x-hidden" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Apply recurring schedule change</DialogTitle>
          <DialogDescription>
            Choose how to apply the new time range for
            {" "}
            <span className="font-medium wrap-break-word text-(--foreground)">{title || "this recurring card"}</span>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-(--border) bg-(--card) p-3 text-sm">
          <p className="text-(--foreground-secondary)">
            From:
            {" "}
            <span className="text-(--foreground)">{fromLabel}</span>
          </p>
          <p className="mt-1 text-(--foreground-secondary)">
            To:
            {" "}
            <span className="text-(--foreground)">{toLabel}</span>
          </p>
        </div>

        <DialogFooter className="gap-2 sm:items-start">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
            {options.map((option) => (
              <Button
                key={option.scope}
                type="button"
                variant={option.isPrimary ? "default" : "outline"}
                onClick={() => void onSelect(option.scope)}
                disabled={busy}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
