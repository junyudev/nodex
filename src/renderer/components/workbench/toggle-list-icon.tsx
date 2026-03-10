import { cn } from "@/lib/utils";

/** Sidebar icon for the Toggle List view — collapsed carets (▶) beside list rows. */
export function ToggleListIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={cn("size-3.5 shrink-0", className)}>
      {/* Row 1: filled triangle + line */}
      <path d="M1.5 3l4 2-4 2z" fill="currentColor" />
      <path d="M8 5h13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* Row 2: filled triangle + line */}
      <path d="M1.5 10l4 2-4 2z" fill="currentColor" />
      <path d="M8 12h13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* Row 3: filled triangle + line */}
      <path d="M1.5 17l4 2-4 2z" fill="currentColor" />
      <path d="M8 19h13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
