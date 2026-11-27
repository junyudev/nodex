import { memberIdentity } from "@/lib/member-identity";
import { cn } from "@/lib/utils";

/**
 * A Member's initials on their identity color, the same color their cursor uses in the Page, so
 * a person reads the same in margin cards, mention lists and presence.
 */
export function MemberAvatar({
  memberId,
  name,
  size,
  className,
}: {
  readonly memberId: string;
  readonly name: string;
  readonly size: 16 | 18 | 20 | 24;
  readonly className?: string;
}) {
  const identity = memberIdentity({ id: memberId, display_name: name });
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full leading-none font-medium text-white select-none",
        size <= 18 ? "text-[9px]" : "text-[10px]",
        className,
      )}
      style={{ width: size, height: size, backgroundColor: identity.color }}
    >
      {identity.initials || "?"}
    </span>
  );
}
