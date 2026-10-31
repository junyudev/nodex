/** The same brief pulse for prompt navigation and addressed message links. */
export function highlightChatMessage(target: HTMLElement, reducedMotion: boolean): void {
  const pulse =
    target.querySelector<HTMLElement>(
      "[data-user-message-bubble='true'],[data-composer-attachment-pill='true']",
    ) ?? target;
  if (typeof pulse.animate !== "function") return;
  for (const animation of pulse.getAnimations?.() ?? []) animation.cancel();
  pulse.animate(
    [
      { backgroundColor: "color-mix(in srgb, var(--color-token-foreground) 14%, transparent)" },
      { backgroundColor: "color-mix(in srgb, var(--color-token-foreground) 5%, transparent)" },
    ],
    { duration: reducedMotion ? 0 : 1400, easing: "ease-out" },
  );
}
