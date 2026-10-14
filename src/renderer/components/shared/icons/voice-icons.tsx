import type { JSX } from "react";
import { cn } from "@/lib/utils";

type VoiceIconProps = JSX.IntrinsicElements["svg"];

export function VoiceOutputIcon({
  className,
  muted,
  ...props
}: VoiceIconProps & { readonly muted: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      className={cn("icon-xs shrink-0", className)}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="m4 8 3 0 4-4v12l-4-4H4V8Z" />
      {muted ? <path d="m14 7 4 6m0-6-4 6" /> : <path d="M14 6c3 2 3 6 0 8" />}
    </svg>
  );
}

export function VoiceCallIcon({ className, ...props }: VoiceIconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={cn("icon-xs shrink-0", className)}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4" />
    </svg>
  );
}
