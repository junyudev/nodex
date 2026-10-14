import { cn } from "@/lib/utils";

interface OpenTabsIconProps {
  count: number;
  className?: string;
}

/** Decorative tab-count glyph; its control supplies the exact accessible count. */
export function OpenTabsIcon({ count, className }: OpenTabsIconProps) {
  return (
    <span aria-hidden="true" className="relative inline-flex shrink-0">
      <svg
        width={16}
        height={16}
        className={cn("icon-xs", className)}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
      >
        <path
          d="M13.1418 4.31665C13.1418 3.51124 12.4883 2.85864 11.6829 2.85864H4.31665C3.51124 2.85864 2.85864 3.51124 2.85864 4.31665V11.6829C2.85864 12.4883 3.51124 13.1418 4.31665 13.1418H11.6829C12.4883 13.1418 13.1418 12.4883 13.1418 11.6829V4.31665ZM14.1917 11.6829C14.1917 13.0682 13.0682 14.1917 11.6829 14.1917H4.31665C2.93134 14.1917 1.80786 13.0682 1.80786 11.6829V4.31665C1.80786 2.93134 2.93134 1.80786 4.31665 1.80786H11.6829C13.0682 1.80786 14.1917 2.93134 14.1917 4.31665V11.6829Z"
          fill="currentColor"
        />
      </svg>
      <span
        className={cn(
          "absolute inset-0 grid place-items-center font-semibold tabular-nums",
          count > 9 ? "text-[6px]" : "text-[8px]",
          "leading-none",
        )}
      >
        {count > 9 ? "9+" : count}
      </span>
    </span>
  );
}
