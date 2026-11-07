import { cva } from "class-variance-authority";

/**
 * Shared visual contract for compact, color-tinted atoms embedded in prose.
 *
 * This is intentionally a class resolver instead of a React wrapper: callers
 * retain the correct element semantics (`button` for editable atoms, `span`
 * for inert previews), while editor-owned markup can adopt the same CSS
 * utility at its adapter boundary in `globals.css`.
 */
export const inlineTintedChipVariants = cva("inline-tinted-chip", {
  variants: {
    tone: {
      accent: "inline-tinted-chip-accent",
      danger: "inline-tinted-chip-danger",
      neutral: "inline-tinted-chip-neutral",
      purple: "inline-tinted-chip-purple",
    },
    interactive: {
      true: "inline-tinted-chip-interactive",
      false: null,
    },
  },
  defaultVariants: {
    tone: "neutral",
    interactive: false,
  },
});

export const inlineTintedChipIconClassName = "inline-tinted-chip-icon";
export const inlineTintedChipLabelClassName = "inline-tinted-chip-label";
