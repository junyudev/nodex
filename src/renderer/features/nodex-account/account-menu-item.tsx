import type { ComponentProps, ReactNode } from "react";
import { NodexDropdownItem } from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";

/**
 * The account menu's leading column. It matches the Space avatars' 20px width, so every label
 * lines up; decorative icons rest at 75% and brighten with their row.
 */
export function AccountMenuLeading({
  icon,
  children,
  disabled = false,
}: {
  readonly icon?: ReactNode;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-5 items-center justify-center",
        icon && "opacity-75",
        icon && !disabled && "group-hover:opacity-100 group-focus:opacity-100",
      )}
    >
      {icon ?? children}
    </span>
  );
}

/** An account menu row whose icon or avatar sits in the shared leading column. */
export function AccountMenuItem({
  icon,
  leftSlot,
  disabled = false,
  ...props
}: ComponentProps<typeof NodexDropdownItem> & { icon?: ReactNode }) {
  return (
    <NodexDropdownItem
      {...props}
      disabled={disabled}
      leftSlot={
        <AccountMenuLeading icon={icon} disabled={disabled}>
          {leftSlot}
        </AccountMenuLeading>
      }
    />
  );
}
