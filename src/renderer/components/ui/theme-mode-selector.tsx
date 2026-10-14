import { useId } from "react";
import type { ResolvedTheme, ThemePreference } from "@/lib/theme-preferences";
import { NodexTooltip } from "./tooltip";
import { cn } from "@/lib/utils";

const MODES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function AppearancePreview({ variant }: { variant: ResolvedTheme }) {
  const dark = variant === "dark";
  return (
    <svg className="block size-full" viewBox="0 0 80 60" preserveAspectRatio="none" fill="none">
      <path fill={dark ? "#181818" : "#ffffff"} d="M0 0h80v60H0z" />
      <path fill={dark ? "#222222" : "#f3f3f3"} d="M0 0h23v60H0z" />
      <path
        stroke={dark ? "#757575" : "#c4c4c4"}
        strokeLinecap="round"
        d="M5 12h12M5 19h10M5 26h12M30 14h34M30 19h26M30 27h36M30 32h31"
      />
      <rect x="29" y="44" width="43" height="10" rx="3" fill={dark ? "#303030" : "#ededed"} />
      <circle cx="66" cy="49" r="2" fill={dark ? "#dedede" : "#797979"} />
    </svg>
  );
}

export function NodexThemeModeSelector({
  value,
  onValueChange,
}: {
  value: ThemePreference;
  onValueChange: (value: ThemePreference) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label="Mode" className="grid w-68 max-w-full grid-cols-3 gap-4">
      {MODES.map((mode) => (
        <NodexTooltip key={mode.value} tooltipContent={mode.label}>
          <label className="group flex min-w-0 cursor-interaction flex-col items-center gap-1.5 text-center">
            <input
              type="radio"
              name={name}
              aria-label={mode.label}
              className="peer sr-only"
              checked={value === mode.value}
              onChange={() => onValueChange(mode.value)}
            />
            <span
              aria-hidden="true"
              className="relative isolate block aspect-4/3 w-full overflow-hidden rounded-lg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring"
            >
              {mode.value === "system" ? (
                <span className="grid size-full grid-cols-2">
                  <AppearancePreview variant="light" />
                  <AppearancePreview variant="dark" />
                </span>
              ) : (
                <AppearancePreview variant={mode.value} />
              )}
              <span
                className={cn(
                  "absolute inset-0 rounded-lg border-2",
                  value === mode.value ? "border-ring" : "border-default group-hover:border-strong",
                )}
              />
            </span>
          </label>
        </NodexTooltip>
      ))}
    </div>
  );
}
