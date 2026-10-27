import { useState, type CSSProperties } from "react";
import { PluginsIcon } from "@/components/shared/icons";

function brandStyle(brandColor: string | null): CSSProperties | undefined {
  if (brandColor == null) return undefined;
  return {
    "--inline-mention-base-color": brandColor,
    "--inline-mention-dark-base-color": `color-mix(in oklch, ${brandColor} 50%, var(--color-text) 50%)`,
  } as CSSProperties;
}

/**
 * A plugin mention inside running text: its 16px icon and its name in medium weight, tinted
 * with the plugin's brand color (softened toward the text color in dark appearance).
 */
export function PluginMentionChip({
  name,
  iconUrl,
  brandColor,
}: {
  readonly name: string;
  readonly iconUrl: string | null;
  readonly brandColor: string | null;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span
      data-brand-color={brandColor == null ? undefined : ""}
      className="inline font-medium whitespace-nowrap text-(--inline-mention-color) [--inline-mention-base-color:color-mix(in_srgb,var(--color-text-info)_80%,var(--color-text)_20%)] [--inline-mention-color:var(--inline-mention-base-color)] dark:[--inline-mention-color:var(--inline-mention-dark-base-color,var(--inline-mention-base-color))]"
      style={brandStyle(brandColor)}
    >
      <span className="relative box-content inline-flex h-[1em] w-4 translate-y-[calc(0.5ex-0.5cap)] items-center pe-[3px] align-middle">
        {iconUrl != null && failedUrl !== iconUrl ? (
          <img
            src={iconUrl}
            alt={name}
            draggable={false}
            referrerPolicy="no-referrer"
            className="size-4 rounded-2xs object-contain"
            onError={() => setFailedUrl(iconUrl)}
          />
        ) : (
          <PluginsIcon className="size-4" />
        )}
      </span>
      <span className="wrap-break-word whitespace-normal">{name}</span>
    </span>
  );
}
