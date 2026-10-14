import type { ReactNode } from "react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { registerContentSearchRevealOwner } from "../../../../content-search/content-search-reveal-owner";

function registerDisclosure(element: HTMLDetailsElement | null) {
  if (!element) return;
  return registerContentSearchRevealOwner(element, () => {
    element.open = true;
  });
}

/** Find reveals this disclosure through its mounted element rather than simulating a toggle. */
export function ConversationDirectiveDetails({
  summary,
  initiallyOpen,
  children,
}: {
  readonly summary: string | undefined;
  readonly initiallyOpen: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details
      ref={registerDisclosure}
      open={initiallyOpen || undefined}
      className="group my-3 rounded-xl border border-token-border bg-(--background-secondary)/15 px-4 py-3"
    >
      <summary className="text-size-chat flex cursor-interaction list-none items-center gap-1.5 font-medium marker:hidden [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}
