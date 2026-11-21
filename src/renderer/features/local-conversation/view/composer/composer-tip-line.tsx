import { useState } from "react";
import { useIntl } from "@/lib/i18n";
import { XmarkMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { toastFailure } from "@/lib/failure-toast";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import type { ComposerTip } from "../../thread-stage-types";

/**
 * A tip, said the way a margin note is: one centered sentence above the composer, in the quiet
 * text color, with no surface of its own. The only color is its small badge, the thing to try is
 * a word in the sentence rather than a button, and the way to put it away waits for the pointer.
 * A notice is a tab on the composer because it holds the composer; a tip holds nothing, so it
 * touches nothing.
 */
export function ComposerTipLine({ tip }: { readonly tip: ComposerTip }) {
  const intl = useIntl();
  const [pending, setPending] = useState(false);
  const { action } = tip;
  const run = () => {
    if (!action) return;
    setPending(true);
    void runWithCleanup(async () => void (await action.run()), {
      onError: (cause) => toastFailure(tip.text, cause),
      cleanup: () => setPending(false),
    });
  };
  return (
    <aside
      role="status"
      aria-live="polite"
      data-composer-tip={tip.key}
      className="flex w-full animate-in justify-center pb-1.5 duration-300 ease-[cubic-bezier(.23,1,.32,1)] fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
    >
      {/* The page's own color behind the words keeps them clear of what scrolls beneath. */}
      <div className="group relative flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-2xl bg-token-main-surface-primary px-7 py-1 text-size-chat-sm leading-5 text-token-text-secondary select-none">
        <span className="flex min-h-5 shrink-0 items-center rounded-full bg-[color-mix(in_srgb,var(--color-text-info)_12%,transparent)] px-2 text-xs leading-none font-medium text-info">
          {intl.formatMessage({ id: "tips.badge", defaultMessage: "Tip" })}
        </span>
        <span className="min-w-0 text-center">{tip.text}</span>
        {action ? (
          <button
            type="button"
            disabled={pending}
            aria-busy={pending || undefined}
            className="shrink-0 cursor-interaction rounded-sm underline decoration-dotted underline-offset-4 hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-token-focus-border disabled:cursor-default disabled:opacity-60"
            onClick={run}
          >
            {pending ? (action.pendingLabel ?? action.label) : action.label}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "tips.dismiss", defaultMessage: "Dismiss tip" })}
          className="pointer-events-none absolute top-1/2 right-0.5 flex size-5 -translate-y-1/2 cursor-interaction items-center justify-center rounded-full opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-token-foreground/[0.07] hover:text-token-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-token-focus-border"
          onClick={tip.dismiss}
        >
          <XmarkMdIcon className="icon-2xs" />
        </button>
      </div>
    </aside>
  );
}
