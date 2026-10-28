import { cn } from "@/lib/utils";
import type { NativeContextMenuIconKey } from "../../../../shared/native-context-menu";
import { getNativeContextMenuIconSvg } from "../../../../shared/session-context-menu-icons";

/**
 * A native menu item's icon, drawn from the same static glyph in page menus that stand in for
 * native menus, so both show identical icons in the current text color.
 */
export function NativeMenuIcon({
  iconKey,
  className,
}: {
  readonly iconKey: NativeContextMenuIconKey;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-native-menu-icon={iconKey}
      className={cn("icon-xs inline-flex shrink-0 [&>svg]:size-full", className)}
      dangerouslySetInnerHTML={{ __html: getNativeContextMenuIconSvg(iconKey) }}
    />
  );
}
