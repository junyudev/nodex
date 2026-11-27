import { cn } from "@/lib/utils";

/**
 * Props that render a subtree in the dark appearance whatever the window's: palette roles,
 * light-dark() values and the `dark:` variant all resolve dark inside it. A dark surface, such as
 * a tooltip in light mode, wraps its content in this scope so the content never keeps light-mode
 * ink on the dark fill.
 */
export function darkAppearanceScope(className?: string) {
  return { "data-theme": "dark", className: cn("dark", className) } as const;
}
