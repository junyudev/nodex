import * as React from "react";
import { cn } from "@/lib/utils";

const nodexFormInputClassName = cn(
  "w-full min-w-0 rounded-md border border-token-input-border bg-token-input-background px-2.5 py-1.5 text-base text-token-input-foreground outline-none",
  "placeholder:text-token-input-placeholder-foreground",
  "focus:border-token-focus-border",
  "aria-invalid:border-token-error-foreground aria-invalid:ring-2 aria-invalid:ring-token-error-foreground/20",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export const NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME =
  "rounded-lg border border-(--color-border) bg-(--color-background-neutral-soft-alpha)";

type FormFieldVariant = { variant?: "settings" };

export const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<"input"> & FormFieldVariant
>(function Input({ className, type, variant, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        nodexFormInputClassName,
        variant === "settings" && NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME,
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentPropsWithoutRef<"textarea"> & FormFieldVariant
>(function Textarea({ className, variant, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        nodexFormInputClassName,
        "resize-y",
        variant === "settings" && NODEX_SETTINGS_FIELD_CHROME_CLASS_NAME,
        className,
      )}
      {...props}
    />
  );
});

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
