import { useIntl, type IntlShape } from "@/lib/i18n";
import { useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { AttachmentResourceIcon } from "../attachment-resource-icon";
import { canMaterializePasteResourceItems, type PasteResourceDialogState } from "./paste-resource";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogFrame,
  DialogHeader,
  DialogTitle,
} from "./paste-resource-dialog-deps";

interface PasteResourceDialogProps {
  open: boolean;
  state: PasteResourceDialogState | null;
  pending?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
  onChooseMode: (mode: "materialized" | "link") => void;
  onContinueInline?: () => void;
}

const TEXT_PREVIEW_CHAR_LIMIT = 100_000;

function getTextPreview(text: string, intl: IntlShape) {
  const normalizedText = text.replace(/\r\n/g, "\n").trim();
  if (!normalizedText) {
    return {
      preview: intl.formatMessage({
        id: "editor.pasteResourceDialog.pastedText",
        defaultMessage: "Pasted text",
      }),
      summary: intl.formatMessage({
        id: "editor.pasteResourceDialog.emptyText",
        defaultMessage: "Empty text",
      }),
    };
  }

  const preview =
    normalizedText.length > TEXT_PREVIEW_CHAR_LIMIT
      ? `${normalizedText.slice(0, TEXT_PREVIEW_CHAR_LIMIT).trimEnd()}...`
      : normalizedText;
  const lineCount = normalizedText.split("\n").length;

  return {
    preview,
    summary: intl.formatMessage(
      {
        id: "editor.pasteResourceDialog.textSummary",
        defaultMessage:
          "{characters, number} characters • {lines, plural, one {# line} other {# lines}}",
      },
      { characters: text.length, lines: lineCount },
    ),
  };
}

export function PasteResourceDialog({
  open,
  state,
  pending = false,
  error = null,
  onOpenChange,
  finalFocus,
  onChooseMode,
  onContinueInline,
}: PasteResourceDialogProps) {
  const intl = useIntl();
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const count = state?.items.length ?? 0;
  const canSaveCopy = canMaterializePasteResourceItems(state?.items ?? []);
  const isFolderOnly =
    (state?.items.length ?? 0) > 0 && (state?.items ?? []).every((item) => item.kind === "folder");
  const title = state?.textPayload
    ? intl.formatMessage({
        id: "editor.pasteResourceDialog.textTooLarge",
        defaultMessage: "This text is too large to paste",
      })
    : count === 1
      ? intl.formatMessage({
          id: "editor.pasteResourceDialog.addItem",
          defaultMessage: "Add this to the note?",
        })
      : intl.formatMessage(
          {
            id: "editor.pasteResourceDialog.addItems",
            defaultMessage: "Add {count} items to the note?",
          },
          { count },
        );
  const description = state?.textPayload
    ? intl.formatMessage({
        id: "editor.pasteResourceDialog.largeTextActions",
        defaultMessage: "Save a copy to assets and link to it, paste it anyway, or cancel.",
      })
    : isFolderOnly
      ? intl.formatMessage({
          id: "editor.pasteResourceDialog.folderActions",
          defaultMessage: "Keep a link to the original folder, or cancel.",
        })
      : !canSaveCopy
        ? intl.formatMessage({
            id: "editor.pasteResourceDialog.linkActions",
            defaultMessage: "Keep links to the original items, or cancel.",
          })
        : intl.formatMessage({
            id: "editor.pasteResourceDialog.copyOrLink",
            defaultMessage: "Save a copy or keep a link to the original location.",
          });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" initialFocus={primaryActionRef} finalFocus={finalFocus}>
        <DialogFrame>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <DialogBody className="gap-3">
            <div className="overflow-hidden rounded-xl bg-transparent ring-[0.5px] ring-inset ring-token-border">
              {(state?.items ?? []).map((item, index) => {
                const textPreview =
                  item.kind === "text" && state?.textPayload
                    ? getTextPreview(state.textPayload, intl)
                    : null;

                return (
                  <div
                    key={`${item.kind}:${item.name}:${item.path ?? index}`}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2.5",
                      index > 0 && "border-t-[0.5px] border-token-border",
                    )}
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center">
                      <AttachmentResourceIcon
                        kind={item.kind}
                        name={item.name}
                        mimeType={item.mimeType}
                        className="icon-sm"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      {textPreview ? (
                        <div className="scrollbar-token max-h-120 overflow-y-auto whitespace-pre-wrap break-words pr-1 font-mono text-[13px] leading-5 text-[var(--foreground)]">
                          {textPreview.preview}
                        </div>
                      ) : (
                        <div className="truncate text-sm font-medium text-[var(--foreground)]">
                          {item.name}
                        </div>
                      )}
                      <div className="truncate text-xs text-[color-mix(in_srgb,var(--foreground)_50%,transparent)]">
                        {textPreview?.summary ??
                          item.path ??
                          item.mimeType ??
                          intl.formatMessage({
                            id: "editor.pasteResourceDialog.pastedText",
                            defaultMessage: "Pasted text",
                          })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="rounded-lg bg-token-charts-red/10 px-3 py-2 text-sm text-token-charts-red">
                {error}
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            <DialogAction disabled={pending} onClick={() => onOpenChange(false)}>
              {intl.formatMessage({
                id: "editor.pasteResourceDialog.cancel",
                defaultMessage: "Cancel",
              })}
            </DialogAction>
            {state?.allowLink && (
              <DialogAction
                ref={!canSaveCopy ? primaryActionRef : undefined}
                disabled={pending}
                onClick={() => onChooseMode("link")}
              >
                {pending
                  ? intl.formatMessage({
                      id: "editor.pasteResourceDialog.working",
                      defaultMessage: "Working...",
                    })
                  : intl.formatMessage({
                      id: "editor.pasteResourceDialog.keepLink",
                      defaultMessage: "Keep as Link",
                    })}
              </DialogAction>
            )}
            {state?.textPayload && (
              <DialogAction disabled={pending} onClick={() => onContinueInline?.()}>
                {pending
                  ? intl.formatMessage({
                      id: "editor.pasteResourceDialog.working",
                      defaultMessage: "Working...",
                    })
                  : intl.formatMessage({
                      id: "editor.pasteResourceDialog.pasteAnyway",
                      defaultMessage: "Paste Anyway",
                    })}
              </DialogAction>
            )}
            {canSaveCopy && (
              <DialogAction
                tone="primary"
                ref={primaryActionRef}
                disabled={pending}
                onClick={() => onChooseMode("materialized")}
              >
                {pending
                  ? intl.formatMessage({
                      id: "editor.pasteResourceDialog.saving",
                      defaultMessage: "Saving...",
                    })
                  : intl.formatMessage({
                      id: "editor.pasteResourceDialog.saveCopy",
                      defaultMessage: "Save a Copy",
                    })}
              </DialogAction>
            )}
          </DialogFooter>
        </DialogFrame>
      </DialogContent>
    </Dialog>
  );
}
