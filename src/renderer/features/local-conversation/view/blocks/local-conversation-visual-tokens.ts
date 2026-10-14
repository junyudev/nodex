export const THREAD_VISUAL_TOKENS = {
  stackGap: "gap-[var(--conversation-tool-assistant-gap,8px)]",
  userBubble:
    "bg-user-message max-w-[77%] break-words rounded-2xl px-3 py-2 text-user-message [&_.contain-inline-size]:[contain:initial]",
  assistantBody: "text-size-chat leading-relaxed text-token-foreground",
  subtleLabel:
    "font-sans text-xs font-medium tracking-wide text-token-description-foreground uppercase",
  searchUnitMatched:
    "rounded-2xl bg-token-foreground/4 shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_8%,transparent)] transition-[background-color,box-shadow] duration-150",
  searchUnitActive:
    "bg-token-foreground/7 shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_18%,transparent)]",
  actionRow: "mt-3 flex h-5 items-center justify-start",
} as const;
