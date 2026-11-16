import { useIntl } from "@/lib/i18n";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { CloseIcon } from "@/components/shared/icons";
import type {
  CodexCanonicalOptionPickerResponse,
  CodexOptionPickerRequest,
  CodexProtocolRequestId,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface CodexOptionPickerRequestCardProps {
  request: CodexOptionPickerRequest;
  showFreeform?: boolean;
  onRespond: (
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
  ) => Promise<void>;
}

function ComposerKeycap() {
  return (
    <kbd
      aria-hidden
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-md border-0 bg-current/10 px-1.5 py-0 font-sans text-xs leading-4 text-token-dropdown-background shadow-none"
    >
      ⏎
    </kbd>
  );
}

export function CodexOptionPickerRequestCard({
  request,
  showFreeform = true,
  onRespond,
}: CodexOptionPickerRequestCardProps) {
  const intl = useIntl();
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [freeformAnswer, setFreeformAnswer] = useState("");
  const trimmedFreeformAnswer = freeformAnswer.trim();
  const hasAnswer =
    selectedOptions.length > 0 || (showFreeform && trimmedFreeformAnswer.length > 0);

  const respond = async (action: "submit" | "skip") => {
    await onRespond(request.requestId, {
      action,
      selectedOptions,
      freeformAnswer:
        showFreeform && trimmedFreeformAnswer.length > 0 ? trimmedFreeformAnswer : null,
    });
  };

  const dismiss = async () => {
    await onRespond(request.requestId, {
      action: "dismiss",
      selectedOptions: [],
      freeformAnswer: null,
    });
  };

  const submit = async () => {
    if (!hasAnswer) return;
    await respond("submit");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    void dismiss();
  };

  const toggleOption = (label: string) => {
    setSelectedOptions((current) => {
      if (current.includes(label)) {
        return current.filter((candidate) => candidate !== label);
      }
      return request.allowMultiple ? [...current, label] : [label];
    });
  };

  return (
    <div
      className="flex flex-col overflow-hidden rounded-3xl bg-token-input-background text-token-foreground electron:elevation-prominent extension:border extension:border-token-border focus:outline-none"
      onKeyDown={handleKeyDown}
    >
      <form onSubmit={handleSubmit}>
        <div className="flex items-start justify-between pt-4 pr-3 pb-3 pl-4">
          <div className="text-sm font-medium">{request.question}</div>
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "conversation.codexOptionPickerRequestCard.dismiss",
              defaultMessage: "Dismiss",
            })}
            className="inline-flex h-token-button-composer aspect-square shrink-0 items-center justify-center rounded-lg border border-transparent text-token-text-tertiary focus:outline-none hover:bg-token-list-hover-background hover:text-token-foreground"
            onClick={() => void dismiss()}
          >
            <CloseIcon className="icon-2xs" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 px-3 pb-4">
          {request.options.map((option) => {
            const selected = selectedOptions.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role={request.allowMultiple ? "checkbox" : "radio"}
                aria-checked={selected}
                className={cn(
                  "cursor-interaction rounded-full border border-token-border bg-token-background px-3 py-1.5 text-sm leading-5 focus:outline-none hover:bg-token-foreground/5",
                  selected && "bg-token-foreground/10",
                )}
                onClick={() => toggleOption(option.label)}
              >
                {option.label}
              </button>
            );
          })}
          {showFreeform ? (
            <input
              className="min-w-[120px] rounded-full border border-token-border bg-token-background px-3 py-1.5 text-sm leading-5 text-token-foreground outline-none placeholder:text-token-description-foreground focus:border-token-foreground/30"
              aria-label={intl.formatMessage({
                id: "conversation.codexOptionPickerRequestCard.somethingElse",
                defaultMessage: "Something else",
              })}
              placeholder={intl.formatMessage({
                id: "conversation.codexOptionPickerRequestCard.somethingElse",
                defaultMessage: "Something else",
              })}
              value={freeformAnswer}
              onChange={(event) => setFreeformAnswer(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submit();
              }}
            />
          ) : null}
        </div>

        <div className="flex justify-end gap-2 px-3 pb-3">
          <button
            type="button"
            className="inline-flex h-token-button-composer items-center rounded-lg border border-transparent px-2 text-token-description-foreground focus:outline-none hover:bg-token-list-hover-background"
            onClick={() => void respond("skip")}
          >
            <span className="text-sm text-token-description-foreground">
              {request.skipLabel ??
                intl.formatMessage({
                  id: "conversation.codexOptionPickerRequestCard.skip",
                  defaultMessage: "Skip",
                })}
            </span>
          </button>
          <button
            type="submit"
            disabled={!hasAnswer}
            className="inline-flex h-token-button-composer items-center gap-1 rounded-lg border border-transparent bg-token-foreground px-2 text-token-dropdown-background focus:outline-none enabled:hover:bg-token-foreground/80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="text-sm font-medium">
              {request.submitLabel ??
                intl.formatMessage({
                  id: "conversation.codexOptionPickerRequestCard.submit",
                  defaultMessage: "Submit",
                })}
            </span>
            <ComposerKeycap />
          </button>
        </div>
      </form>
    </div>
  );
}
