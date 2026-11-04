export const COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-sm leading-[18px]";

export const COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME = `${COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME} aspect-square items-center justify-center !px-0`;

/** A composer's primary action, whichever it is. Its host dims it when the action is unavailable. */
export const COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME =
  "focus-visible:outline-background-composer-primary cursor-interaction flex h-token-button-composer aspect-square items-center justify-center rounded-full bg-composer-primary p-0.5 text-composer-primary transition-opacity focus-visible:outline-2";

export const COMPOSER_FOOTER_COMPACT_GHOST_BUTTON_CLASS_NAME =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer-sm px-1.5 py-0 text-sm leading-[18px] min-w-0";

export const COMPOSER_FOOTER_PLAN_ACCESSORY_BUTTON_CLASS_NAME = `${COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME} group flex items-center gap-1 text-token-text-link-foreground`;

export const COMPOSER_FOOTER_LABEL_CLASS_NAME = "_footerLabel_1u8sk_2 truncate";

export const COMPOSER_FOOTER_LABEL_NARROW_CLASS_NAME = `${COMPOSER_FOOTER_LABEL_CLASS_NAME} max-w-16`;

export const COMPOSER_FOOTER_LABEL_WIDE_CLASS_NAME = `${COMPOSER_FOOTER_LABEL_CLASS_NAME} max-w-24`;

export function ComposerFooterAccessoryDivider() {
  return (
    <div
      aria-hidden="true"
      data-composer-footer-accessory-divider="true"
      className="h-4 w-px bg-token-border/70"
    />
  );
}
