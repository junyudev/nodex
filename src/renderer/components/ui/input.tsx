import * as React from "react";
import { cn } from "@/lib/utils";

const nodexFormInputClassName = cn(
  "w-full min-w-0 rounded-md border border-token-input-border bg-token-input-background px-2.5 py-1.5 text-base text-token-input-foreground outline-none",
  "placeholder:text-token-input-placeholder-foreground",
  "focus:border-token-focus-border",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<"input">>(
  function Input({ className, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(nodexFormInputClassName, className)}
        {...props}
      />
    );
  },
);

/** Compact identity input with a persistent boundary for dense settings surfaces. */
export const NodexCompactFramedInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<"input">
>(function NodexCompactFramedInput({ className, ...props }, ref) {
  return (
    <Input
      ref={ref}
      className={cn(
        "h-7 rounded-[6px] border-token-border/70 bg-token-foreground/3 px-1.5 text-sm text-token-text-primary shadow-none",
        "hover:bg-token-foreground/3 focus:bg-token-foreground/3 focus:ring-0",
        className,
      )}
      {...props}
    />
  );
});
