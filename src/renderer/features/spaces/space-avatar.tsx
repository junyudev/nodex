import { NodexLogoMarkIcon } from "@/components/shared/icons";
import { hueOf, identityGlyphColor, initialsOf } from "@/lib/identity-glyph";
import { cn } from "@/lib/utils";
import type { SpaceConnectionSummary } from "../../../shared/space-connection";

const BOX = {
  menu: "size-5 rounded-[6px] text-[10px]",
  rail: "size-7 rounded-[8px] text-xs",
  page: "size-9 rounded-[10px] text-sm",
} as const;
const MARK = { menu: "size-3.5", rail: "size-4.5", page: "size-5.5" } as const;

/** Spaces are rounded squares, so they never read as a person's round avatar.
 * The personal Space is the person's own Nodex and carries its mark. */
export function SpaceAvatar({
  space,
  size,
}: {
  space: Pick<SpaceConnectionSummary, "spaceId" | "kind" | "name">;
  size: keyof typeof BOX;
}) {
  if (space.kind === "personal") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center bg-token-foreground/8 text-token-foreground",
          BOX[size],
        )}
      >
        <NodexLogoMarkIcon monochrome className={MARK[size]} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center leading-none font-semibold text-white select-none",
        BOX[size],
      )}
      style={{ backgroundColor: identityGlyphColor(hueOf(space.spaceId)) }}
    >
      {initialsOf(space.name) || "S"}
    </span>
  );
}
