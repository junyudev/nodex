import { useIntl } from "@/lib/i18n";
import {
  NodexDialog as Dialog,
  NodexDialogAction as DialogAction,
  NodexDialogBody as DialogBody,
  NodexDialogContent as DialogContent,
  NodexDialogDescription as DialogDescription,
  NodexDialogFooter as DialogFooter,
  NodexDialogFrame as DialogFrame,
  NodexDialogHeader as DialogHeader,
  NodexDialogTitle as DialogTitle,
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
  const intl = useIntl();

  const options = resolveOccurrenceScopeOptions(thisAndFutureEquivalentToAll, intl);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogFrame>
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({
                id: "board.occurrenceScopeDialog.title",
                defaultMessage: "Apply recurring schedule change",
              })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage(
                {
                  id: "board.occurrenceScopeDialog.description",
                  defaultMessage:
                    "Choose how to apply the new time range for <page>{title}</page>.",
                },
                {
                  title:
                    title ||
                    intl.formatMessage({
                      id: "board.occurrenceScopeDialog.untitled",
                      defaultMessage: "this recurring page",
                    }),
                  page: (chunks) => (
                    <span className="font-medium wrap-break-word text-(--foreground)">
                      {chunks}
                    </span>
                  ),
                },
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="rounded-md border border-(--border) bg-(--card) p-3 text-sm">
              <p className="text-(--foreground-secondary)">
                {intl.formatMessage(
                  {
                    id: "board.occurrenceScopeDialog.from",
                    defaultMessage: "From: <time>{label}</time>",
                  },
                  {
                    label: fromLabel,
                    time: (chunks) => <span className="text-(--foreground)">{chunks}</span>,
                  },
                )}
              </p>
              <p className="mt-1 text-(--foreground-secondary)">
                {intl.formatMessage(
                  {
                    id: "board.occurrenceScopeDialog.to",
                    defaultMessage: "To: <time>{label}</time>",
                  },
                  {
                    label: toLabel,
                    time: (chunks) => <span className="text-(--foreground)">{chunks}</span>,
                  },
                )}
              </p>
            </div>
          </DialogBody>

          <DialogFooter className="flex-wrap">
            <DialogAction onClick={onCancel} disabled={busy}>
              {intl.formatMessage({
                id: "board.occurrenceScopeDialog.cancel",
                defaultMessage: "Cancel",
              })}
            </DialogAction>
            {options.map((option) => (
              <DialogAction
                key={option.scope}
                tone={option.isPrimary ? "primary" : "ghost"}
                onClick={() => void onSelect(option.scope)}
                disabled={busy}
              >
                {option.label}
              </DialogAction>
            ))}
          </DialogFooter>
        </DialogFrame>
      </DialogContent>
    </Dialog>
  );
}
