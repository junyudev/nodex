import { cn } from "@/lib/utils";

export function CardIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={cn("size-3.5 shrink-0", className)}>
      <path
        d="M2.75 4a1.25 1.25 0 0 1 1.25-1.25h8a1.25 1.25 0 0 1 1.25 1.25v8a1.25 1.25 0 0 1-1.25 1.25H4A1.25 1.25 0 0 1 2.75 12V4Z"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path d="M5 6h6M5 8h4.5M5 10h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}
