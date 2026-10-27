/** Question actions keep their neutral boundary while their surface changes on hover. */
export const QUESTION_OUTLINE_ACTION_COLORS =
  "border border-default bg-(--color-background-primary-soft-alpha) text-token-foreground transition-none not-disabled:not-aria-disabled:hover:bg-(--color-background-primary-ghost-hover) data-[state=open]:bg-(--color-background-primary-ghost-hover)";

export const QUESTION_PRIMARY_ACTION_COLORS =
  "border border-default bg-primary-solid text-primary-solid transition-none not-disabled:not-aria-disabled:hover:bg-text/80 data-[state=open]:bg-text/80";

export const QUESTION_NAVIGATION_CONTROL =
  "flex shrink-0 items-center justify-center rounded-md border border-transparent p-1 text-token-description-foreground hover:bg-text/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40";
