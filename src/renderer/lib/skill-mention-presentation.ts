export function humanizeComposerSkillName(name: string): string {
  const leafName = name.split(":").at(-1)?.trim() || name;
  if (!/[-_]/u.test(leafName)) return leafName;
  return leafName
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export const inlineSkillMentionClassName =
  "group/inline-mention cursor-interaction inline-flex max-w-full gap-[3px] px-0.5 align-bottom font-medium text-[color:var(--inline-mention-color)] [--inline-mention-color:var(--inline-mention-base-color)] [--inline-mention-base-color:color-mix(in_srgb,var(--color-token-text-link-foreground)_80%,var(--color-token-foreground)_20%)] hover:underline hover:decoration-current hover:decoration-dashed hover:decoration-[0.5px] hover:underline-offset-2 dark:[--inline-mention-color:var(--inline-mention-dark-base-color,var(--inline-mention-base-color))]";
