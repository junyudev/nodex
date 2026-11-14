import { XmarkMd20Glyph, Microphone20Glyph, ArrowRotateClockwise20Glyph } from "./outline-glyphs";
import type { JSX } from "react";
import { cn } from "@/lib/utils";

type DictationIconProps = JSX.IntrinsicElements["svg"];

export function DictationMicrophoneIcon({ className, ...props }: DictationIconProps) {
  return <Microphone20Glyph {...props} className={cn("icon-base shrink-0", className)} />;
}

export function DictationRetryIcon({ className, ...props }: DictationIconProps) {
  return <ArrowRotateClockwise20Glyph {...props} className={cn("shrink-0", className)} />;
}

export function DictationDismissIcon({ className, ...props }: DictationIconProps) {
  return <XmarkMd20Glyph width={21} height={21} {...props} className={cn("shrink-0", className)} />;
}
