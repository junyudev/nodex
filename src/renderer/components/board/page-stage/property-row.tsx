import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

const PROPERTY_ROW_GRID_CLASS_NAME = "grid min-h-7.5 grid-cols-[8.5rem_minmax(0,1fr)] items-start";

/** The one label | value grammar shared by Source Properties and Page capabilities. */
export function PageStagePropertyRow({
  icon,
  label,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div {...rowProps} className={cn(PROPERTY_ROW_GRID_CLASS_NAME, className)}>
      <div className="flex min-h-7.5 min-w-0 items-center gap-1.5 pl-1">
        <span className="flex w-5 shrink-0 items-center justify-center text-(--foreground-tertiary) [&_svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 truncate text-sm/5 text-(--foreground-secondary)">{label}</span>
      </div>
      <div className="flex min-h-7.5 min-w-0 items-center px-2">{children}</div>
    </div>
  );
}
