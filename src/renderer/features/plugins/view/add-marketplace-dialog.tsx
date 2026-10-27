import { useState, type FormEvent } from "react";
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
import { openExternalUrl } from "@/lib/file-system-operations";
import { cn } from "@/lib/utils";
import { parseAddMarketplaceForm, type AddMarketplaceFormValues } from "../model/marketplace-form";
import type { MarketplaceAddParams } from "@nodex/codex-app-server-protocol/v2/MarketplaceAddParams";

const LEARN_MORE_URL = "https://developers.openai.com/codex/plugins/build";
const FIELD_LABEL_CLASS = "flex flex-col gap-1.5 text-sm text-token-description-foreground";
const FIELD_CLASS =
  "min-w-0 w-full rounded-md border border-(--color-border-primary-outline) bg-(--color-background-primary-soft) px-2.5 text-sm text-token-foreground outline-none placeholder:text-tertiary focus:border-(--color-ring) disabled:cursor-not-allowed disabled:bg-text/5 disabled:text-(--color-text-secondary) aria-invalid:border-(--color-text-danger) aria-invalid:ring-2 aria-invalid:ring-(--color-text-danger)/20";
const EMPTY_FORM: AddMarketplaceFormValues = { source: "", refName: "", sparsePaths: "" };

/** Adds a plugin marketplace from a GitHub repo, a Git URL, or a local folder. */
export function AddMarketplaceDialog({
  open,
  onOpenChange,
  onAddMarketplace,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves once added; a rejection's message is shown in the dialog. */
  readonly onAddMarketplace: (params: MarketplaceAddParams) => Promise<void>;
}) {
  const [values, setValues] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sourceError =
    submitted && values.source.trim().length === 0 ? "Enter a marketplace source" : null;

  const close = (next: boolean) => {
    if (submitting) return;
    if (!next) {
      setValues(EMPTY_FORM);
      setSubmitted(false);
      setSubmitError(null);
    }
    onOpenChange(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const params = parseAddMarketplaceForm(values);
    if (params == null || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onAddMarketplace(params);
      setSubmitting(false);
      setValues(EMPTY_FORM);
      setSubmitted(false);
      onOpenChange(false);
    } catch (error) {
      setSubmitting(false);
      setSubmitError(error instanceof Error ? error.message : "Failed to add marketplace");
    }
  };

  const field = (name: keyof AddMarketplaceFormValues) => ({
    value: values[name],
    disabled: submitting,
    onChange: (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [name]: event.target.value })),
  });

  return (
    <NodexDialog
      open={open}
      disablePointerDismissal={submitting}
      onOpenChange={(next, details) => {
        if (submitting) {
          details.cancel();
          return;
        }
        close(next);
      }}
    >
      <NodexDialogContent size="wide" showCloseButton={!submitting}>
        <NodexDialogForm onSubmit={(event) => void submit(event)}>
          <NodexDialogHeader>
            <NodexDialogTitle>Add plugin marketplace</NodexDialogTitle>
            <NodexDialogDescription>
              Add from a GitHub repo, Git URL, or local folder.{" "}
              <a
                href={LEARN_MORE_URL}
                className="cursor-interaction text-info underline-offset-2 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(LEARN_MORE_URL);
                }}
              >
                Learn more
              </a>
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody className="gap-3">
            <label className={FIELD_LABEL_CLASS} htmlFor="plugin-marketplace-source">
              Source
              <input
                id="plugin-marketplace-source"
                type="text"
                // The source is the only required field.
                autoFocus
                aria-invalid={sourceError != null}
                aria-describedby={
                  sourceError == null ? undefined : "plugin-marketplace-source-error"
                }
                placeholder="openai/plugins or git@github.com:org/repo.git"
                className={cn(FIELD_CLASS, "h-9")}
                {...field("source")}
              />
              {sourceError == null ? null : (
                <span id="plugin-marketplace-source-error" className="text-danger">
                  {sourceError}
                </span>
              )}
            </label>
            <label className={FIELD_LABEL_CLASS} htmlFor="plugin-marketplace-ref">
              Git ref
              <input
                id="plugin-marketplace-ref"
                type="text"
                placeholder="main"
                className={cn(FIELD_CLASS, "h-9")}
                {...field("refName")}
              />
            </label>
            <label className={FIELD_LABEL_CLASS} htmlFor="plugin-marketplace-sparse-paths">
              Sparse paths
              <textarea
                id="plugin-marketplace-sparse-paths"
                placeholder="plugins/codex"
                className={cn(FIELD_CLASS, "min-h-24 resize-y py-2")}
                {...field("sparsePaths")}
              />
            </label>
            {submitError == null ? null : (
              <div role="alert" className="text-sm text-danger">
                {submitError}
              </div>
            )}
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction disabled={submitting} onClick={() => close(false)}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              type="submit"
              disabled={values.source.trim().length === 0 || submitting}
              aria-busy={submitting || undefined}
            >
              Add marketplace
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
