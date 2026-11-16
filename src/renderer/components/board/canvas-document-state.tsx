import { useIntl } from "@/lib/i18n";
type CanvasDocumentStateProps =
  | {
      readonly status: "loading";
      readonly label: string;
    }
  | {
      readonly status: "error";
      readonly message: string;
      readonly retryLabel?: string;
      readonly onRetry: () => void;
    };

/** Quiet full-surface state used while the Canvas-owned Document opens or resyncs. */
export function CanvasDocumentState(props: CanvasDocumentStateProps) {
  const intl = useIntl();

  if (props.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-full flex-1 items-center justify-center text-sm text-(--foreground-secondary)"
      >
        {props.label}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 text-sm text-(--foreground-secondary)">
      <span role="alert">{props.message}</span>
      <button
        type="button"
        className="text-(--foreground) underline underline-offset-2"
        onClick={props.onRetry}
      >
        {props.retryLabel ??
          intl.formatMessage({ id: "board.canvasDocumentState.retry", defaultMessage: "Retry" })}
      </button>
    </div>
  );
}
