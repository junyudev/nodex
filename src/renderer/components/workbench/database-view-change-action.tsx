import type { ComponentProps } from "react";

import { ResetIcon } from "@/components/shared/icons";
import { UploadCloud } from "@/components/shared/icons/generic-icons";
import { NodexIconButton } from "@/components/ui/button";

export type DatabaseViewChangeActionKind = "reset" | "publish";

type DatabaseViewChangeActionProps = Omit<
  ComponentProps<typeof NodexIconButton>,
  "active" | "ariaLabel" | "icon" | "size" | "title"
> & {
  readonly kind: DatabaseViewChangeActionKind;
  readonly label: string;
  readonly tooltip: string;
};

/** Keeps every compact Database View reset/publish action visually and semantically aligned. */
export function DatabaseViewChangeAction({
  kind,
  label,
  tooltip,
  ...props
}: DatabaseViewChangeActionProps) {
  return (
    <NodexIconButton
      {...props}
      icon={kind === "reset" ? ResetIcon : UploadCloud}
      size="xs"
      active={kind === "publish"}
      ariaLabel={label}
      title={tooltip}
    />
  );
}
