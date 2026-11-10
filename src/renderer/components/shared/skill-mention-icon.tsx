import type { ReactNode } from "react";
import { Sparkles } from "./icons/generic-icons";
import { cn } from "@/lib/utils";

function isSafeBrandColor(value: string | null): value is string {
  return Boolean(value && /^#[\da-f]{3,8}$/iu.test(value));
}

export function normalizeSafeIconUrl(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (/^data:image\/(?:png|gif|jpeg|webp|svg\+xml);base64,/iu.test(normalized)) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "app:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function ComposerCapabilityIcon({
  iconUrl,
  iconUrlDark,
  brandColor,
  fallback,
}: {
  readonly iconUrl: string | null;
  readonly iconUrlDark: string | null;
  readonly brandColor: string | null;
  readonly fallback: ReactNode;
}) {
  const safeIconUrl = normalizeSafeIconUrl(iconUrl);
  const safeDarkIconUrl = normalizeSafeIconUrl(iconUrlDark);
  const safeBrandColor = isSafeBrandColor(brandColor) ? brandColor : undefined;

  if (!safeIconUrl) {
    return (
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center text-token-foreground/80"
        style={safeBrandColor ? { color: safeBrandColor } : undefined}
      >
        {fallback}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="relative flex size-4 shrink-0 items-center justify-center overflow-hidden"
    >
      {safeDarkIconUrl && safeDarkIconUrl !== safeIconUrl ? (
        <img
          src={safeDarkIconUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="hidden size-4 object-contain dark:block"
        />
      ) : null}
      <img
        src={safeIconUrl}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        className={cn(
          "size-4 object-contain",
          safeDarkIconUrl && safeDarkIconUrl !== safeIconUrl ? "dark:hidden" : null,
        )}
      />
    </span>
  );
}

export function SkillMentionIcon({
  iconUrl = null,
  brandColor = null,
}: {
  readonly iconUrl?: string | null;
  readonly brandColor?: string | null;
}) {
  return (
    <ComposerCapabilityIcon
      iconUrl={iconUrl}
      iconUrlDark={null}
      brandColor={brandColor}
      fallback={<Sparkles className="size-3.5" />}
    />
  );
}
